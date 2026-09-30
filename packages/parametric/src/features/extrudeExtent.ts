// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IFace,
    type IShape,
    LENGTH_UNITS,
    Matrix4,
    Result,
    resolveUnitSpec,
    type Scope,
    ShapeNode,
    type TrackedShape,
    type XYZ,
} from "@spicy3d/core";
import { isBodyTimelineNode } from "./bodyTracking";
import type {
    ExtrudeExtent,
    ExtrudeFeatureData,
    FeatureContext,
    FeatureData,
    IShapeHost,
    ShapeTracking,
} from "./feature";
import { captureProfileRef, type ProfileRef, profileScore } from "./profileRef";
import { matchSourceFaceIndexes, resolveSourceFaces } from "./sourceFaceMatcher";

/**
 * Extrude extents (Fusion's Distance / To object / Through all, parametric format 3).
 *
 * - **Kernel.** A distance side is the classic `prism(Tracked)`; the other two are the tracked
 *   `prismUntilTracked` / `prismThruAllTracked` ops. All three return the TOOL with the same
 *   profile-relative history channels, so the extrude's id pipeline (`sweepProfileTracked`) and
 *   the tracked booleans that combine the tool with the body do not know which one ran — and ids
 *   downstream stay stable when the target face moves or the body resizes.
 * - **Direction.** A side sweeps along the profile normal times the sign of `depth` (0 counts as
 *   positive). A one-sided to-object / through-all extent tries the other way when the face is
 *   behind the profile or nothing lies ahead (the kernel never flips); the sides of a two-sided or
 *   symmetric extrude are fixed.
 * - **The target face** is a `ProfileRef` (world coordinates + tracked id, like a press-pull
 *   source face) re-matched on every rebuild with `resolveSourceFaces` / `matchSourceFaceIndexes`,
 *   so the rollback and consumed guards apply. Which shape it is matched on:
 *   - the face's body is the body evaluating the feature (the host, or a target replaying an
 *     `extrudeTarget` entry): its own chain input there;
 *   - the extrude's host, seen from another target: the host's chain state entering the extrude;
 *   - another body holding an entry of this extrude: its state entering that entry — its shape
 *     before this extrude acted on it, as the user picked it (and no feedback loop between the
 *     two bodies);
 *   - any other body: its live shape.
 *   A face that cannot be resolved fails the feature — never a silent fall back to a distance.
 * - **Through all** passes through the bodies the extrude acts on: each body bounds its own tool
 *   (the host its chain input, every `extrudeTarget` entry its own input), so a cut goes through
 *   each target entirely without one body's rebuild depending on another's shape. A join ends
 *   flush with the far side of the host (the body it joins); a cut/intersect a margin past it.
 */

/** One side of an extrude, ready for the kernel. */
export type SweepSide =
    | {
          readonly kind: "fromFace";
          readonly direction: XYZ;
          readonly face: IFace;
          readonly offset: number;
          readonly end: SweepSide;
      }
    | { readonly kind: "distance"; readonly vec: XYZ }
    | {
          readonly kind: "toObject";
          readonly direction: XYZ;
          readonly face: IFace;
          readonly offset: number;
          /** One-sided extrudes retry the opposite direction when the face is behind the profile. */
          readonly reversible: boolean;
      }
    | {
          readonly kind: "throughAll";
          readonly direction: XYZ;
          readonly bounds: readonly IShape[];
          readonly flush: boolean;
          /** One-sided extrudes retry the opposite direction when nothing lies ahead of the profile. */
          readonly reversible: boolean;
      };

/** Where an extrude's extents resolve their faces and bounds. */
export interface ExtentEnvironment {
    readonly document: IDocument;
    readonly scope: Scope;
    /** The body whose feature list holds the extrude; the tool is built in its local space. */
    readonly toolHost: IShapeHost;
    /** The body evaluating the feature — the host, or a target replaying an entry — and its context. */
    readonly current: FeatureContext;
    /** What a through-all side must pass through, in the tool host's local space. */
    readonly bounds: readonly IShape[];
    /** A join ends through-all flush with the bounds. */
    readonly flush: boolean;
    /** Where matched target-face refs are re-anchored — the host's own evaluation only. */
    readonly tracking?: ShapeTracking;
}

