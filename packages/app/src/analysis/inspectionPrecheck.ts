// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IInspectionPrecheck, type IShape, Result } from "@spicy3d/core";

/** Match the MCP inspection guard before entering the synchronous inspection binding. */
export async function inspectionPrecheck(shapes: IShape[], signal: AbortSignal): Promise<Result<void>> {
    if (shapes.some((shape) => !shape.checkShape())) return Result.err("Inspection input is invalid");
    for (const shape of new Set(shapes)) {
        if (signal.aborted) return Result.err("Inspection cancelled");
        if (!(shape as IShape & Partial<IInspectionPrecheck>).needsInspectionSelfIntersectionCheck) continue;
        const bounded = shapeFactory.boundedOperations;
        if (!bounded) return Result.err("Inspection requires a bounded geometry worker");
        const pending = bounded.shapeQuery({ method: "checkSelfIntersection", shape }, signal);
        try {
            await pending.ready;
            const result = pending.take();
            if (signal.aborted) return Result.err("Inspection cancelled");
            if (!result.isOk)
                return Result.err(
                    /timed out/i.test(result.error)
                        ? I18n.translate("analysis.inspectionTimedOut")
                        : result.error,
                );
            if (!result.value) return Result.err("Inspection input intersects itself");
        } finally {
            pending.cancel();
        }
    }
    return Result.ok(undefined);
}
