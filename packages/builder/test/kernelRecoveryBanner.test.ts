// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type BannerOptions, KernelState, PubSub, Result } from "@spicy3d/core";
import { type IKernelRecoveryUi, watchKernelCrash } from "../src/kernelCrashBanner";

class RecoveryUi implements IKernelRecoveryUi {
    available = false;
    status: "idle" | "recovering" | "failed" = "idle";
    error: string | undefined;
    readonly handlers = new Set<(property: "available" | "status" | "error") => void>();
    recover = rs.fn(async (): Promise<Result<unknown>> => Result.ok({ undoReset: true }));
    onPropertyChanged(handler: (property: "available" | "status" | "error") => void) {
        this.handlers.add(handler);
    }
    removePropertyChanged(handler: (property: "available" | "status" | "error") => void) {
        this.handlers.delete(handler);
    }
    changed(property: "available" | "status" | "error") {
        for (const handler of this.handlers) handler(property);
    }
}

async function withBanners(run: (banners: BannerOptions[], hidden: string[]) => Promise<void>) {
    const banners: BannerOptions[] = [];
    const hidden: string[] = [];
    const shown = (banner: BannerOptions) => banners.push(banner);
    const hide = (id: string) => hidden.push(id);
    PubSub.default.sub("showBanner", shown);
    PubSub.default.sub("hideBanner", hide);
    try {
        await run(banners, hidden);
    } finally {
        PubSub.default.remove("showBanner", shown);
        PubSub.default.remove("hideBanner", hide);
    }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("kernel recovery banner", () => {
    test("offers recovery when installed and retains Reload as a second action", async () => {
        const state = new KernelState();
        const recovery = new RecoveryUi();
        const reload = rs.fn(() => {});
        state.markCrashed("native trap");
        await withBanners(async (banners) => {
            const stop = watchKernelCrash(state, reload, recovery);
            try {
                expect(banners.at(-1)?.action?.label).toBe("common.reload");
                recovery.available = true;
                recovery.changed("available");
                const banner = banners.at(-1)!;
                expect(banner.message).toBe("app.kernelRecoveryAvailable");
                expect(banner.action?.label).toBe("app.recoverKernel");
                expect(banner.actions).toHaveLength(1);
                expect(banner.actions![0].label).toBe("common.reload");
                banner.actions![0].run();
                expect(reload).toHaveBeenCalledTimes(1);
            } finally {
                stop();
            }
        });
    });

    test("disables duplicate recovery attempts and hides the banner after success", async () => {
        const state = new KernelState();
        const recovery = new RecoveryUi();
        recovery.available = true;
        let finish!: (result: Result<unknown>) => void;
        recovery.recover.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        state.markCrashed("native trap");
        await withBanners(async (banners, hidden) => {
            const stop = watchKernelCrash(state, () => {}, recovery);
            try {
                const action = banners.at(-1)!.action!;
                expect(action.label).toBe("app.recoverKernel");
                action.run();
                action.run();
                expect(recovery.recover).toHaveBeenCalledTimes(1);
                expect(banners.at(-1)?.message).toBe("app.kernelRecovering");
                expect(banners.at(-1)?.action?.label).toBe("common.reload");
                state.reset();
                finish(Result.ok({ undoReset: true }));
                await settle();
                expect(hidden).toEqual(["app.kernelCrashed"]);
            } finally {
                stop();
            }
        });
    });

    test.each(["result", "rejection"])("offers retry after a %s failure", async (kind) => {
        const state = new KernelState();
        const recovery = new RecoveryUi();
        recovery.available = true;
        recovery.recover.mockImplementation(async () => {
            if (kind === "rejection") throw new Error("fresh kernel unavailable");
            return Result.err("fresh kernel unavailable");
        });
        state.markCrashed("native trap");
        await withBanners(async (banners) => {
            const stop = watchKernelCrash(state, () => {}, recovery);
            try {
                banners.at(-1)!.action!.run();
                await settle();
                expect(banners.at(-1)).toMatchObject({
                    message: "app.kernelRecoveryFailed",
                    args: ["fresh kernel unavailable"],
                    level: "error",
                });
                expect(banners.at(-1)?.action?.label).toBe("app.recoverKernel");
                banners.at(-1)!.action!.run();
                await settle();
                expect(recovery.recover).toHaveBeenCalledTimes(2);
            } finally {
                stop();
            }
        });
    });

    test("reports viewport failure after activation with a Reload action", async () => {
        const state = new KernelState();
        const recovery = new RecoveryUi();
        recovery.available = true;
        recovery.recover.mockImplementation(async () => {
            state.reset();
            return Result.err("viewport refresh failed");
        });
        state.markCrashed("native trap");
        await withBanners(async (banners, hidden) => {
            const stop = watchKernelCrash(state, () => {}, recovery);
            try {
                banners.at(-1)!.action!.run();
                await settle();
                expect(state.isCrashed).toBe(false);
                expect(hidden).toEqual([]);
                expect(banners.at(-1)).toMatchObject({
                    level: "warn",
                    message: "app.kernelRecoveryRefreshFailed",
                    args: ["viewport refresh failed"],
                });
                expect(banners.at(-1)?.action?.label).toBe("common.reload");
            } finally {
                stop();
            }
        });
    });

    test("unsubscribes both state sources and ignores obsolete actions", async () => {
        const state = new KernelState();
        const recovery = new RecoveryUi();
        recovery.available = true;
        state.markCrashed("native trap");
        await withBanners(async (banners) => {
            const stop = watchKernelCrash(state, () => {}, recovery);
            const action = banners.at(-1)!.action!;
            stop();
            expect(recovery.handlers.size).toBe(0);
            action.run();
            recovery.changed("status");
            state.reset();
            await settle();
            expect(recovery.recover).toHaveBeenCalledTimes(0);
            expect(banners).toHaveLength(1);
        });
    });
});
