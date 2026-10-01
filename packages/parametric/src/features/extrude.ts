// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    LENGTH_UNITS,
    PerformanceTrace,
    Result,
    resolveUnitSpec,
    ShapeTypes,
    type TrackedShape,
    type XYZ,
} from "@spicy3d/core";
import { SketchNode } from "../sketch/sketchNode";
import { type TrackedMethod, trackedBoolean, validateBooleanResult } from "./boolean";
import {
    canSweepTracked,
    type ExtentEnvironment,
    extentDependencies,
    extentNodeIds,
    type ResolvedExtents,
    resolveExtents,
    type SweepSide,
    sweepSideTracked,
    toObjectExtents,
} from "./extrudeExtent";
import {
    type BooleanOperation,
    completeTrackedHistory,
    type ExtrudeFeatureData,
    type FeatureContext,
    type FeatureData,
    type FeatureHandler,
    registerFeature,
    type ShapeTracking,
    trackedFaceIds,
    trackedIds,
} from "./feature";
import { mapFusedIds, mapOperationIds } from "./operationIds";
import { extrudeFromSourceFaces } from "./pressPull";
import { type ResolvedProfile, resolveProfiles } from "./profileBuilder";
import { profileEdgeEntityIds, registerProfileEdgeEntities } from "./profileEntities";
import { captureProfileRef } from "./profileRef";
import { profileEdgeSeeds } from "./profileSeeds";
import { anyPairTouches, combineShapes, extrudePlain, translateFace } from "./sweepGeometry";

export function findSketch(document: IDocument, id: string): SketchNode | undefined {
    const node = document.modelManager.findNode((n) => n.id === id);
    return node instanceof SketchNode ? node : undefined;
}

