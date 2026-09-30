// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IEdge,
    type IShape,
    type IWire,
    type Matrix4,
    Result,
    ShapeNode,
    sha256HexSync,
    type XYZ,
} from "@spicy3d/core";
import { shapeEntityIds } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";
import { isBodyTimelineNode, isBodyTrackingNode } from "./bodyTracking";
import { edgeListMatcher, matchEdgesAnchoredInEdges, matchEdgesInEdges } from "./edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "./edgeRef";
import type { FeatureContext } from "./feature";
import { collectEdges } from "./profileGeometry";
import { MATCH_TOLERANCE } from "./refGeometry";
import { combineIds } from "./trackedId";

/** Whole source-local edges, authored in traversal order. Shared by sweep and projection. */
export interface PathReference {
    readonly nodeId: string;
    readonly edges: readonly EdgeRef[];
}

export interface ResolvedPathReference {
    readonly anchor: EdgeRef;
    /** The complete span a reference claimed, ordered and oriented within the overall path. */
    readonly edges: readonly IEdge[];
    readonly seed: string;
    readonly stable: boolean;
    /** An authored token identifies a user pick; it is never native source history. */
    readonly provenance: "source" | "authored" | "geometric";
}

const AUTHORED_PATH_PREFIX = "path-ref:";

export interface ResolvedPath {
    readonly wire: IWire;
    readonly references: readonly ResolvedPathReference[];
    /** Native wire enumeration, with corresponding source identities; never enumeration-derived IDs. */
    readonly edges: readonly IEdge[];
    readonly edgeSeeds: readonly string[];
    readonly edgeSeedStable: readonly boolean[];
    readonly closed: boolean;
    dispose(): void;
}

interface SourcePath {
    shape: IShape;
    edges: IEdge[];
    ids?: readonly (string | undefined)[];
    world: Matrix4;
}
const timelineShapeTokens = new WeakMap<IShape, number>();
let nextTimelineToken = 0;

/** A consumed source contributes its entering state, never its final shape containing this host. */
export function pathReferenceDependencies(
    reference: Pick<PathReference, "nodeId">,
    document: IDocument,
    hostId: string,
): { refIds: string[]; key?: string } {
    if (reference.nodeId === hostId) return { refIds: [] };
    const node = document.modelManager.findNode((candidate) => candidate.id === reference.nodeId);
    if (isBodyTimelineNode(node)) {
        const index = node.consumingFeatureIndex(hostId);
        if (index !== undefined) {
            const shape = node.timelineStateAt(index)?.shape;
            let token = shape && timelineShapeTokens.get(shape);
            if (shape && token === undefined) {
                token = ++nextTimelineToken;
                timelineShapeTokens.set(shape, token);
            }
            const world = node instanceof ShapeNode ? node.worldTransform().toArray() : undefined;
            return {
                refIds: [],
                key: JSON.stringify([reference.nodeId, index, token, world, node.rollbackIndex]),
            };
        }
    }
    return { refIds: [reference.nodeId] };
}

interface Piece {
    edge: IEdge;
    seed: string;
    stable: boolean;
    reference: number;
}
interface OrientedPiece extends Piece {
    reversed: boolean;
    start: XYZ;
    end: XYZ;
}

/** Source geometry is matched before placement: moving a source never invalidates its local pick. */
function sourcePath(reference: PathReference, context: FeatureContext): Result<SourcePath> {
    if (reference.nodeId === context.host.id) {
        if (!context.input) return Result.err("Path reference requires a preceding host feature");
        return Result.ok({
            shape: context.input,
            edges: collectEdges(context.input),
            ids: context.tracking?.inputEdgeIds,
            world: context.host.worldTransform(),
        });
    }
    const node = context.document.modelManager.findNode((candidate) => candidate.id === reference.nodeId);
    if (!(node instanceof ShapeNode)) return Result.err("Path source node not found");
    if (isBodyTimelineNode(node)) {
        if (node.rollbackIndex !== undefined) return Result.err("Path source is rolled back for a session");
        const index = node.consumingFeatureIndex(context.host.id);
        if (index !== undefined) {
            const state = node.timelineStateAt(index);
            if (!state?.shape) return Result.err("Path source timeline state is unavailable");
            return Result.ok({
                shape: state.shape,
                edges: collectEdges(state.shape),
                ids: state.edgeIds,
                world: node.worldTransform(),
            });
        }
    }
    if (!node.shape.isOk) return Result.err("Path source geometry is unavailable");
    const edges = collectEdges(node.shape.value);
    let ids: readonly (string | undefined)[] | undefined;
    if (isBodyTrackingNode(node)) ids = edges.map((_, index) => node.edgeIdAt(index));
    else if (node instanceof SketchNode) {
        const entities = shapeEntityIds(node.data);
        if (entities.length === edges.length) ids = entities.map((id) => `sketch:${node.id}:path:ent${id}`);
    }
    return Result.ok({ shape: node.shape.value, edges, ids, world: node.worldTransform() });
}