export interface ResolvedExtents {
    /** The sides a profile with outward `normal` sweeps: one, or two for a symmetric extrude. */
    sidesAlong(normal: XYZ): SweepSide[];
    /** Releases the target faces' copies once the sweeps have run. */
    dispose(): void;
}

type ToObjectExtent = Extract<ExtrudeExtent, { type: "toObject" }>;
type ExtentKey = "extent" | "secondExtent" | "startFace";

/** The to-object extents of `feature`, by field. */
export function toObjectExtents(feature: ExtrudeFeatureData): [ExtentKey, ToObjectExtent][] {
    const result: [ExtentKey, ToObjectExtent][] = [];
    if (feature.startFace) result.push(["startFace", { type: "toObject", ...feature.startFace }]);
    if (feature.extent?.type === "toObject") result.push(["extent", feature.extent]);
    if (feature.symmetric === true && feature.secondExtent?.type === "toObject") {
        result.push(["secondExtent", feature.secondExtent]);
    }
    return result;
}

/**
 * A target-face ref: the press-pull fingerprint (tracked id, `splitPiece`), with the outward
 * normal gate only for planar faces — a curved face's normal at its parameter origin says
 * nothing about where the face points.
 */
export function captureExtentFaceRef(face: IFace, id?: string, splitPiece?: boolean): ProfileRef {
    return captureProfileRef(face, id, splitPiece, face.surface().isPlanar());
}

/**
 * Resolves the feature's extents against `env`: target faces matched (and re-anchored), offsets
 * evaluated. The result hands out the sides per profile normal; `depth` is the resolved depth.
 */
export function resolveExtents(
    feature: ExtrudeFeatureData,
    depth: number,
    env: ExtentEnvironment,
): Result<ResolvedExtents> {
    const first = feature.extent ?? { type: "distance" };
    const symmetric = feature.symmetric === true;
    const second = symmetric ? (feature.secondExtent ?? first) : undefined;
    if (symmetric && feature.secondExtent === undefined && first.type === "toObject") {
        return Result.err(SYMMETRIC_TO_OBJECT_ERROR);
    }
    const owned: IFace[] = [];
    const dispose = () => owned.forEach((x) => x.dispose());
    let start: { face: IFace; offset: number } | undefined;
    if (feature.startFace) {
        const offset = resolveUnitSpec(feature.startOffset ?? 0, env.scope, LENGTH_UNITS);
        if (!offset.isOk) return Result.err(offset.error);
        const face = resolveExtentFace("startFace", { type: "toObject", ...feature.startFace }, feature, env);
        if (!face.isOk) return Result.err(`Starting face: ${face.error}`);
        owned.push(face.value);
        start = { face: face.value, offset: offset.value };
    }
    const firstEnd = resolveEnd("extent", first, feature, env, owned);
    if (!firstEnd.isOk) {
        dispose();
        return Result.err(firstEnd.error);
    }
    let secondEnd: ExtentEnd | undefined;
    if (second !== undefined) {
        const resolved =
            second === first ? firstEnd : resolveEnd("secondExtent", second, feature, env, owned);
        if (!resolved.isOk) {
            dispose();
            return Result.err(resolved.error);
        }
        secondEnd = resolved.value;
    }
    return Result.ok({
        sidesAlong: (normal) =>
            extentSides(firstEnd.value, secondEnd, normal, depth).map((side) => {
                if (!start) return side;
                const direction =
                    side.kind === "distance" ? (side.vec.normalize() ?? normal) : side.direction;
                return {
                    kind: "fromFace" as const,
                    direction,
                    face: start.face,
                    offset: start.offset * (direction.dot(normal) < 0 ? -1 : 1),
                    end: side,
                };
            }),
        dispose,
    });
}

/** Where one side ends, resolved: what `extentSides` turns into kernel sides. */
export type ExtentEnd =
    | { readonly kind: "distance" }
    | { readonly kind: "toObject"; readonly face: IFace; readonly offset: number }
    | { readonly kind: "throughAll"; readonly bounds: readonly IShape[]; readonly flush: boolean };

/**
 * The sides a profile with outward `normal` sweeps: `first` along the normal times the sign of
 * `depth`, and `second` (a symmetric / two-sided extrude) the opposite way. A distance side takes
 * `depth` itself; only a one-sided extrude may reverse (see the module comment).
 */
