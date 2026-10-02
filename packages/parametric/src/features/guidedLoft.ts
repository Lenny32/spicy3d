// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IShape,
    Result,
    type ShapeType,
    ShapeTypes,
    sha256HexSync,
    type TrackedShape,
} from "@spicy3d/core";
import type { FeatureContext, FeatureData, LoftFeatureData } from "./feature";
import { pathReferenceDependencies, type ResolvedPath, resolvePathReferences } from "./pathReferences";
import { captureProfileRef } from "./profileRef";
import { isReusableTopologyIdentity } from "./reusableTopologyIdentity";
import { validateSelfIntersection } from "./selfIntersectionValidation";
import { resolveSweepSection, type SweepSection, sectionVertexSeeds } from "./sweep";
import { ancestorInputs } from "./trackedId";

export function guidedLoftDependencies(feature: LoftFeatureData, document: IDocument) {
    const sections = Array.isArray(feature.sections)
        ? feature.sections.map((section) => section.sketchId)
        : [];
    if (!feature.guided) return { refIds: [...new Set(sections)], key: undefined };
    if (!feature.guided.spine || !feature.guided.boundary)
        return { refIds: [...new Set(sections)], key: undefined };
    const host = document.modelManager.findNode((node) => {
        const features = (node as { features?: unknown }).features;
        return (
            Array.isArray(features) && features.some((candidate: FeatureData) => candidate.id === feature.id)
        );
    });
    if (!host)
        return {
            refIds: [...new Set([...sections, feature.guided.spine.nodeId, feature.guided.boundary.nodeId])],
            key: undefined,
        };
    const spine = pathReferenceDependencies(feature.guided.spine, document, host.id);
    const boundary = pathReferenceDependencies(feature.guided.boundary, document, host.id);
    return {
        refIds: [...new Set([...sections, ...spine.refIds, ...boundary.refIds])],
        key: JSON.stringify([
            (host as { worldTransform?: () => { toArray(): unknown } }).worldTransform?.().toArray(),
            spine.key,
            boundary.key,
        ]),
    };
}

interface Origin {
    readonly seed: string;
    readonly role: string;
    readonly stable: boolean;
}

function semanticId(featureId: string, role: string, origins: readonly Origin[]): string {
    if (!origins.length || origins.some((origin) => !origin.stable))
        return `untracked:${crypto.randomUUID()}`;
    const provenance = [
        ...new Set(origins.map((origin) => JSON.stringify([origin.role, origin.seed]))),
    ].sort();
    return `${featureId}:guided-loft:${role}:${sha256HexSync(new TextEncoder().encode(JSON.stringify(provenance)))}`;
}

/** Several output pieces with indistinguishable ancestry have no proven individual reusable identity. */
function separateAmbiguousPieces(ids: string[]): string[] {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return ids.map((id) => ((counts.get(id) ?? 0) > 1 ? `untracked:${crypto.randomUUID()}` : id));
}

/** Exact topology incidence supplies semantic boundary roles when PipeShell omits edge history. */
function adjacentFaceOrigins(shape: IShape, faceIds: readonly string[]): Origin[][] {
    const faces = shape.findSubShapes(ShapeTypes.face);
    const edges = shape.findSubShapes(ShapeTypes.edge);
    const faceEdges = faces.map((face) => face.findSubShapes(ShapeTypes.edge));
    try {
        return edges.map((edge) =>
            faces.flatMap((_, index) =>
                faceEdges[index].some((candidate) => candidate.isSame(edge))
                    ? [
                          {
                              seed: faceIds[index],
                              role: "adjacent-face",
                              stable: isReusableTopologyIdentity(faceIds[index]),
                          },
                      ]
                    : [],
            ),
        );
    } finally {
        for (const group of faceEdges) for (const edge of group) edge.dispose();
        for (const edge of edges) edge.dispose();
        for (const face of faces) face.dispose();
    }
}