const extrudeHandler: FeatureHandler<ExtrudeFeatureData> = {
    display: "command.feature.extrude",
    icon: "icon-prism",
    reselectable: true,

    nodeIds: (feature) => [
        ...new Set(
            [feature.sketchId, feature.source?.nodeId, ...extentNodeIds(feature)].filter(
                (x): x is string => x !== undefined,
            ),
        ),
    ],

    // A to-object face on a body holding an entry of this extrude resolves on that body's state
    // entering the entry (`extrudeExtent.ts`): a token of that state is part of the key, and the
    // body's shape is no cache ref.
    cacheKey: (feature, document) => {
        if (toObjectExtents(feature).length === 0 && extentNodeIds(feature).length === 0) return undefined;
        const host = extrudeHostOf(document, feature);
        return host === undefined
            ? undefined
            : extentDependencies(document, host, feature, host).key.join("|");
    },

    cacheRefIds: (feature, document) => {
        const base = [feature.sketchId, feature.source?.nodeId].filter((x): x is string => x !== undefined);
        if (toObjectExtents(feature).length === 0 && extentNodeIds(feature).length === 0) return base;
        const host = extrudeHostOf(document, feature);
        const extent =
            host === undefined
                ? extentNodeIds(feature)
                : extentDependencies(document, host, feature, host).refIds;
        return [...new Set([...base, ...extent])];
    },

    // Only the sketch: `source` is the body being press-pulled, which the tree
    // already shows and the feature row does not need a second door to.
    references: (feature) =>
        feature.sketchId === undefined
            ? []
            : [{ key: "sketchId", display: "body.sketch", nodeId: feature.sketchId }],

    parameters: (feature) => [
        { key: "depth", display: "option.command.depth", value: feature.depth, unit: LENGTH_UNITS },
        {
            key: "startOffset",
            display: "option.command.startOffset",
            value: feature.startOffset ?? 0,
            unit: LENGTH_UNITS,
        },
        { key: "symmetric", display: "option.command.symmetric", value: feature.symmetric ?? false },
        ...(feature.extent?.type === "toObject" || feature.extent?.type === "next"
            ? [
                  {
                      key: EXTENT_OFFSET,
                      display: "option.command.extentOffset" as const,
                      value: feature.extent.offset ?? 0,
                      unit: LENGTH_UNITS,
                  },
              ]
            : []),
    ],

    setParameter: (feature, key, value) => {
        if (key === "symmetric") return { ...feature, symmetric: value === true || value === "true" };
        if (key === EXTENT_OFFSET) {
            if (
                (feature.extent?.type !== "toObject" && feature.extent?.type !== "next") ||
                typeof value === "boolean"
            )
                return feature;
            return { ...feature, extent: { ...feature.extent, offset: value } };
        }
        return { ...feature, [key]: value };
    },

    applyResolvedRefs: (feature, { resolvedProfiles, resolvedFaces }) => {
        let next = feature;
        if (resolvedProfiles !== undefined) {
            next =
                next.source === undefined
                    ? { ...next, profiles: resolvedProfiles }
                    : { ...next, source: { ...next.source, profiles: resolvedProfiles } };
        }
        const startingFace = resolvedFaces?.["startFace"];
        if (startingFace && next.startFace)
            next = { ...next, startFace: { ...next.startFace, face: startingFace } };
        for (const key of ["extent", "secondExtent"] as const) {
            const face = resolvedFaces?.[key];
            const extent = next[key];
            if (face !== undefined && extent?.type === "toObject")
                next = { ...next, [key]: { ...extent, face } };
        }
        return next;
    },

    prepareAsync(feature, context) {
        const factory = shapeFactory.asyncOperations;
        const { input, tracking } = context;
        if (
            !factory ||
            factory.available === false ||
            !input ||
            !tracking ||
            !feature.operation ||
            !shapeFactory.prismTracked ||
            feature.startFace !== undefined ||
            // Through-all / to-object extents depend on the operation (flush) and the chain
            // state (re-anchored target faces): they stay on the synchronous path.
            [feature.extent, feature.secondExtent].some((x) => x !== undefined && x.type !== "distance")
        )
            return undefined;
        const toolTracking: ShapeTracking = { ...tracking, outputFaceIds: [], outputEdgeIds: [] };
        // Profiles/prisms and their sketch-scoped seeds are evaluated synchronously in this feature's
        // timeline. Only the expensive final combine with the accumulated body crosses the await.
        const built = extrudeHandler.evaluate(
            { ...feature, operation: undefined },
            { ...context, tracking: toolTracking },
        );
        if (!built.isOk) return { ready: Promise.resolve(), cancel: () => {}, take: () => built };
        const ids = feature.source
            ? {
                  faceIds: positionalToolIds(built.value, ShapeTypes.face, `${feature.id}:tool:f`),
                  edgeIds: positionalToolIds(built.value, ShapeTypes.edge, `${feature.id}:tool:e`),
              }
            : { faceIds: toolTracking.outputFaceIds, edgeIds: toolTracking.outputEdgeIds };
        tracking.resolvedProfiles = toolTracking.resolvedProfiles;
        let pending: ReturnType<typeof factory.booleanTracked>;
        try {
            pending = factory.booleanTracked(feature.operation, [input], [built.value], {
                mesh: context.meshResult,
            });
        } finally {
            built.value.dispose();
        }
        if (!pending) return undefined;
        return {
            ready: pending.ready,
            cancel: () => pending.cancel(),
            take: () => {
                const answer = pending.take();
                if (!answer.isOk) {
                    if (!pending.canFallback) return Result.err(answer.error);
                    const span = PerformanceTrace.enabled
                        ? PerformanceTrace.begin("kernel.workerFallback", {
                              operation: feature.operation,
                              reason: answer.error,
                          })
                        : undefined;
                    if (span) PerformanceTrace.end(span);
                    return extrudeHandler.evaluate(feature, context);
                }
                const { inputs, result } = answer.value;
                const subs: IShape[] = [];
                let accepted = false;
                try {
                    const inputEdges = inputs.flatMap((shape) =>
                        shape.findSubShapes(ShapeTypes.edge),
                    ) as IEdge[];
                    subs.push(...inputEdges);
                    const inputFaces = inputs.flatMap((shape) =>
                        shape.findSubShapes(ShapeTypes.face),
                    ) as IFace[];
                    subs.push(...inputFaces);
                    const history = completeTrackedHistory(inputs, result, { inputEdges, inputFaces });
                    subs.push(...history.outputEdges, ...history.outputFaces);
                    trackOperation(feature.id, inputs[0], tracking, ids, {
                        ...result,
                        faceMap: history.faceMap,
                        edgeMap: history.edgeMap,
                    });
                    accepted = true;
                    return Result.ok(result.shape);
                } finally {
                    for (const shape of subs) shape.dispose();
                    for (const shape of inputs) shape.dispose();
                    if (!accepted) result.shape.dispose();
                }
            },
        };
    },

    evaluate(feature, context): Result<IShape> {
        const params = resolveExtrudeParams(feature, context);
        if (!params.isOk) return Result.err(params.error);
        const { depth, startOffset } = params.value;
        const extents = resolveExtents(feature, depth, hostExtentEnvironment(feature, context));
        if (!extents.isOk) return Result.err(extents.error);
        try {
            const tracked = evaluateOperationTracked(feature, context, extents.value, startOffset);
            if (tracked !== undefined) return tracked;

            const source = feature.source;
            const built =
                source === undefined
                    ? extrudeFromSketch(feature, context, extents.value, startOffset)
                    : extrudeFromSourceFaces({ ...feature, source }, context, extents.value, startOffset);
            const result = combineWithInput(built, feature, context);
            return feature.operation === undefined ? result : validateBooleanResult(result);
        } finally {
            extents.value.dispose();
        }
    },
};

