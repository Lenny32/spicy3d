// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    collectRebuildReport,
    type IApplication,
    type IMergeEvaluator,
    type RebuildError,
    type RebuildOptions,
    type RebuildReport,
    Result,
    type Serialized,
} from "@spicy3d/core";
import { Document } from "./document";

/**
 * The merge's validation pass evaluator (docs/merge.md): loads a version into a headless document
 * (no visual, not among the open ones), rebuilds every node and reports the failures, then
 * disposes it.
 */
export class HeadlessDocumentEvaluator implements IMergeEvaluator {
    constructor(private readonly application: IApplication) {}

    async evaluate(
        data: Serialized,
        options: RebuildOptions = {},
    ): Promise<Result<RebuildReport, RebuildError>> {
        if (options.signal?.aborted) return Result.err({ kind: "cancelled" });
        const loaded = await Document.loadHeadless(this.application, data, { signal: options.signal });
        if (!loaded.isOk && loaded.error.kind === "cancelled") return Result.err({ kind: "cancelled" });
        if (!loaded.isOk) return Result.err({ kind: "failed", message: JSON.stringify(loaded.error) });
        try {
            return await collectRebuildReport(loaded.value, options);
        } catch (error) {
            if (options.signal?.aborted) return Result.err({ kind: "cancelled" });
            return Result.err({
                kind: "failed",
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            loaded.value.dispose();
        }
    }
}
