// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IAsyncShapeOperation,
    type IShape,
    LENGTH_UNITS,
    Result,
    resolveUnitSpec,
    type Scope,
    type TrackedShape,
} from "@spicy3d/core";
import { resolveCornerSetbacks } from "./cornerSetbacks";
import { trackCornerSetback } from "./cornerSetbackTracking";
import { matchEdgeIndexes, matchEdgesAnchored } from "./edgeMatcher";
import { sameEdgeFingerprint } from "./edgeRef";
import {
    type ChamferFeatureData,
    completeTrackedHistory,
    type FeatureContext,
    type FeatureHandler,
    type FilletFeatureData,
    registerFeature,
    type ShapeTracking,
    trackedIds,
} from "./feature";
import { resolveFilletRadiusLaw } from "./radiusLaw";

interface EdgeCornerOptions<F extends FilletFeatureData | ChamferFeatureData> {
    readonly display: I18nKeys;
    readonly icon: string;
    readonly method: "fillet" | "chamfer";
    readonly parameterKey: keyof F & string;
    readonly parameterDisplay: I18nKeys;
}

/**
 * Shared handler for edge-modifying features (fillet/chamfer): edge references carry a
 * stable kernel-history id when available (matched exactly) plus a geometric
 * fingerprint fallback, re-matched against the rebuilt input on every evaluation —
 * shape indices drift when upstream features regenerate.
 */