/** `parameters` key of a to-object extent's offset. */
const EXTENT_OFFSET = "extentOffset";

/** The id of the body whose feature list holds `feature`. */
function extrudeHostOf(document: IDocument, feature: ExtrudeFeatureData): string | undefined {
    return document.modelManager.findNode((n) => {
        const features = (n as { features?: unknown }).features;
        return Array.isArray(features) && features.some((x: FeatureData) => x.id === feature.id);
    })?.id;
}

/**
 * The extents' environment when the host evaluates its own extrude: its chain input bounds a
 * through-all side, and matched target faces are re-anchored.
 */
function hostExtentEnvironment(feature: ExtrudeFeatureData, context: FeatureContext): ExtentEnvironment {
    return {
        document: context.document,
        scope: context.scope,
        toolHost: context.host,
        current: context,
        bounds: context.input === undefined ? [] : [context.input],
        flush: feature.operation === "fuse",
        tracking: context.tracking,
    };
}

/**
 * The prism a sketch extrude sweeps — its tool volume, without the operation — in the
 * coordinates of the body hosting it. `context.host` is that body; no tracking runs and no
 * profile is re-anchored (the host's own evaluation does that). Press-pull extrudes read
 * their host's chain state and have no standalone tool.
 */
export function extrudeToolShape(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
    replay?: ExtentReplay,
): Result<IShape> {
    if (feature.source !== undefined) return Result.err("Only a sketch extrude can act on other bodies");
    const params = resolveExtrudeParams(feature, context);
    if (!params.isOk) return Result.err(params.error);
    const plainContext = { ...context, tracking: undefined };
    const extents = resolveExtents(feature, params.value.depth, {
        document: context.document,
        scope: context.scope,
        toolHost: context.host,
        current: replay?.current ?? plainContext,
        bounds: replay?.bounds ?? (context.input === undefined ? [] : [context.input]),
        flush: feature.operation === "fuse",
    });
    if (!extents.isOk) return Result.err(extents.error);
    try {
        return extrudeFromSketch(
            { ...feature, operation: undefined },
            plainContext,
            extents.value,
            params.value.startOffset,
        );
    } finally {
        extents.value.dispose();
    }
}

/**
 * Where a target body replaying an extrude (`extrudeTarget.ts`) stands: its own context (a
 * to-object face on it resolves on its input) and its input as the through-all bounds, in the
 * extrude host's local space.
 */
export interface ExtentReplay {
    readonly current: FeatureContext;
    readonly bounds: readonly IShape[];
}

/**
 * Combines `tool` (not disposed here) with the chain input by `operation` — tracked when the
 * kernel and the body allow it, so the input's face and edge ids survive; the tool's own
 * sub-shapes get positional ids scoped to `featureId`.
 */
export function combineWithTool(
    featureId: string,
    operation: BooleanOperation,
    context: FeatureContext,
    tool: IShape,
): Result<IShape> {
    const input = context.input;
    if (input === undefined) return Result.err("Extrude join/cut/intersect requires a preceding feature");
    const tracked = trackedBoolean(operation);
    if (context.tracking !== undefined && tracked !== undefined) {
        const ids = {
            shape: tool,
            faceIds: (tool.findSubShapes(ShapeTypes.face) as IFace[]).map(
                (_, index) => `${featureId}:tool:f${index}`,
            ),
            edgeIds: (tool.findSubShapes(ShapeTypes.edge) as IEdge[]).map(
                (_, index) => `${featureId}:tool:e${index}`,
            ),
        };
        return applyTrackedOperation(featureId, input, context.tracking, tracked, ids);
    }
    switch (operation) {
        case "cut":
            return shapeFactory.booleanCut([input], [tool]);
        case "common":
            return shapeFactory.booleanCommon([input], [tool]);
        default:
            return shapeFactory.booleanFuse([input], [tool], true);
    }
}