function trackGuidedLoft(
    feature: LoftFeatureData,
    sections: readonly SweepSection[],
    spine: ResolvedPath,
    boundary: ResolvedPath,
    result: TrackedShape,
): Result<{ faceIds: string[]; edgeIds: string[] }> {
    const history = result.pipeHistory;
    if (!history) return Result.err("Guided loft kernel did not report topology ancestry");
    if (
        ![
            history.faceEdges,
            history.faceVertices,
            history.edgeVertices,
            history.startFaces,
            history.startEdges,
            history.endEdges,
        ].every(Array.isArray)
    )
        return Result.err("Guided loft kernel ancestry channels are malformed");
    try {
        const edges: Origin[] = sections.flatMap((section) =>
            section.edgeSeeds.map((seed) => ({ seed, role: "section-edge", stable: true })),
        );
        const vertices: Origin[] = sections.flatMap((section) =>
            sectionVertexSeeds(section.wire, section.edges, section.edgeSeeds).map((seed) => ({
                seed,
                role: "section-vertex",
                stable: true,
            })),
        );
        for (const [role, path] of [
            ["spine", spine],
            ["boundary", boundary],
        ] as const) {
            edges.push(
                ...path.edgeSeeds.map((seed, index) => ({
                    seed,
                    role: `${role}-edge`,
                    stable: path.edgeSeedStable[index] && isReusableTopologyIdentity(seed),
                })),
            );
            vertices.push(
                ...sectionVertexSeeds(path.wire, path.edges, path.edgeSeeds, path).map((seed) => ({
                    seed,
                    role: `${role}-vertex`,
                    stable:
                        path.edgeSeedStable.every(Boolean) &&
                        path.edgeSeeds.every(isReusableTopologyIdentity) &&
                        isReusableTopologyIdentity(seed),
                })),
            );
        }
        const count = (type: ShapeType) => {
            const shapes = result.shape.findSubShapes(type);
            try {
                return shapes.length;
            } finally {
                for (const shape of shapes) shape.dispose();
            }
        };
        const faceCount = count(ShapeTypes.face);
        const edgeCount = count(ShapeTypes.edge);
        const validIndex = (index: number, maximum: number) =>
            Number.isInteger(index) && index >= 0 && index < maximum;
        const pairs = (values: readonly number[] | undefined, outputCount: number, inputCount: number) => {
            if (values === undefined) return;
            if (!Array.isArray(values) || values.length % 2 !== 0)
                throw new Error("Guided loft ancestry pairs are malformed");
            for (let index = 0; index < values.length; index += 2) {
                if (!validIndex(values[index], outputCount) || !validIndex(values[index + 1], inputCount))
                    throw new Error("Guided loft ancestry index is outside its topology list");
            }
        };
        const indexes = (values: readonly number[] | undefined, maximum: number) => {
            if (values === undefined) return;
            if (!Array.isArray(values) || values.some((index) => !validIndex(index, maximum)))
                throw new Error("Guided loft boundary index is outside its topology list");
        };
        if (
            !Array.isArray(result.edgeMap) ||
            result.edgeMap.length !== edgeCount ||
            result.edgeMap.some((index) => index !== -1 && !validIndex(index, edges.length))
        )
            throw new Error("Guided loft edge ancestry map is malformed");
        pairs(history.faceEdges, faceCount, edges.length);
        pairs(history.faceVertices, faceCount, vertices.length);
        pairs(result.edgeAncestors, edgeCount, edges.length);
        pairs(history.edgeVertices, edgeCount, vertices.length);
        indexes(history.startFaces, faceCount);
        indexes(result.capFaces, faceCount);
        indexes(history.startEdges, edgeCount);
        indexes(history.endEdges, edgeCount);
        if (
            !history.startEdges.length ||
            !history.endEdges.length ||
            history.startEdges.some((index) => history.endEdges.includes(index)) ||
            history.startFaces.some((index) => result.capFaces?.includes(index)) ||
            (feature.solid !== false && (history.startFaces.length !== 1 || result.capFaces?.length !== 1))
        )
            throw new Error("Guided loft boundary ancestry is incomplete or ambiguous");
        const faceEdges = ancestorInputs(Array(faceCount).fill(-1), history.faceEdges);
        const faceVertices = ancestorInputs(Array(faceCount).fill(-1), history.faceVertices);
        const edgeEdges = ancestorInputs(result.edgeMap, result.edgeAncestors);
        const edgeVertices = ancestorInputs(Array(edgeCount).fill(-1), history.edgeVertices);
        const inputs = (indexes: readonly number[], origins: readonly Origin[]): Origin[] =>
            indexes.map((index) => {
                if (!Number.isInteger(index) || index < 0 || index >= origins.length)
                    throw new Error("Guided loft ancestry refers to an invalid input");
                return origins[index];
            });
        const faceIds = Array.from({ length: faceCount }, (_, index) => {
            if (history.startFaces.includes(index))
                return semanticId(feature.id, "start-cap", [
                    { seed: sections[0].seed, role: "section", stable: true },
                ]);
            if (result.capFaces?.includes(index))
                return semanticId(feature.id, "end-cap", [
                    { seed: sections[sections.length - 1].seed, role: "section", stable: true },
                ]);
            return semanticId(feature.id, "side", [
                ...inputs(faceEdges[index], edges),
                ...inputs(faceVertices[index], vertices),
            ]);
        });
        const resolvedFaceIds = separateAmbiguousPieces(faceIds);
        const adjacent = adjacentFaceOrigins(result.shape, resolvedFaceIds);
        const edgeIds = Array.from({ length: edgeCount }, (_, index) =>
            semanticId(
                feature.id,
                history.startEdges.includes(index)
                    ? "start-edge"
                    : history.endEdges.includes(index)
                      ? "end-edge"
                      : "edge",
                [
                    ...inputs(edgeEdges[index], edges),
                    ...inputs(edgeVertices[index], vertices),
                    ...adjacent[index],
                ],
            ),
        );
        return Result.ok({ faceIds: resolvedFaceIds, edgeIds: separateAmbiguousPieces(edgeIds) });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

export function evaluateGuidedLoft(feature: LoftFeatureData, context: FeatureContext): Result<IShape> {
    if (!feature.guided) return Result.err("Guided loft inputs are missing");
    if (
        !feature.guided.spine ||
        !feature.guided.boundary ||
        typeof feature.guided.spine.nodeId !== "string" ||
        typeof feature.guided.boundary.nodeId !== "string" ||
        !Array.isArray(feature.guided.spine.edges) ||
        !Array.isArray(feature.guided.boundary.edges)
    )
        return Result.err("Guided loft requires referenced spine and boundary paths");
    if (feature.ruled || (feature.continuity !== undefined && feature.continuity !== "c2"))
        return Result.err("Guided loft supports smooth C2 only; ruled, C0 and C1 are unsupported");
    if (!Array.isArray(feature.sections) || feature.sections.length < 2 || feature.sections.length > 16)
        return Result.err("Guided loft requires 2 to 16 sections");
    if (!shapeFactory.loftGuidedTracked) return Result.err("Guided loft requires a newer geometry kernel");
    const sections: SweepSection[] = [];
    let spine: ResolvedPath | undefined, boundary: ResolvedPath | undefined;
    let shape: IShape | undefined;
    try {
        for (const section of feature.sections) {
            const resolved = resolveSweepSection({ section }, context);
            if (!resolved.isOk) return Result.err(`Guided loft section: ${resolved.error}`);
            sections.push(resolved.value);
        }
        const resolvedSpine = resolvePathReferences(feature.guided.spine, context);
        if (!resolvedSpine.isOk) return Result.err(`Guided loft spine: ${resolvedSpine.error}`);
        spine = resolvedSpine.value;
        const resolvedBoundary = resolvePathReferences(feature.guided.boundary, context);
        if (!resolvedBoundary.isOk) return Result.err(`Guided loft boundary: ${resolvedBoundary.error}`);
        boundary = resolvedBoundary.value;
        if (spine.closed || boundary.closed) return Result.err("Guided loft paths must be open");
        if (spine.edges.length > 128 || boundary.edges.length > 128)
            return Result.err("Guided loft paths exceed the 128-piece limit");
        const result = shapeFactory.loftGuidedTracked(
            sections.map((section) => section.wire),
            spine.wire,
            boundary.wire,
            feature.solid !== false,
            shapeFactory.supportsDeferredGuidedLoft === true,
        );
        if (!result.isOk) return Result.err(result.error);
        shape = result.value.shape;
        if (shapeFactory.supportsDeferredGuidedLoft) {
            const clean = validateSelfIntersection(
                shape,
                context.warn,
                context.deferSelfIntersection,
                "Guided loft output intersects itself",
            );
            if (!clean.isOk) return Result.err(clean.error);
        } else if (!shape.checkShape()) return Result.err("Guided loft output is invalid");
        const ids = trackGuidedLoft(feature, sections, spine, boundary, result.value);
        if (!ids.isOk) return Result.err(ids.error);
        if (context.tracking) {
            context.tracking.outputFaceIds = ids.value.faceIds;
            context.tracking.outputEdgeIds = ids.value.edgeIds;
            context.tracking.resolvedProfiles = sections.map((section) => captureProfileRef(section.face));
            context.tracking.resolvedEdges = [
                ...spine.references.map((ref) => ref.anchor),
                ...boundary.references.map((ref) => ref.anchor),
            ];
        }
        const output = shape;
        shape = undefined;
        return Result.ok(output);
    } finally {
        shape?.dispose();
        boundary?.dispose();
        spine?.dispose();
        for (const section of sections) section.dispose();
    }
}
