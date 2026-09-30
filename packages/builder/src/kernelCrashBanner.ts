// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelState, PubSub } from "@spicy3d/core";

export const KERNEL_CRASHED_BANNER_ID = "app.kernelCrashed";

/**
 * Shows one persistent banner "the geometry kernel crashed, reload" with a Reload action when the
 * kernel's state flips to crashed (at once if it already has). Nothing else is blocked: the
 * document can still be saved. Returns the unsubscribe.
 */
export function watchKernelCrash(
    state: KernelState = KernelState.current,
    reload: () => void = () => globalThis.location.reload(),
): () => void {
    let shown = false;
    const show = () => {
        if (shown || !state.isCrashed) return;
        shown = true;
        PubSub.default.pub("showBanner", {
            id: KERNEL_CRASHED_BANNER_ID,
            level: "error",
            message: "app.kernelCrashed",
            args: [state.reason],
            action: { label: "common.reload", run: reload },
            dismissible: false,
        });
    };
    const listener = (property: keyof KernelState) => {
        if (property === "status") show();
    };
    state.onPropertyChanged(listener);
    show();
    return () => state.removePropertyChanged(listener);
}