function positionalToolIds(
    shape: IShape,
    type: typeof ShapeTypes.face | typeof ShapeTypes.edge,
    prefix: string,
): string[] {
    const subs = shape.findSubShapes(type);
    try {
        return subs.map((_, index) => `${prefix}${index}`);
    } finally {
        for (const sub of subs) sub.dispose();
    }
}

/** Resolves the numeric parameters first, so a bad expression fails before any geometry runs. */
function resolveExtrudeParams(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
): Result<{ depth: number; startOffset: number }> {
    const depth = resolveUnitSpec(feature.depth, context.scope, LENGTH_UNITS);
    if (!depth.isOk) return Result.err(depth.error);
    const startOffset = resolveUnitSpec(feature.startOffset ?? 0, context.scope, LENGTH_UNITS);
    if (!startOffset.isOk) return Result.err(startOffset.error);
    return Result.ok({ depth: depth.value, startOffset: startOffset.value });
}

/**
 * Join/cut/intersect takes the tracked path, so downstream edge refs keep stable ids
 * through the boolean: sketch profiles via `extrudeOperationTracked`, and press-pulled
 * faces via `pressPullOperationTracked` so the body's own face ids survive past this
 * feature and later press-pulls still resolve by id. Returns undefined when no
 * operation was asked for, or when a tracking capability is missing.
 */
function evaluateOperationTracked(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
    extents: ResolvedExtents,
    startOffset: number,
): Result<IShape> | undefined {
    if (feature.operation === undefined) return undefined;
    const source = feature.source;
    return source === undefined
        ? extrudeOperationTracked(feature, context, extents, startOffset)
        : pressPullOperationTracked({ ...feature, source }, context, extents, startOffset);
}

/** Combines the freshly built prism with the chain input, when an operation was asked for. */
function combineWithInput(
    built: Result<IShape>,
    feature: ExtrudeFeatureData,
    context: FeatureContext,
): Result<IShape> {
    if (!built.isOk || feature.operation === undefined) return built;
    if (context.input === undefined) {
        built.value.dispose();
        return Result.err("Extrude join/cut/intersect requires a preceding feature");
    }
    try {
        switch (feature.operation) {
            case "cut":
                return shapeFactory.booleanCut([context.input], [built.value]);
            case "common":
                return shapeFactory.booleanCommon([context.input], [built.value]);
            default:
                return shapeFactory.booleanFuse([context.input], [built.value], true);
        }
    } finally {
        // The prism is an intermediate input — the kernel reads it eagerly.
        built.value.dispose();
    }
}

/** Extrudes the referenced sketch profiles (the classic path). */
function extrudeFromSketch(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
    extents: ResolvedExtents,
    startOffset: number,
): Result<IShape> {
    const resolved = resolveSketchProfiles(feature, context);
    if (!resolved.isOk) return Result.err(resolved.error);
    const { sketch, profiles } = resolved.value;
    const sides = extents.sidesAlong(sketch.plane.normal);
    const offsetVec = sketch.plane.normal.multiply(feature.startFace ? 0 : startOffset);

    // An operation with unavailable tracking falls back to the plain path — downstream
    // edge fingerprints then re-match geometrically after a rebuild.
    const plain =
        feature.operation !== undefined || context.tracking === undefined || !canSweepTracked(sides);
    return plain
        ? extrudePlain(profiles, sides, offsetVec)
        : extrudeTracked(feature, sketch, sides, profiles, context.tracking!, offsetVec);
}

/**
 * Resolves the feature's sketch and the profiles to extrude, re-anchoring the stored
 * fingerprints on the geometry matched this run (see `ShapeTracking.resolvedProfiles`)
 * so the next edit measures drift from here.
 */
function resolveSketchProfiles(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
): Result<{ sketch: SketchNode; profiles: ResolvedProfile[] }> {
    const sketch =
        feature.sketchId === undefined ? undefined : findSketch(context.document, feature.sketchId);
    if (sketch === undefined) return Result.err("Sketch not found");

    const profiles = resolveProfiles(sketch, feature.profiles);
    if (!profiles.isOk) return Result.err(profiles.error);
    if (feature.profiles !== undefined && feature.profiles.length > 0 && context.tracking !== undefined) {
        context.tracking.resolvedProfiles = profiles.value.map(({ face }) => captureProfileRef(face));
    }
    return Result.ok({ sketch, profiles: profiles.value });
}

