// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@spicy3d/core";

/**
 * Cancellation and the soft time budget of the modeling programs (`run_program`,
 * `run_parametric`). Kernel calls run synchronously on the main thread (docs/kernel.md): a
 * running op cannot be interrupted, so the programs check the call's signal between ops and
 * note ops that ran over `Config.slowOpWarningSeconds`, which the next MCP tool result reports.
 */

/** Throws "cancelled …" when the call was cancelled; the program's transaction rolls back. */
export function throwIfCancelled(signal: AbortSignal | undefined, index: number, method: string): void {
    if (!signal?.aborted) return;
    throw new Error(`cancelled before op ${index} ("${method}"); the whole program was rolled back`);
}

/**
 * Warnings noted since the last tool result. The MCP server (mcp/server.ts) is the only caller of
 * the tool handlers and the only consumer: it drains them into every result. A new caller of the
 * handlers (an in-page chat agent, say) must drain them into its own results too, with
 * `takeSlowOpWarnings`, or its slow ops surface on an unrelated later MCP call.
 */
const pending: string[] = [];

/** Records one op's wall time; over the budget it becomes a warning for the next tool result. */
export function noteOpDuration(method: string, milliseconds: number): void {
    const budget = Config.instance.slowOpWarningSeconds;
    if (!(milliseconds > budget * 1000)) return;
    const seconds = Math.round(milliseconds / 1000);
    pending.push(
        `Warning: op "${method}" took ${seconds} s (slow-op budget ${budget} s). A running kernel op cannot be interrupted: the tab and every other tool call waited for it. Prefer a cheaper variant (load_skill modeling-recipes).`,
    );
}

/** Runs `op`, noting its wall time whether it returns or throws. */
export function timeOp<T>(method: string, op: () => T): T {
    const start = performance.now();
    try {
        return op();
    } finally {
        noteOpDuration(method, performance.now() - start);
    }
}

/** Warnings already delivered once, repeated on the following result. */
let delivered: string[] = [];

/**
 * The warnings for the result about to be sent: those noted since the last result, plus — once
 * more, marked as such — those the previous result carried. The call that ran a slow op is often
 * the one whose answer never arrived (the relay stopped waiting), so the next result repeats it.
 */
export function takeSlowOpWarnings(): string[] {
    const repeated = delivered.map((w) => `(earlier call) ${w}`);
    delivered = pending.splice(0, pending.length);
    return [...repeated, ...delivered];
}