export function extentSides(
    first: ExtentEnd,
    second: ExtentEnd | undefined,
    normal: XYZ,
    depth: number,
): SweepSide[] {
    const direction = normal.multiply(depth < 0 ? -1 : 1);
    const sides = [sideOf(first, direction, normal.multiply(depth), second === undefined)];
    if (second !== undefined) {
        sides.push(sideOf(second, direction.multiply(-1), normal.multiply(-depth), false));
    }
    return sides;
}

function sideOf(end: ExtentEnd, direction: XYZ, vec: XYZ, reversible: boolean): SweepSide {
    switch (end.kind) {
        case "toObject":
            return { kind: "toObject", direction, face: end.face, offset: end.offset, reversible };
        case "throughAll":
            return { kind: "throughAll", direction, bounds: end.bounds, flush: end.flush, reversible };
        default:
            return { kind: "distance", vec };
    }
}

/** Error of a symmetric extrude whose single extent is a face. */
export const SYMMETRIC_TO_OBJECT_ERROR =
    "A symmetric extrude cannot end on a face: give the second side its own extent";

/** Error of a through-all extent with nothing to go through (a new body). */
export const THROUGH_ALL_NO_BODY_ERROR = "Through all needs a body to go through (join, cut or intersect)";

function resolveEnd(
    key: ExtentKey,
    extent: ExtrudeExtent,
    feature: ExtrudeFeatureData,
    env: ExtentEnvironment,
    owned: IFace[],
): Result<ExtentEnd> {
    switch (extent.type) {
        case "throughAll":
            if (env.bounds.length === 0) return Result.err(THROUGH_ALL_NO_BODY_ERROR);
            return Result.ok({ kind: "throughAll", bounds: env.bounds, flush: env.flush });
        case "toObject": {
            const offset = resolveUnitSpec(extent.offset ?? 0, env.scope, LENGTH_UNITS);
            if (!offset.isOk) return Result.err(offset.error);
            const face = resolveExtentFace(key, extent, feature, env);
            if (!face.isOk) return Result.err(face.error);
            owned.push(face.value);
            return Result.ok({ kind: "toObject", face: face.value, offset: offset.value });
        }
        default:
            return Result.ok({ kind: "distance" });
    }
}

/**
 * The target face in the tool host's local space (a copy, owned by the caller), matched on the
 * shape `extentFaceContext` picks; re-anchors the ref when the host evaluates its own feature.
 */
function resolveExtentFace(
    key: ExtentKey,
    extent: ToObjectExtent,
    feature: ExtrudeFeatureData,
    env: ExtentEnvironment,
): Result<IFace> {
    const context = extentFaceContext(env, feature.id, extent.nodeId);
    if (!context.isOk) return Result.err(context.error);
    const nodeId = extent.nodeId ?? env.toolHost.id;
    const resolved = resolveSourceFaces({ nodeId, profiles: [extent.face] }, context.value);
    if (!resolved.isOk) return Result.err(extentFaceError(resolved.error));
    const { worldFaces, faceIds, owned } = resolved.value;
    try {
        const matched = matchSourceFaceIndexes(worldFaces, faceIds, [extent.face]);
        if (!matched.isOk) return Result.err(extentFaceError(matched.error));
        // A face split since the pick matches every piece; the up-to surface is the same, and the
        // piece closest to the pick keeps the re-anchored ref close to it.
        const best = matched.value.indexes
            .map((index) => ({ index, score: profileScore(worldFaces[index], extent.face) }))
            .sort((a, b) => a.score - b.score)[0];
        if (best === undefined) return Result.err("Extent face not found after rebuild");
        const world = worldFaces[best.index];
        if (env.tracking !== undefined) {
            env.tracking.resolvedFaces = {
                ...env.tracking.resolvedFaces,
                [key]: captureExtentFaceRef(world, faceIds?.[best.index], extent.face.splitPiece),
            };
        }
        const toLocal = env.toolHost.worldTransform().invert() ?? Matrix4.identity();
        return Result.ok(world.transformedMul(toLocal) as IFace);
    } finally {
        owned.forEach((x) => x.dispose());
    }
}

/**
 * The face the to-object `extent` of `feature` resolves to when its host evaluates it with
 * `context` (the chain state entering the feature), in world coordinates — what an edit session
 * highlights. Nothing is re-anchored. The caller disposes the face.
 */
