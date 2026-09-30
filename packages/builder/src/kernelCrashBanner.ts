// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelRecovery, KernelState, PubSub, type Result } from "@spicy3d/core";

export const KERNEL_CRASHED_BANNER_ID = "app.kernelCrashed";

export interface IKernelRecoveryUi {
    readonly available: boolean;
    readonly status: "idle" | "recovering" | "failed";
    readonly error: string | undefined;
    recover(): Promise<Result<unknown>>;
    onPropertyChanged(handler: (property: "available" | "status" | "error") => void): void;
    removePropertyChanged(handler: (property: "available" | "status" | "error") => void): void;
}

/**
 * Offers installed recovery with its explicit undo boundary and a Reload fallback.
 * Replaces the same banner while recovering or after a failed attempt; hides it on success.
 */
export function watchKernelCrash(
    state: KernelState = KernelState.current,
    reload: () => void = () => globalThis.location.reload(),
    recovery: IKernelRecoveryUi = KernelRecovery.current,
): () => void {
    let shown = false;
    let lastKey: string | undefined;
    let running = false;
    let localError: string | undefined;
    let stopped = false;
    const startRecovery = () => {
        if (stopped || !state.isCrashed || !recovery.available || running || recovery.status === "recovering")
            return;
        running = true;
        localError = undefined;
        show();
        void recovery
            .recover()
            .then(
                (result) => {
                    if (!result.isOk) localError = result.error;
                },
                (error: unknown) => {
                    localError = error instanceof Error ? error.message : String(error);
                },
            )
            .finally(() => {
                running = false;
                show();
            });
    };
    const show = () => {
        if (stopped) return;
        const busy = running || recovery.status === "recovering";
        const error = localError ?? recovery.error;
        if (!state.isCrashed && !busy && !error) {
            if (shown) PubSub.default.pub("hideBanner", KERNEL_CRASHED_BANNER_ID);
            shown = false;
            lastKey = undefined;
            return;
        }
        const key = JSON.stringify([state.isCrashed, state.reason, busy, recovery.available, error]);
        if (key === lastKey) return;
        lastKey = key;
        shown = true;
        PubSub.default.pub("showBanner", {
            id: KERNEL_CRASHED_BANNER_ID,
            level: !state.isCrashed && !busy && error ? "warn" : "error",
            message: busy
                ? "app.kernelRecovering"
                : !state.isCrashed && error
                  ? "app.kernelRecoveryRefreshFailed"
                  : error
                    ? "app.kernelRecoveryFailed"
                    : recovery.available
                      ? "app.kernelRecoveryAvailable"
                      : "app.kernelCrashed",
            args: error ? [error] : [state.reason],
            action:
                recovery.available && state.isCrashed && !busy
                    ? { label: "app.recoverKernel", run: startRecovery }
                    : { label: "common.reload", run: reload },
            actions:
                recovery.available && state.isCrashed && !busy
                    ? [
                          {
                              label: "common.reload",
                              run: reload,
                          },
                      ]
                    : undefined,
            dismissible: false,
        });
    };
    const listener = (property: keyof KernelState) => {
        if (property === "status") show();
    };
    state.onPropertyChanged(listener);
    const recoveryListener = () => show();
    recovery.onPropertyChanged(recoveryListener);
    show();
    return () => {
        stopped = true;
        state.removePropertyChanged(listener);
        recovery.removePropertyChanged(recoveryListener);
    };
}