function extrudeTracked(
    feature: ExtrudeFeatureData,
    sketch: SketchNode,
    sides: SweepSide[],
    profiles: ResolvedProfile[],
    tracking: ShapeTracking,
    offsetVec: XYZ,
): Result<IShape> {
    const swept = sweepProfiles(feature, sketch, sides, profiles, offsetVec);
    if (!swept.isOk) return Result.err(swept.error);
    tracking.outputFaceIds = swept.value.faceIds;
    tracking.outputEdgeIds = swept.value.edgeIds;
    return Result.ok(swept.value.shape);
}

/**
 * Sweeps every profile along each side with kernel history (sketch-scoped ids)
 * and merges touching prisms, returning the shape with its tracked ids in
 * findSubShapes order.
 */
function sweepProfiles(
    feature: ExtrudeFeatureData,
    sketch: SketchNode,
    sides: SweepSide[],
    profiles: ResolvedProfile[],
    offsetVec: XYZ,
): Result<{ shape: IShape; faceIds: string[]; edgeIds: string[] }> {
    const shapes: IShape[] = [];
    const faceIds: string[][] = [];
    const edgeIds: string[][] = [];
    for (const profile of profiles) {
        for (const [direction, side] of sides.entries()) {
            const swept = sweepProfileTracked(
                feature,
                sketch,
                side,
                profile,
                offsetVec,
                direction === 0 ? "" : ":neg",
            );
            if (!swept.isOk) {
                shapes.forEach((x) => x.dispose());
                return Result.err(swept.error);
            }
            shapes.push(swept.value.shape);
            faceIds.push(swept.value.faceIds);
            edgeIds.push(swept.value.edgeIds);
        }
    }
    const fused = fuseSweptPrisms(feature.id, shapes, faceIds, edgeIds);
    if (fused !== undefined) return fused;
    const combined = combineShapes(shapes);
    if (!combined.isOk) return Result.err(combined.error);
    return Result.ok({ shape: combined.value, faceIds: faceIds.flat(), edgeIds: edgeIds.flat() });
}

/**
 * Fuses touching swept prisms into one solid with kernel history, mapping the
 * merged ids back per prism. Returns undefined when the fuse does not apply or
 * fails — the caller then combines the prisms into a compound.
 */
function fuseSweptPrisms(
    featureId: string,
    shapes: IShape[],
    faceIds: string[][],
    edgeIds: string[][],
): Result<{ shape: IShape; faceIds: string[]; edgeIds: string[] }> | undefined {
    if (shapes.length <= 1 || !anyPairTouches(shapes) || shapeFactory.booleanFuseTracked === undefined) {
        return undefined;
    }
    const fused = shapeFactory.booleanFuseTracked([shapes[0]], shapes.slice(1));
    if (!fused.isOk) return undefined;
    const { edgeMap, faceMap } = completeTrackedHistory(shapes, fused.value);
    const merged = {
        shape: fused.value.shape,
        faceIds: mapFusedIds(featureId, faceIds, faceMap),
        edgeIds: mapFusedIds(featureId, edgeIds, edgeMap),
    };
    shapes.forEach((x) => {
        x.dispose();
    });
    return Result.ok(merged);
}

/**
 * Press-pull with join/cut/intersect on the tracked path: the swept prism combines
 * with the chain input via the tracked boolean, so the body's own face ids survive
 * past this feature and later press-pulls still resolve by id. The tool's sub-shapes
 * get positional feature-scoped ids — the sweep is deterministic per source-face set,
 * and its faces are new geometry either way (they realign when the source-face set
 * changes, the usual feature-scoped trade-off). Returns undefined when a tracking
 * capability is missing (the caller falls back to the plain path).
 */