function edgeCornerHandler<F extends FilletFeatureData | ChamferFeatureData>(
    options: EdgeCornerOptions<F>,
): FeatureHandler<F> {
    return {
        display: options.display,
        icon: options.icon,
        reselectable: true,

        nodeIds: () => [],

        parameters: (feature) =>
            feature.type === "fillet" && feature.radiusLaw !== undefined
                ? feature.radiusLaw.map((point, index) => ({
                      key: `radiusLaw.${index}`,
                      display: "fillet.lawRadius" as const,
                      value: point.radius,
                      unit: LENGTH_UNITS,
                  }))
                : [
                      {
                          key: options.parameterKey,
                          display: options.parameterDisplay,
                          value: feature[options.parameterKey] as number | string,
                          unit: LENGTH_UNITS,
                      },
                      ...(feature.type === "fillet" && feature.cornerSetbacks !== undefined
                          ? feature.cornerSetbacks.flatMap((corner, cornerIndex) =>
                                corner.distances.map((value, index) => ({
                                    key: `cornerSetbacks.${cornerIndex}.${index}`,
                                    display: "fillet.cornerSetback" as const,
                                    value,
                                    unit: LENGTH_UNITS,
                                })),
                            )
                          : []),
                  ],

        setParameter: (feature, key, value) => {
            if (
                feature.type === "fillet" &&
                feature.cornerSetbacks !== undefined &&
                key.startsWith("cornerSetbacks.")
            ) {
                const match = /^cornerSetbacks\.0\.([0-2])$/.exec(key);
                if (!match || typeof value === "boolean" || feature.cornerSetbacks.length !== 1)
                    return feature;
                const corner = feature.cornerSetbacks[0];
                const distances: [number | string, number | string, number | string] = [...corner.distances];
                distances[Number(match[1])] = value;
                return { ...feature, cornerSetbacks: [{ ...corner, distances }] };
            }
            if (
                feature.type === "fillet" &&
                feature.radiusLaw !== undefined &&
                key.startsWith("radiusLaw.")
            ) {
                const index = Number(key.slice("radiusLaw.".length));
                if (!Number.isInteger(index) || index < 0 || index >= feature.radiusLaw.length)
                    return feature;
                return {
                    ...feature,
                    radiusLaw: feature.radiusLaw.map((point, i) =>
                        i === index ? { ...point, radius: value } : point,
                    ),
                };
            }
            return { ...feature, [key]: value };
        },

        applyResolvedRefs: (feature, { resolvedEdges }) => {
            if (resolvedEdges === undefined) return feature;
            if (feature.type !== "fillet" || feature.cornerSetbacks === undefined)
                return { ...feature, edges: resolvedEdges };
            const corners = feature.cornerSetbacks.map((corner) => {
                const edges = corner.edges.map((ref) => {
                    const matches = feature.edges.flatMap((selected, index) =>
                        (
                            selected.edgeId && ref.edgeId
                                ? selected.edgeId === ref.edgeId && selected.splitPiece === ref.splitPiece
                                : sameEdgeFingerprint(selected, ref)
                        )
                            ? [index]
                            : [],
                    );
                    return matches.length === 1 ? (resolvedEdges[matches[0]] ?? ref) : ref;
                }) as typeof corner.edges;
                return { ...corner, edges };
            });
            return { ...feature, edges: resolvedEdges, cornerSetbacks: corners };
        },

        prepareAsync(feature, context) {
            if (feature.type !== "fillet" || feature.cornerSetbacks === undefined) return undefined;
            const failed = (message: string): IAsyncShapeOperation<IShape> => ({
                ready: Promise.resolve(),
                cancel: () => {},
                canFallback: false,
                take: () => Result.err(message),
            });
            const { input, tracking } = context;
            if (!input || !tracking)
                return failed("Corner setbacks require a preceding shape with source ancestry");
            const distances = resolveCornerSetbacks(feature, context.scope);
            if (!distances.isOk) return failed(distances.error);
            const radius = resolveUnitSpec(feature.radius, context.scope, LENGTH_UNITS);
            if (!radius.isOk) return failed(radius.error);
            const indexes = matchCornerEdges(input, feature, tracking);
            if (!indexes.isOk) return failed(indexes.error);
            const factory = shapeFactory.asyncOperations;
            if (!factory || factory.available === false || !factory.cornerSetbackTracked)
                return failed("Corner setbacks require the geometry worker; it is unavailable");
            const operation = factory.cornerSetbackTracked(
                input,
                indexes.value,
                radius.value,
                distances.value,
                {
                    mesh: context.meshResult,
                },
            );
            if (!operation) return failed("Corner setback worker preparation is unavailable");
            return {
                ready: operation.ready,
                cancel: () => operation.cancel(),
                canFallback: false,
                take: () => {
                    const answer = operation.take();
                    if (!answer.isOk) return Result.err(answer.error);
                    const { inputs, result } = answer.value;
                    let accepted = false;
                    try {
                        const tracked = trackCornerSetback(feature.id, tracking, indexes.value, result);
                        accepted = tracked.isOk;
                        return tracked;
                    } finally {
                        for (const shape of inputs) shape.dispose();
                        if (!accepted) result.shape.dispose();
                    }
                },
            };
        },

        evaluate(feature, context: FeatureContext): Result<IShape> {
            if (feature.type === "fillet" && feature.cornerSetbacks !== undefined)
                return Result.err(
                    "Corner setbacks require explicit cancelable worker recomputation; synchronous evaluation is unavailable",
                );
            const input = context.input;
            if (input === undefined) {
                return Result.err(`${feature.type} requires a preceding feature`);
            }
            const tracking = context.tracking;
            if (feature.type === "fillet" && feature.radiusLaw !== undefined) {
                const law = resolveFilletRadiusLaw(feature.radiusLaw, context.scope);
                if (!law.isOk) return Result.err(law.error);
                const indexes = matchCornerEdges(input, feature, tracking);
                if (!indexes.isOk) return Result.err(indexes.error);
                if (tracking !== undefined && shapeFactory.filletVariableRadiusTracked !== undefined) {
                    const result = shapeFactory.filletVariableRadiusTracked(input, indexes.value, law.value);
                    return result.isOk
                        ? trackEdgeCorner(feature.id, tracking, input, result.value)
                        : Result.err(result.error);
                }
                return (
                    shapeFactory.filletVariableRadius?.(input, indexes.value, law.value) ??
                    Result.err("Variable-radius fillets are not available in this kernel build")
                );
            }
            const parameter = resolveCornerParameter(feature, context.scope, options);
            if (!parameter.isOk) return Result.err(parameter.error);
            const indexes = matchCornerEdges(input, feature, tracking);
            if (!indexes.isOk) return Result.err(indexes.error);
            return applyEdgeCorner(feature, options, input, indexes.value, parameter.value, tracking);
        },
    };
}

