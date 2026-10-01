// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IShapeFactory,
    Matrix4,
    PerformanceTrace,
    Result,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    type TrackedShape,
    volumeTolerance,
} from "@spicy3d/core";
import {
    type BooleanFeatureData,
    type BooleanOperation,
    completeTrackedHistory,
    type FeatureContext,
    type FeatureHandler,
    type IShapeHost,
    registerFeature,
} from "./feature";
import { captureBooleanIds, mapBooleanIds } from "./operationIds";

const DISPLAYS: Record<BooleanOperation, I18nKeys> = {
    fuse: "command.feature.fuse",
    cut: "command.feature.cut",
    common: "command.feature.common",
};

const ICONS: Record<BooleanOperation, string> = {
    fuse: "icon-booleanFuse",
    cut: "icon-booleanCut",
    common: "icon-booleanCommon",
};

const booleanHandler: FeatureHandler<BooleanFeatureData> = {
    display: (feature) => DISPLAYS[feature.operation],
    icon: (feature) => ICONS[feature.operation],

    nodeIds: (feature) => feature.toolIds,

    parameters: (feature) => [
        { key: "consumeTools", display: "features.consumeTools", value: feature.consumeTools ?? true },
    ],

    setParameter: (feature, key, value) =>
        key === "consumeTools" ? { ...feature, consumeTools: value === true || value === "true" } : feature,

    prepareAsync(feature, context) {
        const factory = shapeFactory.asyncOperations;
        const { input, tracking } = context;
        if (!factory || factory.available === false || !input || !tracking) return undefined;
        const tools = collectTools(feature, context.document);
        if (!tools.isOk) return undefined;
        const faces = captureBooleanIds(
            feature.id,
            input,
            tracking.inputFaceIds,
            tools.value,
            ShapeTypes.face,
        );
        const edges = captureBooleanIds(
            feature.id,
            input,
            tracking.inputEdgeIds,
            tools.value,
            ShapeTypes.edge,
        );
        const toolShapes = toolShapesInHostSpace(tools.value, context.host);
        const owned = toolShapes.filter((shape, index) => shape !== tools.value[index].shape.unchecked());
        let pending: ReturnType<typeof factory.booleanTracked>;
        try {
            pending = factory.booleanTracked(feature.operation, [input], toolShapes, {
                mesh: context.meshResult,
            });
        } finally {
            // Capability preparation captures immutable snapshots synchronously, so transformed copies
            // and borrowed sketch/tool geometry never need to survive the await.
            for (const shape of owned) shape.dispose();
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
                    return booleanHandler.evaluate(feature, context);
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
                    tracking.outputFaceIds = faces(history.faceMap, result.faceAncestors);
                    tracking.outputEdgeIds = edges(history.edgeMap, result.edgeAncestors);
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
        if (context.input === undefined) {
            return Result.err("boolean requires a preceding feature");
        }
        const tools = collectTools(feature, context.document);
        if (!tools.isOk) return Result.err(tools.error);
        const tracked = TRACKED[feature.operation](shapeFactory);
        const toolShapes = toolShapesInHostSpace(tools.value, context.host);
        // `transformedMul` copies are intermediate inputs — the kernel reads them
        // eagerly, so dispose them once the operation returns.
        const owned = toolShapes.filter((x, i) => x !== tools.value[i].shape.unchecked());
        try {
            if (context.tracking !== undefined && tracked !== undefined) {
                return evaluateTracked(feature, context, tools.value, toolShapes, tracked);
            }
            const result = untrackedBoolean(feature.operation, context.input, toolShapes);
            if (!result.isOk) return Result.err(booleanError(feature.operation, result.error));
            const valid = validateBooleanResult(result);
            return valid.isOk ? requireNonEmptyResult(feature.operation, context.input, valid.value) : valid;
        } finally {
            owned.forEach((x) => x.dispose());
        }
    },
};

/**
 * Tools live anywhere in the scene, but the boolean runs in the host body's local
 * space (the result renders under the host's own transform), so map each tool
 * shape by hostWorld⁻¹ · toolWorld — a moved copy cuts where it is displayed, not
 * where its shape was generated. Identity mappings reuse the raw shape.
 */
function toolShapesInHostSpace(tools: ShapeNode[], host: IShapeHost): IShape[] {
    const hostInvert = host.worldTransform().invert();
    if (hostInvert === undefined) return tools.map((x) => x.shape.unchecked()!);
    const identity = Matrix4.identity();
    return tools.map((node) => {
        const shape = node.shape.unchecked()!;
        const matrix = hostInvert.multiply(node.worldTransform());
        return matrix.equals(identity) ? shape : shape.transformedMul(matrix);
    });
}

function collectTools(feature: BooleanFeatureData, document: IDocument): Result<ShapeNode[]> {
    const tools: ShapeNode[] = [];
    for (const id of feature.toolIds) {
        const node = document.modelManager.findNode((n) => n.id === id);
        if (!(node instanceof ShapeNode)) return Result.err("Boolean tool not found");
        if (!node.shape.isOk) return Result.err("Boolean tool has no shape");
        tools.push(node);
    }
    return Result.ok(tools);
}

function untrackedBoolean(operation: BooleanOperation, input: IShape, toolShapes: IShape[]): Result<IShape> {
    switch (operation) {
        case "common":
            return shapeFactory.booleanCommon([input], toolShapes);
        case "cut":
            return shapeFactory.booleanCut([input], toolShapes);
        default:
            return shapeFactory.booleanFuse([input], toolShapes, true);
    }
}

const EMPTY_RESULT_ERRORS: Record<BooleanOperation, string> = {
    common: "Boolean common produced an empty shape: the tools do not intersect the body",
    cut: "Boolean cut produced an empty shape: the tools remove the whole body",
    fuse: "Boolean fuse produced an empty shape",
};

/**
 * The kernel's own empty-result error (`booleanFailure` in `factory.cpp`, since the V8_0_1 build).
 * Guarded by booleanEmptyResult.kernel.test.ts and parametricProgram.kernel.test.ts ("a common with
 * a disjoint tool fails …"), which fail when the kernel's wording drifts from this string.
 */
const KERNEL_EMPTY_RESULT_ERROR = "Boolean produced an empty shape";

/**
 * A kernel error as the feature reports it: the kernel's empty-result error becomes the
 * operation-specific text `requireNonEmptyResult` gives, so an agent reads one message whichever
 * layer caught the empty result (older binaries return the empty compound as a success).
 */
function booleanError(operation: BooleanOperation, error: string): string {
    return error.trim() === KERNEL_EMPTY_RESULT_ERROR ? EMPTY_RESULT_ERRORS[operation] : error;
}

/** Whether `shape` holds at least one sub-shape of `type`; the probed wrappers are disposed. */
function hasSubShape(shape: IShape, type: ShapeType): boolean {
    const found = shape.findSubShapes(type);
    found.forEach((x) => x.dispose());
    return found.length > 0;
}

/**
 * Kernels built before the V8_0_1 rebuild report a boolean whose result is an empty
 * compound as a success, so a common of disjoint bodies or a cut removing everything
 * would silently leave an empty body (the current one fails it: `booleanError`); a
 * result with vertices but no solid slips past the kernel's check either way. A solid
 * input must keep at least one solid (a shell/face input at least one face); anything
 * less is the feature's error. Only a topology walk, no validity check, so it is cheap
 * enough to run on every evaluation.
 */
function requireNonEmptyResult(operation: BooleanOperation, input: IShape, result: IShape): Result<IShape> {
    const required = [ShapeTypes.solid, ShapeTypes.face].find((type) => hasSubShape(input, type));
    // An input without faces has nothing to lose; a null result has no sub-shapes at all.
    if (required === undefined || hasSubShape(result, required)) return Result.ok(result);
    result.dispose();
    return Result.err(EMPTY_RESULT_ERRORS[operation]);
}

const TRACKED: Record<BooleanOperation, (factory: IShapeFactory) => TrackedMethod | undefined> = {
    common: (factory) => factory.booleanCommonTracked?.bind(factory),
    cut: (factory) => factory.booleanCutTracked?.bind(factory),
    fuse: (factory) => factory.booleanFuseTracked?.bind(factory),
};

export type TrackedMethod = (shape1: IShape[], shape2: IShape[]) => Result<TrackedShape>;

/** The kernel's history-tracking variant of a boolean operation, when available. */
export function trackedBoolean(operation: BooleanOperation): TrackedMethod | undefined {
    return TRACKED[operation](shapeFactory);
}

function evaluateTracked(
    feature: BooleanFeatureData,
    context: FeatureContext,
    tools: ShapeNode[],
    toolShapes: IShape[],
    tracked: TrackedMethod,
): Result<IShape> {
    const { input, tracking } = context;
    // Both are guaranteed by the caller's guards — the type just cannot see it.
    if (input === undefined || tracking === undefined) {
        return Result.err("boolean requires a preceding feature");
    }
    const result = tracked([input], toolShapes);
    if (!result.isOk) return Result.err(booleanError(feature.operation, result.error));
    const valid = validateBooleanResult(Result.ok(result.value.shape));
    if (!valid.isOk) return valid;
    const nonEmpty = requireNonEmptyResult(feature.operation, input, valid.value);
    if (!nonEmpty.isOk) return nonEmpty;
    const { edgeMap, faceMap } = completeTrackedHistory([input, ...toolShapes], result.value);
    tracking.outputFaceIds = mapBooleanIds(
        feature.id,
        input,
        tracking.inputFaceIds,
        tools,
        faceMap,
        ShapeTypes.face,
        result.value.faceAncestors,
    );
    tracking.outputEdgeIds = mapBooleanIds(
        feature.id,
        input,
        tracking.inputEdgeIds,
        tools,
        edgeMap,
        ShapeTypes.edge,
        result.value.edgeAncestors,
    );
    return Result.ok(result.value.shape);
}

registerFeature("boolean", booleanHandler);

/** Validate the result, not operands: imported tolerances may still boolean successfully. */
export function validateBooleanResult(result: Result<IShape>): Result<IShape> {
    if (!result.isOk) return result;
    const shape = result.value;
    let solids: IShape[] = [];
    let error: string | undefined;
    try {
        solids = shape.findSubShapes(ShapeTypes.solid);
        // Empty compounds must reach the operation-specific empty-result guard.
        if (!shape.checkShape()) error = "Boolean result: invalid shape (checkShape is false)";
        const tolerance = solids.length ? volumeTolerance(shape.volume(), shape.boundingBox()) : 0;
        for (const [index, solid] of solids.entries()) {
            const volume = solid.volume();
            if (!Number.isFinite(volume) || volume < -tolerance) {
                error ??= `Boolean result: solid ${index} has invalid volume (${volume} mm³)`;
            }
        }
    } catch (cause) {
        error = `Boolean result validation failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
        for (const solid of solids) solid.dispose();
    }
    if (!error) return result;
    shape.dispose();
    return Result.err(error);
}
