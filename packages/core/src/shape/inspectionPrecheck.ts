// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import { I18n } from "../i18n";
import type { IInspectionPrecheck, IShape } from "./shape";
import type { IShapeFactory } from "./shapeFactory";

/** Shared by analysis and MCP; the owner keeps synchronous accesses in its mutation scope. */
export async function precheckInspectionShapes(
    shapes: IShape[],
    factory: IShapeFactory,
    signal?: AbortSignal,
    owned: <T>(action: () => T) => T = (action) => action(),
): Promise<Result<void>> {
    if (signal?.aborted) return Result.err(I18n.translate("analysis.inspectionCancelled"));
    if (owned(() => shapes.some((shape) => !shape.checkShape())))
        return Result.err(I18n.translate("analysis.inspectionInvalid"));
    for (const shape of new Set(shapes)) {
        if (signal?.aborted) return Result.err(I18n.translate("analysis.inspectionCancelled"));
        if (
            !owned(
                () => (shape as IShape & Partial<IInspectionPrecheck>).needsInspectionSelfIntersectionCheck,
            )
        )
            continue;
        const bounded = factory.boundedOperations;
        if (!bounded?.shapeQuery) return Result.err(I18n.translate("analysis.inspectionWorkerRequired"));
        const pending = owned(() => bounded.shapeQuery({ method: "checkSelfIntersection", shape }, signal));
        try {
            await pending.ready;
            const result = owned(() => pending.take());
            if (signal?.aborted) return Result.err(I18n.translate("analysis.inspectionCancelled"));
            if (!result.isOk) {
                const timeout = /timed out(?: after (\d+) ms)?/i.exec(result.error);
                return Result.err(
                    timeout
                        ? timeout[1]
                            ? I18n.translate("analysis.inspectionTimedOutAfter{0}", timeout[1])
                            : I18n.translate("analysis.inspectionTimedOut")
                        : result.error,
                );
            }
            if (!result.value) return Result.err(I18n.translate("analysis.inspectionIntersects"));
        } finally {
            pending.cancel();
        }
    }
    return Result.ok(undefined);
}
