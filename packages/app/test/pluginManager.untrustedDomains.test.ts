// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Config, type DialogButton, type IApplication, PubSub } from "@spicy3d/core";
import { PluginManager } from "../src/pluginManager";

/**
 * Dedicated tests for the untrusted-domain flow in PluginManager.loadFromUrl.
 *
 * `untrustedDomains` is module-level state in src/pluginManager.ts and cannot be
 * cleared from the outside (rs.resetModules() + re-import is not viable here:
 * re-evaluating the module graph re-runs DOM side effects such as
 * customElements.define in the aliased viewGizmo module, which throws on the
 * shared happy-dom registry). Each test therefore uses a unique host so the
 * module-level array can never leak a decision between tests, and every test
 * drives the full dialog → decision → consequence flow on its own.
 */

function createManager(): PluginManager {
    const app = {
        mainWindow: {
            ribbon: { combineRibbonTab: rs.fn() },
        },
    } as unknown as IApplication;
    return new PluginManager(app);
}

function dialogButtons(args: unknown[] | undefined): DialogButton[] {
    expect(args).not.toBeUndefined();
    expect(args![0]).toBe("common.warning");
    return args![2] as DialogButton[];
}

function clickButton(button: DialogButton) {
    expect(button.onclick).toBeDefined();
    button.onclick!();
}

describe("PluginManager untrusted domains (isolated)", () => {
    let originalFetch: typeof fetch;
    let originalTrustedDomains: string[];
    let fetchSpy: ReturnType<typeof rs.fn>;
    let dialogArgs: unknown[] | undefined;

    const onDialog = (...args: unknown[]) => {
        dialogArgs = args;
    };

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchSpy = rs.fn();
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        originalTrustedDomains = [...Config.instance.trustedDomains];
        Config.instance.trustedDomains = [];

        dialogArgs = undefined;
        PubSub.default.sub("showDialog", onDialog);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        Config.instance.trustedDomains = originalTrustedDomains;
        PubSub.default.removeAll("showDialog");
    });

    test("declining a domain skips it on subsequent visits", async () => {
        const host = "declined-isolated.example.com";
        const manager = createManager();

        // First visit: the confirmation dialog is shown, nothing is fetched
        await manager.loadFromUrl(`https://${host}/plugin`);
        expect(fetchSpy).not.toHaveBeenCalled();
        const buttons = dialogButtons(dialogArgs);
        expect(buttons.map((b) => b.content)).toEqual(["common.dontTrust", "common.trust"]);

        // User declines the domain
        clickButton(buttons[0]);
        dialogArgs = undefined;

        // Second visit: early return — no dialog, no fetch
        await manager.loadFromUrl(`https://${host}/plugin`);
        expect(dialogArgs).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("trusting a domain adds it to trustedDomains, saves config and loads the plugin", async () => {
        const host = "trusted-isolated.example.com";
        const manager = createManager();
        const saveSpy = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
        const loadRemoteSpy = rs.spyOn(manager as any, "loadFromRemoteFile").mockResolvedValue(undefined);

        try {
            await manager.loadFromUrl(`https://${host}/plugin`);
            const buttons = dialogButtons(dialogArgs);
            const trust = buttons.find((b) => b.content === "common.trust");
            expect(trust).not.toBeUndefined();

            // User trusts the domain
            clickButton(trust!);

            expect(Config.instance.trustedDomains).toContain(host);
            expect(saveSpy).toHaveBeenCalledTimes(1);
            expect(loadRemoteSpy).toHaveBeenCalledWith(`https://${host}/plugin`);

            // A later visit is now treated as trusted without any dialog
            dialogArgs = undefined;
            await manager.loadFromUrl(`https://${host}/plugin`);
            expect(dialogArgs).toBeUndefined();
            expect(loadRemoteSpy).toHaveBeenCalledTimes(2);
        } finally {
            saveSpy.mockRestore();
            loadRemoteSpy.mockRestore();
        }
    });

    test("a declined domain stays declined across PluginManager instances", async () => {
        const host = "cross-instance.example.com";

        // First manager: decline the domain
        const first = createManager();
        await first.loadFromUrl(`https://${host}/plugin`);
        clickButton(dialogButtons(dialogArgs)[0]);
        dialogArgs = undefined;

        // The decision lives in module state, so a new manager also skips the domain
        const second = createManager();
        await second.loadFromUrl(`https://${host}/plugin`);
        expect(dialogArgs).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
