// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type BannerOptions, KernelState, PubSub } from "@spicy3d/core";
import { KERNEL_CRASHED_BANNER_ID, watchKernelCrash } from "../src/kernelCrashBanner";

function collectBanners(run: (banners: BannerOptions[]) => void) {
    const banners: BannerOptions[] = [];
    const listener = (banner: BannerOptions) => banners.push(banner);
    PubSub.default.sub("showBanner", listener);
    try {
        run(banners);
    } finally {
        PubSub.default.remove("showBanner", listener);
    }
}

describe("kernel crash banner", () => {
    test("shown once when the kernel crashes, with a Reload action", () => {
        const state = new KernelState();
        const reload = rs.fn(() => {});
        collectBanners((banners) => {
            const stop = watchKernelCrash(state, reload);
            try {
                expect(banners).toEqual([]);
                state.markCrashed("Aborted(undefined)");
                state.markCrashed("table index is out of bounds");
            } finally {
                stop();
            }
            expect(banners).toHaveLength(1);
            const [banner] = banners;
            expect(banner).toMatchObject({
                id: KERNEL_CRASHED_BANNER_ID,
                level: "error",
                message: "app.kernelCrashed",
                args: ["Aborted(undefined)"],
                dismissible: false,
            });
            expect(banner.action?.label).toBe("common.reload");
            banner.action?.run();
            expect(reload).toHaveBeenCalledTimes(1);
        });
    });

    test("a kernel that crashed before the watch starts is shown at once", () => {
        const state = new KernelState();
        state.markCrashed("Aborted(undefined)");
        collectBanners((banners) => {
            watchKernelCrash(state, () => {})();
            expect(banners.map((b) => b.id)).toEqual([KERNEL_CRASHED_BANNER_ID]);
        });
    });

    test("nothing after the unsubscribe", () => {
        const state = new KernelState();
        collectBanners((banners) => {
            watchKernelCrash(state, () => {})();
            state.markCrashed("Aborted(undefined)");
            expect(banners).toEqual([]);
        });
    });
});
