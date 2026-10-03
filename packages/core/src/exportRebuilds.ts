// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DataExportError } from "./dataExchange";
import { DocumentRebuilds } from "./documentRebuilds";
import { Result } from "./foundation/result";
import type { VisualNode } from "./model";
import { ShapeNode } from "./model/shapeNode";

/**
 * Waits until the nodes' documents have no pending rebuild, or until `signal` aborts (then
 * `rebuild-pending`). Hidden bodies may never have been evaluated: every shape is demanded
 * before awaiting, since a pending getter returns last-good (or an initial error), not export data.
 */
export async function awaitExportRebuilds(
    nodes: readonly VisualNode[],
    signal?: AbortSignal,
): Promise<Result<void, DataExportError>> {
    for (const node of nodes) if (node instanceof ShapeNode) void node.shape;
    const documents = [...new Set(nodes.map((node) => node.document))];
    const settled = Promise.all(documents.map((document) => DocumentRebuilds.settled(document)));
    if (signal) {
        let stop!: () => void;
        const aborted = new Promise<void>((resolve) => {
            stop = resolve;
        });
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
        try {
            await Promise.race([settled, aborted]);
        } finally {
            signal.removeEventListener("abort", stop);
        }
    } else {
        await settled;
    }
    const pending = documents.filter((document) => DocumentRebuilds.pending(document));
    if (pending.length === 0) return Result.ok(undefined);
    const features = pending.flatMap((document) => DocumentRebuilds.status(document).featureIndexes);
    return Result.err({
        kind: "rebuild-pending",
        message: `the model is still rebuilding${features.length ? ` (at feature ${features.join(", ")})` : ""}`,
    });
}