/** Capture a picked edge in source coordinates and attach only real source tracking/entity identity. */
export function capturePathReference(node: ShapeNode, index: number): Result<EdgeRef> {
    if (!node.shape.isOk) return Result.err("Path source geometry is unavailable");
    const edges = collectEdges(node.shape.value);
    const edge = edges[index];
    if (!edge) return Result.err("Path edge not found");
    let id = isBodyTrackingNode(node) ? node.edgeIdAt(index) : undefined;
    if (node instanceof SketchNode) {
        const entity = shapeEntityIds(node.data)[index];
        if (entity !== undefined) id = `sketch:${node.id}:path:ent${entity}`;
    }
    const shared =
        id !== undefined &&
        (isBodyTrackingNode(node)
            ? node.edgeIndexesOfId(id).length > 1
            : node instanceof SketchNode &&
              shapeEntityIds(node.data).filter((entity) => `sketch:${node.id}:path:ent${entity}` === id)
                  .length > 1);
    try {
        return Result.ok(captureEdgeRef(edge, id ?? `${AUTHORED_PATH_PREFIX}${crypto.randomUUID()}`, shared));
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

/** Resolve each reference independently so split-span provenance is retained instead of flattened. */
export function resolvePathReferences(
    reference: PathReference,
    context: FeatureContext,
): Result<ResolvedPath> {
    if (!reference || typeof reference.nodeId !== "string") return Result.err("Invalid path reference");
    if (!Array.isArray(reference.edges) || reference.edges.length === 0)
        return Result.err("A path needs at least one whole-edge reference");
    if (reference.edges.length > 256) return Result.err("A path exceeds the 256-reference limit");
    const resolved = sourcePath(reference, context);
    if (!resolved.isOk) return Result.err(resolved.error);
    const source = resolved.value;
    if (source.edges.length > 8192) return Result.err("Path source exceeds the 8192-edge inspection limit");
    const inverse = context.host.worldTransform().invert();
    if (!inverse) return Result.err("Host placement is not invertible");
    const placement = inverse.multiply(source.world);
    const tracked =
        source.ids?.length === source.edges.length && source.ids.every((id) => id !== undefined)
            ? (source.ids as readonly string[])
            : undefined;
    const matchPlain = tracked ? undefined : edgeListMatcher(source.edges);
    const taken = new Set<number>();
    const anchors: EdgeRef[] = [];
    const groups: Piece[][] = [];
    for (const [referenceIndex, ref] of reference.edges.entries()) {
        const authored = ref.edgeId?.startsWith(AUTHORED_PATH_PREFIX) ? ref.edgeId : undefined;
        // Authored tokens cannot accidentally match a kernel ID, even if a source repeats the string.
        const matchingRef = authored ? { ...ref, edgeId: undefined } : ref;
        const match = tracked ? matchEdgesAnchoredInEdges(source.edges, [matchingRef], tracked) : undefined;
        if (match && !match.isOk) return Result.err(match.error);
        const plain = match ? undefined : matchPlain?.([matchingRef]);
        if (plain && !plain.isOk) return Result.err(plain.error);
        const indexes = match?.value.indexes ?? plain?.value ?? [];
        if (indexes.length === 0) return Result.err("Path edge not found after rebuild");
        if (indexes.some((index) => taken.has(index)))
            return Result.err("Path references overlap or repeat an edge");
        for (const index of indexes) taken.add(index);
        const matchedAnchor = match?.value.anchors[0] ?? captureEdgeRef(source.edges[indexes[0]]);
        const anchor = authored ? { ...matchedAnchor, edgeId: authored } : matchedAnchor;
        anchors.push(anchor);
        // Fingerprints are an explicit fallback for sources that expose no persistent topology identity.
        const seed =
            ref.edgeId ??
            anchor.edgeId ??
            `geometry:${sha256HexSync(new TextEncoder().encode(JSON.stringify(ref)))}`;
        groups.push(
            indexes.map((index) => ({
                edge: source.edges[index],
                seed: source.ids?.[index] ?? seed,
                stable: source.ids?.[index] !== undefined,
                reference: referenceIndex,
            })),
        );
    }
    const ordered = orderPath(groups);
    if (!ordered.isOk) return Result.err(ordered.error);
    const owned = new Set<IShape>();
    const dispose = () => {
        for (const shape of owned) shape.dispose();
        owned.clear();
    };
    try {
        const pieces = ordered.value.map((piece) => {
            // Own all wire inputs: reversing never mutates source geometry or its cached endpoint orientation.
            const edge = piece.edge.transformedMul(placement) as IEdge;
            owned.add(edge);
            if (piece.reversed) edge.reserve();
            return { ...piece, edge };
        });
        const wire = shapeFactory.wire(pieces.map((piece) => piece.edge));
        if (!wire.isOk) {
            dispose();
            return Result.err(wire.error);
        }
        owned.add(wire.value);
        const edges = collectEdges(wire.value);
        const edgeSeeds: string[] = [];
        const edgeSeedStable: boolean[] = [];
        const available = new Set(pieces);
        for (const edge of edges) {
            const matches = [...available].filter((piece) => edge.isSame(piece.edge));
            if (matches.length !== 1) {
                // Wire construction can weld vertices. Attribute the changed edge by its exact fingerprint.
                const matched = matchEdgesInEdges(
                    [...available].map((piece) => piece.edge),
                    [captureEdgeRef(edge)],
                );
                if (!matched.isOk || matched.value.length !== 1) {
                    dispose();
                    return Result.err("Wire construction lost an unambiguous source edge");
                }
                const piece = [...available][matched.value[0]];
                edgeSeeds.push(piece.seed);
                edgeSeedStable.push(piece.stable);
                available.delete(piece);
            } else {
                edgeSeeds.push(matches[0].seed);
                edgeSeedStable.push(matches[0].stable);
                available.delete(matches[0]);
            }
        }
        if (available.size || edges.length !== pieces.length) {
            dispose();
            return Result.err("Wire construction changed the selected path span");
        }
        return Result.ok({
            wire: wire.value,
            edges,
            edgeSeeds,
            edgeSeedStable,
            closed: ordered.value[0].start.isEqualTo(
                ordered.value[ordered.value.length - 1].end,
                MATCH_TOLERANCE,
            ),
            references: anchors.map((anchor, index) => ({
                anchor,
                edges: pieces.filter((piece) => piece.reference === index).map((piece) => piece.edge),
                seed: combineIds(groups[index].map((piece) => piece.seed)),
                stable: pieces.filter((piece) => piece.reference === index).every((piece) => piece.stable),
                provenance: pieces.filter((piece) => piece.reference === index).every((piece) => piece.stable)
                    ? "source"
                    : anchor.edgeId?.startsWith(AUTHORED_PATH_PREFIX)
                      ? "authored"
                      : "geometric",
            })),
            dispose,
        });
    } catch (error) {
        dispose();
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

function connected(a: XYZ, b: XYZ): boolean {
    return a.isEqualTo(b, MATCH_TOLERANCE);
}

/** Preserve authored group order, with a uniquely connected ordering inside each adopted split span. */
function orderPath(groups: readonly Piece[][]): Result<OrientedPiece[]> {
    let states: OrientedPiece[][] = [[]];
    for (const group of groups) {
        const next: OrientedPiece[][] = [];
        for (const state of states) {
            const endpoint = state.at(-1)?.end;
            const candidates = spanOrders(group, endpoint);
            for (const candidate of candidates) next.push([...state, ...candidate]);
        }
        if (next.length === 0) return Result.err("Path edges are disconnected or not in traversal order");
        if (next.length > 4) return Result.err("Path connectivity is ambiguous");
        states = next;
    }
    // A single open edge's native orientation is the intentional authoring direction. For a closed chain,
    // two equivalent reversals are also resolved by the first authored edge's native orientation.
    const forward = states.filter((state) => !state[0].reversed);
    const chosen = forward.length === 1 ? forward : states;
    if (chosen.length !== 1) return Result.err("Path connectivity is ambiguous");
    const result = chosen[0];
    const vertices: XYZ[] = [];
    const final = result[result.length - 1].end;
    for (const [index, piece] of result.entries()) {
        if (vertices.some((point) => connected(point, piece.start)))
            return Result.err("Path branches or revisits an interior vertex");
        vertices.push(piece.start);
        if (index < result.length - 1 && connected(piece.end, result[0].start))
            return Result.err("Path closes before its final edge");
    }
    if (!connected(final, result[0].start) && vertices.some((point) => connected(point, final)))
        return Result.err("Path revisits an interior vertex");
    return Result.ok(result);
}

/** Endpoint chaining is bounded; ambiguous branches are refused before factorial traversal can develop. */
function spanOrders(pieces: readonly Piece[], start?: XYZ): OrientedPiece[][] {
    if (pieces.length > 256) return [];
    const answers: OrientedPiece[][] = [];
    const walk = (remaining: readonly Piece[], ordered: OrientedPiece[], endpoint?: XYZ) => {
        if (answers.length > 2) return;
        if (!remaining.length) {
            answers.push(ordered);
            return;
        }
        const candidates = remaining.flatMap((piece) => {
            const [a, b] = piece.edge.ends();
            if (a.distanceTo(b) < MATCH_TOLERANCE && !piece.edge.isClosed()) return [];
            const orientations: OrientedPiece[] = [];
            if (!endpoint || connected(endpoint, a))
                orientations.push({ ...piece, reversed: false, start: a, end: b });
            if (!connected(a, b) && (!endpoint || connected(endpoint, b)))
                orientations.push({ ...piece, reversed: true, start: b, end: a });
            return orientations;
        });
        if (endpoint && candidates.length > 1) return;
        for (const candidate of candidates)
            walk(
                remaining.filter((piece) => piece.edge !== candidate.edge),
                [...ordered, candidate],
                candidate.end,
            );
    };
    walk(pieces, [], start);
    return answers;
}