function pressPullOperationTracked(
    feature: ExtrudeFeatureData & { source: NonNullable<ExtrudeFeatureData["source"]> },
    context: FeatureContext,
    extents: ResolvedExtents,
    startOffset: number,
): Result<IShape> | undefined {
    const tracking = context.tracking;
    const tracked = feature.operation === undefined ? undefined : trackedBoolean(feature.operation);
    if (tracking === undefined || tracked === undefined) return undefined;
    if (context.input === undefined) {
        return Result.err("Extrude join/cut/intersect requires a preceding feature");
    }
    const built = extrudeFromSourceFaces(feature, context, extents, startOffset);
    if (!built.isOk) return Result.err(built.error);
    try {
        const result = tracked([context.input], [built.value]);
        if (!result.isOk) return Result.err(result.error);
        const valid = validateBooleanResult(Result.ok(result.value.shape));
        if (!valid.isOk) return valid;
        const tool = {
            faceIds: (built.value.findSubShapes(ShapeTypes.face) as IFace[]).map(
                (_, index) => `${feature.id}:tool:f${index}`,
            ),
            edgeIds: (built.value.findSubShapes(ShapeTypes.edge) as IEdge[]).map(
                (_, index) => `${feature.id}:tool:e${index}`,
            ),
        };
        const { edgeMap, faceMap } = completeTrackedHistory([context.input, built.value], result.value);
        trackOperation(feature.id, context.input, tracking, tool, { ...result.value, edgeMap, faceMap });
        return Result.ok(result.value.shape);
    } finally {
        // The prism is an intermediate input — the kernel reads it eagerly.
        built.value.dispose();
    }
}

/**
 * Join/cut/intersect on the tracked path: profiles are swept with kernel history
 * (sketch-scoped ids), then combined with the chain input via the tracked boolean —
 * downstream edge refs (fillet/chamfer) keep their stable ids across rebuilds instead
 * of re-matching geometrically, where a large sketch edit strands them between
 * look-alike candidates. Returns undefined when a tracking capability is missing
 * (the caller falls back to the plain path).
 */
function extrudeOperationTracked(
    feature: ExtrudeFeatureData,
    context: FeatureContext,
    extents: ResolvedExtents,
    startOffset: number,
): Result<IShape> | undefined {
    const tracking = context.tracking;
    const tracked = trackedBoolean(feature.operation!);
    if (tracking === undefined || tracked === undefined) return undefined;
    const input = context.input;
    if (input === undefined) {
        return Result.err("Extrude join/cut/intersect requires a preceding feature");
    }
    const resolved = resolveSketchProfiles(feature, context);
    if (!resolved.isOk) return Result.err(resolved.error);

    const sides = extents.sidesAlong(resolved.value.sketch.plane.normal);
    if (!canSweepTracked(sides)) return undefined;
    const offsetVec = resolved.value.sketch.plane.normal.multiply(feature.startFace ? 0 : startOffset);
    const tool = sweepProfiles(feature, resolved.value.sketch, sides, resolved.value.profiles, offsetVec);
    if (!tool.isOk) return Result.err(tool.error);
    try {
        return applyTrackedOperation(feature.id, input, tracking, tracked, tool.value);
    } finally {
        // The prism is an intermediate input — the kernel reads it eagerly.
        tool.value.shape.dispose();
    }
}

/** Combines the swept prism with the chain input and records the resulting id map. */
function applyTrackedOperation(
    featureId: string,
    input: IShape,
    tracking: ShapeTracking,
    tracked: TrackedMethod,
    tool: { shape: IShape; faceIds: string[]; edgeIds: string[] },
): Result<IShape> {
    const result = tracked([input], [tool.shape]);
    if (!result.isOk) return Result.err(result.error);
    const valid = validateBooleanResult(Result.ok(result.value.shape));
    if (!valid.isOk) return valid;

    const { edgeMap, faceMap } = completeTrackedHistory([input, tool.shape], result.value);
    trackOperation(featureId, input, tracking, tool, { ...result.value, edgeMap, faceMap });
    return Result.ok(result.value.shape);
}

/** Fills the tracking outputs from the operation's boolean history (see `mapOperationIds`). */
function trackOperation(
    featureId: string,
    input: IShape,
    tracking: ShapeTracking,
    tool: { faceIds: string[]; edgeIds: string[] },
    result: TrackedShape,
): void {
    tracking.outputFaceIds = mapOperationIds(
        featureId,
        input,
        tracking.inputFaceIds,
        tool.faceIds,
        result.faceMap,
        ShapeTypes.face,
        result.faceAncestors,
    );
    tracking.outputEdgeIds = mapOperationIds(
        featureId,
        input,
        tracking.inputEdgeIds,
        tool.edgeIds,
        result.edgeMap,
        ShapeTypes.edge,
        result.edgeAncestors,
    );
}

