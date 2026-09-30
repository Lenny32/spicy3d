// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Observable } from "../foundation/observer";

export type KernelStatus = "ok" | "crashed";

/**
 * The geometry kernel stopped working (an abort it did not survive, a trap): its module is dead and
 * every shape handle into it with it, so it cannot be recovered in this page. Thrown (or returned as `Result.err(message)`) by every kernel
 * call after the crash, with one stable message.
 */
export class KernelCrashedError extends Error {
    constructor(readonly reason: string) {
        super(kernelCrashedMessage(reason));
        this.name = "KernelCrashedError";
    }
}

export function kernelCrashedMessage(reason: string): string {
    return `Kernel crashed (${reason}); reload the page`;
}

/**
 * Whether the geometry kernel (the WASM module) still works. SDK-free, so every module can read it
 * without depending on the kernel: the kernel package reports the crash (`markCrashed`), tools
 * refuse to start work, the UI offers a reload. Observable (`status`). A crash is final: the
 * state never goes back to `ok` in this page (except `reset` in tests).
 */
export class KernelState extends Observable {
    static readonly current: KernelState = new KernelState();

    private crashReason: string | undefined;

    get status(): KernelStatus {
        return this.getPrivateValue("status", "ok");
    }

    /** What broke it (the first failure's message); `undefined` while the kernel works. */
    get reason(): string | undefined {
        return this.crashReason;
    }

    get isCrashed(): boolean {
        return this.status === "crashed";
    }

    /** The stable error text of every kernel call after the crash; `undefined` while it works. */
    get message(): string | undefined {
        const reason = this.reason;
        return this.isCrashed && reason !== undefined ? kernelCrashedMessage(reason) : undefined;
    }

    /** Records the crash; only the first one counts. `true` when this call flipped the state. */
    markCrashed(reason: string): boolean {
        if (this.isCrashed) return false;
        this.crashReason = reason || "unknown error";
        this.setProperty("status", "crashed");
        return true;
    }

    /** Throws the {@link KernelCrashedError} once the kernel crashed. */
    throwIfCrashed(): void {
        const reason = this.reason;
        if (this.isCrashed && reason !== undefined) throw new KernelCrashedError(reason);
    }

    /** Tests only: a fresh kernel. */
    reset(): void {
        this.crashReason = undefined;
        this.setProperty("status", "ok");
    }
}