/** The feature's radius/distance as a concrete length: the stored parameter resolved in the document's scope. */
function resolveCornerParameter<F extends FilletFeatureData | ChamferFeatureData>(
    feature: F,
    scope: Scope,
    options: EdgeCornerOptions<F>,
): Result<number> {
    return resolveUnitSpec(feature[options.parameterKey] as number | string, scope, LENGTH_UNITS);
}

/**
 * The feature's stored edge refs as indexes into the rebuilt input — anchored to the tracked
 * input ids when the body supplies tracking, geometric matching otherwise. Anchored matching
 * also reports the re-anchored refs on the tracking for the body's write-back (see
 * ShapeTracking.resolvedEdges).
 */
function matchCornerEdges(
    input: IShape,
    feature: FilletFeatureData | ChamferFeatureData,
    tracking: ShapeTracking | undefined,
): Result<number[]> {
    if (tracking === undefined) {
        return matchEdgeIndexes(input, feature.edges);
    }
    const matched = matchEdgesAnchored(input, feature.edges, tracking.inputEdgeIds);
    if (!matched.isOk) return Result.err(matched.error);
    // Re-anchored refs for the body's write-back (see ShapeTracking.resolvedEdges).
    tracking.resolvedEdges = matched.value.anchors;
    return Result.ok(matched.value.indexes);
}

/**
 * Applies the corner to `indexes`, preferring the kernel's tracked variant so the result's
 * history can fill the body's output ids (see `trackEdgeCorner`). The plain variant is the
 * fallback whenever the body or the kernel offers no tracking.
 */
function applyEdgeCorner<F extends FilletFeatureData | ChamferFeatureData>(
    feature: F,
    options: EdgeCornerOptions<F>,
    input: IShape,
    indexes: number[],
    parameter: number,
    tracking: ShapeTracking | undefined,
): Result<IShape> {
    const tracked = options.method === "fillet" ? shapeFactory.filletTracked : shapeFactory.chamferTracked;
    if (tracking === undefined || tracked === undefined) {
        return shapeFactory[options.method](input, indexes, parameter);
    }
    const result = tracked(input, indexes, parameter);
    if (!result.isOk) return Result.err(result.error);
    return trackEdgeCorner(feature.id, tracking, input, result.value);
}

/** Fills the tracking outputs from the corner's kernel history (see `trackedIds`). */
function trackEdgeCorner(
    featureId: string,
    tracking: ShapeTracking,
    input: IShape,
    result: TrackedShape,
): Result<IShape> {
    const { edgeMap, faceMap } = completeTrackedHistory([input], result);
    tracking.outputFaceIds = trackedIds(featureId, tracking.inputFaceIds, faceMap);
    tracking.outputEdgeIds = trackedIds(featureId, tracking.inputEdgeIds, edgeMap);
    return Result.ok(result.shape);
}

registerFeature(
    "fillet",
    edgeCornerHandler<FilletFeatureData>({
        display: "command.feature.fillet",
        icon: "icon-fillet",
        method: "fillet",
        parameterKey: "radius",
        parameterDisplay: "circle.radius",
    }),
);

registerFeature(
    "chamfer",
    edgeCornerHandler<ChamferFeatureData>({
        display: "command.feature.chamfer",
        icon: "icon-chamfer",
        method: "chamfer",
        parameterKey: "distance",
        parameterDisplay: "common.length",
    }),
);