/**
 * Sweeps one profile with kernel history and maps that history to stable ids.
 *
 * - **Bottom edges** — the profile's edges seed sketch-scoped ids; the prism's bottom edges are
 *   identical to them.
 * - **Bottom face** — each profile face seeds one id, which prism history propagates to the
 *   bottom face (also identical to the profile).
 * - **Top face** — has no sweep history at all (it is neither the identical bottom nor an
 *   edge-generated side), so the kernel reports it directly through `capFaces` (LastShape) and
 *   it takes the profile's synthetic `:top` seed. A positional feature-scoped id would realign
 *   onto another face when the sketch's structure changes. A kernel predating that channel
 *   falls back to the unique-history-less-face heuristic.
 * - **Side faces** — generated from profile edges, so they take that edge's seed; a rebuild that
 *   re-enumerates faces (a mirrored profile) therefore cannot realign them.
 * - **Anything the sweep history does not cover** gets a feature-scoped id.
 * - **`seedSuffix`** keeps the mirrored half of a symmetric sweep from duplicating the first
 *   half's ids.
 */
function sweepProfileTracked(
    feature: ExtrudeFeatureData,
    sketch: SketchNode,
    side: SweepSide,
    profile: ResolvedProfile,
    offsetVec: XYZ,
    seedSuffix = "",
): Result<{ shape: IShape; faceIds: string[]; edgeIds: string[] }> {
    const owned: IFace[] = [];
    try {
        const face = translateProfileFace(profile, offsetVec, owned);
        const result = sweepSideTracked(face, side);
        if (!result.isOk) return Result.err(result.error);
        const seed = `sketch:${sketch.id}:${profile.seed}${seedSuffix}`;
        const faceEdges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
        // Entity-derived edge seeds survive wire re-enumeration (see profileEdgeSeeds).
        const edgeSeeds = profileEdgeSeeds(face, seed, faceEdges);
        const featureId = `${feature.id}${seedSuffix}`;
        // The completed face map keeps the top-face seeding below unambiguous: a
        // kernel-missed bottom face would otherwise look like a second history-less
        // candidate.
        const { edgeMap, faceMap } = completeTrackedHistory([face], result.value, {
            inputEdges: faceEdges,
            inputFaces: [face],
        });
        const faceIds = trackedFaceIds(featureId, [seed], edgeSeeds, faceMap, result.value.faceEdgeMap);
        seedTopFace(faceIds, seed, faceMap, result.value.faceEdgeMap, result.value.capFaces ?? []);
        const edgeIds = trackedIds(featureId, edgeSeeds, edgeMap);
        return Result.ok({ shape: result.value.shape, faceIds, edgeIds });
    } finally {
        owned.forEach((x) => x.dispose());
    }
}

/**
 * The profile face translated to the feature's start offset, registered so the edge
 * enumeration stays entity-derived.
 *
 * A translated copy is a fresh object: it is neither the WeakMap key of the original
 * profile face nor in its sub-shape parent chain, so without re-registering, a start offset
 * would demote every edge seed to a positional ordinal.
 */
function translateProfileFace(profile: ResolvedProfile, offsetVec: XYZ, owned: IFace[]): IFace {
    const face = translateFace(profile.face, offsetVec, owned);
    if (face !== profile.face) {
        const entities = profileEdgeEntityIds(profile.face);
        if (entities !== undefined) registerProfileEdgeEntities(face, entities);
    }
    return face;
}

/**
 * Seeds the top face's id in place. The top face is the profile's other sweep image, and the
 * kernel reports it directly (the sweep's LastShape) — authoritative, so the history-less
 * heuristic must not run when a cap is reported (it misidentifies when several faces lack
 * history). The heuristic remains for kernels predating that channel; it seeds only a unique
 * history-less face, so an ambiguous report keeps the positional fallback.
 */
function seedTopFace(
    faceIds: string[],
    seed: string,
    faceMap: readonly number[],
    faceEdgeMap: readonly number[] | undefined,
    capFaces: readonly number[],
): void {
    if (capFaces.length > 0) {
        for (const index of capFaces) {
            if (index >= 0 && index < faceIds.length) faceIds[index] = `${seed}:top`;
        }
        return;
    }
    const candidates = faceIds.flatMap((_, index) =>
        faceMap[index] < 0 && (faceEdgeMap?.[index] ?? -1) < 0 ? [index] : [],
    );
    if (candidates.length === 1) faceIds[candidates[0]] = `${seed}:top`;
}

registerFeature("extrude", extrudeHandler);
