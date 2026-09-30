// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelState } from "@spicy3d/core";
import type { Tool } from "../llm/types";

/**
 * The tools that build or rebuild geometry (directly, or through a parametric rebuild / an
 * export / opening a document). Once the kernel crashes they refuse to start until
 * main-kernel recovery succeeds or the page reloads. The recovery tool retains normal FIFO ordering.
 */
export const KERNEL_TOOLS: ReadonlySet<string> = new Set([
    "run_program",
    "run_parametric",
    "set_node_properties",
    "document_variables",
    "transform_node",
    "delete_node",
    "undo",
    "redo",
    "export_nodes",
    "spicy3d_open_document",
]);

/** `{"kernel": "crashed", "kernelError": …}` once the kernel crashed, nothing while it works. */
export function kernelStateInfo(): { kernel: "crashed"; kernelError: string } | undefined {
    const message = KernelState.current.message;
    return message === undefined ? undefined : { kernel: "crashed", kernelError: message };
}

/** A kernel tool answers the crash as its error, without starting work; others are unchanged. */
export function guardKernelTool(tool: Tool): Tool {
    if (!KERNEL_TOOLS.has(tool.name)) return tool;
    return {
        ...tool,
        handler: async (args, signal, context) => {
            const message = KernelState.current.message;
            if (message !== undefined) return JSON.stringify({ error: message });
            return tool.handler(args, signal, context);
        },
    };
}
