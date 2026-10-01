// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelRecovery } from "@spicy3d/core";
import type { Tool } from "../llm/types";

/** A normal serialized mutation tool; recovery never receives a metadata/control queue bypass. */
export function buildRecoveryTools(): Tool[] {
    if (!KernelRecovery.current.available) return [];
    return [
        {
            name: "recover_kernel",
            description:
                "Recover a crashed main geometry kernel without reloading the tab. Reconstruct every open document from a healthy checkpoint matching its current committed history position, preserving document/feature IDs and committed unsaved edits. Success clears undo/redo for every open document and invalidates standalone native refs; scene-backed refs re-derive against reconstructed nodes. Interrupted uncommitted edits and queued modeling jobs are cancelled. A crash during a post-commit rebuild can leave no matching checkpoint; in that case use Reload to reopen saved content. Preparation failure keeps the previous content/history and reports an error. This tool uses the normal page mutation FIFO.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const result = await KernelRecovery.current.recover();
                return JSON.stringify(result.isOk ? result.value : { error: result.error });
            },
        },
    ];
}