export function locateExtentFace(
    feature: ExtrudeFeatureData,
    extent: ExtrudeExtent,
    context: FeatureContext,
): Result<IFace> {
    if (extent.type !== "toObject") return Result.err("The extent does not end on a face");
    const local = resolveExtentFace("extent", extent, feature, {
        document: context.document,
        scope: context.scope,
        toolHost: context.host,
        current: context,
        bounds: [],
        flush: false,
    });
    if (!local.isOk) return local;
    const world = local.value.transformedMul(context.host.worldTransform()) as IFace;
    local.value.dispose();
    return Result.ok(world);
}

/** The associative starting face, in world coordinates; the caller disposes it. */
export function locateStartFace(feature: ExtrudeFeatureData, context: FeatureContext): Result<IFace> {
    if (feature.startFace === undefined) return Result.err("The extrusion has no starting face");
    return locateExtentFace(feature, { type: "toObject", ...feature.startFace }, context);
}

/** Face-resolution errors, worded for an extent's face rather than a press-pull source. */
function extentFaceError(error: string): string {
    switch (error) {
        case "Extrude source body not found":
            return "Extent face's body not found";
        case "Extrude source body is rolled back for a sketch session":
            return "Extent face's body is rolled back for a sketch session";
        case "Extrude source face requires a preceding feature":
            return "Extent face requires a preceding feature";
        default:
            return `Extent face: ${error}`;
    }
}

/** A body with a feature list — structurally, so this module need not import the node class. */
interface IFeatureListNode {
    readonly id: string;
    readonly features: readonly FeatureData[];
}

function featureListNode(document: IDocument, id: string): (ShapeNode & IFeatureListNode) | undefined {
    const node = document.modelManager.findNode((n) => n.id === id);
    return node instanceof ShapeNode && Array.isArray((node as { features?: unknown }).features)
        ? (node as ShapeNode & IFeatureListNode)
        : undefined;
}

/**
 * Where on `node`'s timeline extrude `featureId` of `hostId` acts: the extrude itself in its host,
 * an `extrudeTarget` entry of it in another body; undefined when it does not act on `node`.
 */
function linkedIndex(node: IFeatureListNode, hostId: string, featureId: string): number | undefined {
    const index =
        node.id === hostId
            ? node.features.findIndex((x) => x.id === featureId)
            : node.features.findIndex(
                  (x) => x.type === "extrudeTarget" && x.bodyId === hostId && x.featureId === featureId,
              );
    return index < 0 ? undefined : index;
}

/**
 * The context whose shape a target face of `nodeId` (absent: the extrude's host) resolves on — see
 * the module comment. `resolveSourceFaces` then matches on its input when the ids agree, on the
 * live shape of `nodeId` otherwise.
 */
function extentFaceContext(
    env: ExtentEnvironment,
    featureId: string,
    nodeId: string | undefined,
): Result<FeatureContext> {
    const id = nodeId ?? env.toolHost.id;
    if (id === env.current.host.id) return Result.ok(env.current);
    const node = featureListNode(env.document, id);
    const index = node === undefined ? undefined : linkedIndex(node, env.toolHost.id, featureId);
    if (node === undefined || index === undefined || !isBodyTimelineNode(node)) {
        return Result.ok({ document: env.document, host: env.toolHost, scope: env.scope });
    }
    if (node.rollbackIndex !== undefined) {
        return Result.err("Extent face's body is rolled back for a sketch session");
    }
    let state = node.timelineStateAt(index);
    if (state === undefined) {
        // Not rebuilt yet (document load order): reading the shape evaluates it.
        void node.shape;
        state = node.timelineStateAt(index);
    }
    if (state?.shape === undefined) return Result.err("Extent face's body has not been rebuilt");
    return Result.ok({
        document: env.document,
        host: node,
        input: state.shape,
        scope: env.scope,
        tracking: {
            inputFaceIds: state.faceIds ?? [],
            outputFaceIds: [],
            inputEdgeIds: state.edgeIds ?? [],
            outputEdgeIds: [],
        },
    });
}

/** Identity tokens of shapes, for cache keys (a timeline state changes object when it changes). */
const shapeTokens = new WeakMap<object, number>();
let nextShapeToken = 1;

function shapeToken(shape: object): number {
    let token = shapeTokens.get(shape);
    if (token === undefined) {
        token = nextShapeToken++;
        shapeTokens.set(shape, token);
    }
    return token;
}

