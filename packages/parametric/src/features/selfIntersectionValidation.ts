// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IAsyncShapeOperation, type IShape, Result, ShapeTypes } from "@spicy3d/core";
import type { FeatureContext } from "./feature";

export const SELF_INTERSECTION_SKIPPED =
    "Self-intersection check skipped in synchronous evaluation (result unknown; rebuild validates in worker)";

/** Cheap validity gates always apply. The analyzer must never run in the page. */
export function validateSelfIntersection(
    shape: IShape,
    warn?: (message: string) => void,
    defer?: (shape: IShape, failure?: string) => void,
    failure = "Shape intersects itself",
): Result<boolean> {
    if (!shape.checkShape()) return Result.err("Shape is invalid");
    const volume = shape.volume();
    const solids = shape.findSubShapes(ShapeTypes.solid);
    try {
        if (!Number.isFinite(volume) || (solids.length > 0 && volume <= 0))
            return Result.err("Shape has invalid volume");
    } finally {
        for (const solid of solids) solid.dispose();
    }
    if (defer) defer(shape, failure);
    else warn?.(SELF_INTERSECTION_SKIPPED);
    return Result.ok(true);
}

/** Captures intermediate replicas before a handler disposes them; owns the output until acceptance. */
export function prepareValidatedFeature(
    evaluate: (context: FeatureContext) => Result<IShape>,
    context: FeatureContext,
): IAsyncShapeOperation<IShape> {
    const checks: IAsyncShapeOperation<boolean>[] = [];
    const failures = new Map<IAsyncShapeOperation<boolean>, string>();
    let result: Result<IShape>;
    try {
        result = evaluate({
            ...context,
            deferSelfIntersection: shapeFactory.boundedOperations?.shapeQuery
                ? (shape, failure) => {
                      try {
                          const bounded = shapeFactory.boundedOperations;
                          if (!bounded?.shapeQuery)
                              throw new Error("Self-intersection validation requires a bounded worker");
                          const check = bounded.shapeQuery({ method: "checkSelfIntersection", shape });
                          checks.push(check);
                          failures.set(check, failure ?? "Shape intersects itself");
                      } catch (error) {
                          const message = error instanceof Error ? error.message : String(error);
                          checks.push({
                              ready: Promise.resolve(),
                              canFallback: false,
                              cancel: () => {},
                              take: () => Result.err(message),
                          });
                      }
                  }
                : undefined,
        });
    } catch (error) {
        for (const check of checks) check.cancel();
        result = Result.err(error instanceof Error ? error.message : String(error));
    }
    if (!result.isOk) for (const check of checks) check.cancel();
    let consumed = false;
    const disposeOutput = () => {
        if (result.isOk && result.value !== context.input) result.value.dispose();
    };
    return {
        canFallback: false,
        ready: result.isOk
            ? Promise.all(checks.map((check) => check.ready)).then(() => {})
            : Promise.resolve(),
        cancel: () => {
            for (const check of checks) check.cancel();
            if (!consumed) {
                consumed = true;
                disposeOutput();
            }
        },
        take: () => {
            if (consumed) return Result.err("Self-intersection validation cancelled");
            consumed = true;
            if (!result.isOk) return result;
            for (const check of checks) {
                const clean = check.take();
                if (!clean.isOk) {
                    // Cancellation belongs to the superseded run, never to its cache.
                    if (check.cancelled) {
                        disposeOutput();
                        return Result.err(clean.error);
                    }
                    const timeout = /timed out after (\d+) ms/.exec(clean.error);
                    context.warn?.(
                        timeout
                            ? I18n.translate("warning.selfIntersection.timeout{0}", timeout[1])
                            : I18n.translate("warning.selfIntersection.unknown"),
                    );
                } else if (!clean.value) {
                    disposeOutput();
                    return Result.err(failures.get(check) ?? "Shape intersects itself");
                }
            }
            return result;
        },
    };
}