/**
 * What the to-object faces of `feature` (hosted in `hostId`) read, seen from body
 * `evaluatingId`: `refIds` — bodies whose live shape a face resolves on (cache refs), `key` —
 * tokens of the timeline states the other faces resolve on (cache key parts). A face on the
 * evaluating body itself resolves on its input, which the cache compares anyway.
 */
export function extentDependencies(
    document: IDocument,
    hostId: string,
    feature: ExtrudeFeatureData,
    evaluatingId: string,
): { refIds: string[]; key: string[] } {
    const refIds: string[] = [];
    const key: string[] = [];
    for (const [, extent] of toObjectExtents(feature)) {
        const id = extent.nodeId ?? hostId;
        if (id === evaluatingId) continue;
        const node = featureListNode(document, id);
        const index = node === undefined ? undefined : linkedIndex(node, hostId, feature.id);
        if (node === undefined || index === undefined || !isBodyTimelineNode(node)) {
            refIds.push(id);
            continue;
        }
        const state = node.timelineStateAt(index);
        key.push(`${id}:${state?.shape === undefined ? "none" : shapeToken(state.shape)}`);
    }
    return { refIds, key };
}

/** The bodies the to-object faces of `feature` are on (the host's own omitted). */
export function extentNodeIds(feature: ExtrudeFeatureData): string[] {
    return toObjectExtents(feature).flatMap(([, extent]) =>
        extent.nodeId === undefined ? [] : [extent.nodeId],
    );
}

/** One side's tool with kernel history (channels relative to the profile, see `prismTracked`). */
export function sweepSideTracked(face: IFace, side: SweepSide): Result<TrackedShape> {
    switch (side.kind) {
        case "fromFace": {
            const from = shapeFactory.prismFromTracked?.bind(shapeFactory);
            if (!from) return Result.err("This kernel cannot start an extrusion from a face");
            const end = side.end;
            if (end.kind === "fromFace") return Result.err("Nested starting faces are invalid");
            return from(
                face,
                side.direction,
                side.face,
                side.offset,
                end.kind === "distance"
                    ? { kind: "distance", depth: end.vec.length() }
                    : end.kind === "toObject"
                      ? { kind: "toObject", face: end.face, offset: end.offset }
                      : { kind: "throughAll", bounds: [...end.bounds], flush: end.flush },
            );
        }
        case "distance":
            return shapeFactory.prismTracked === undefined
                ? Result.err("This kernel cannot extrude with history")
                : shapeFactory.prismTracked(face, side.vec);
        case "toObject": {
            const until = shapeFactory.prismUntilTracked?.bind(shapeFactory);
            if (until === undefined) return Result.err("This kernel cannot extrude up to a face");
            const forward = until(face, side.direction, side.face, side.offset);
            if (forward.isOk || !side.reversible) return forward;
            const backward = until(face, side.direction.multiply(-1), side.face, side.offset);
            return backward.isOk ? backward : forward;
        }
        default: {
            const thru = shapeFactory.prismThruAllTracked?.bind(shapeFactory);
            if (thru === undefined) return Result.err("This kernel cannot extrude through all");
            const forward = thru(face, side.direction, [...side.bounds], side.flush);
            if (forward.isOk || !side.reversible) return forward;
            const backward = thru(face, side.direction.multiply(-1), [...side.bounds], side.flush);
            return backward.isOk ? backward : forward;
        }
    }
}

/** One side's tool without history (the plain path). */
export function sweepSide(face: IFace, side: SweepSide): Result<IShape> {
    if (side.kind === "distance") return shapeFactory.prism(face, side.vec);
    const tracked = sweepSideTracked(face, side);
    return tracked.isOk ? Result.ok(tracked.value.shape) : Result.err(tracked.error);
}

/** True when every side of `sides` is a distance with a usable kernel for the tracked path. */
export function canSweepTracked(sides: readonly SweepSide[]): boolean {
    return sides.every((side) =>
        side.kind === "fromFace"
            ? shapeFactory.prismFromTracked !== undefined
            : side.kind === "distance"
              ? shapeFactory.prismTracked !== undefined
              : side.kind === "toObject"
                ? shapeFactory.prismUntilTracked !== undefined
                : shapeFactory.prismThruAllTracked !== undefined,
    );
}
