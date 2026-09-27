// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    Config,
    DeploymentConfig,
    type DialogButton,
    ExternalContentPolicy,
    type IApplication,
    PubSub,
} from "@spicy3d/core";
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
        DeploymentConfig.reset();
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

            // The origin (scheme included), not the bare host.
            expect(Config.instance.trustedDomains).toContain(`https://${host}`);
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

    describe("while a cloud session may exist (CLOUD-17)", () => {
        let removeProbe: () => void;
        beforeEach(() => {
            removeProbe = ExternalContentPolicy.setSessionProbe(() => true);
        });
        afterEach(() => removeProbe());

        test("an origin trusted while signed out asks again, and the prompt warns about the account", async () => {
            const host = "signed-in-remembered.example.com";
            Config.instance.trustedDomains = [`https://${host}`, host];
            const manager = createManager();
            const loadRemoteSpy = rs.spyOn(manager as any, "loadFromRemoteFile").mockResolvedValue(undefined);
            try {
                await manager.loadFromUrl(`https://${host}/plugin/`);

                expect(loadRemoteSpy).not.toHaveBeenCalled();
                expect(dialogArgs).not.toBeUndefined();
                const content = dialogArgs![1] as HTMLElement;
                expect(content.textContent).toContain(`https://${host}`);
                expect(content.querySelector('[data-warning="signedIn"]')).not.toBeNull();
            } finally {
                loadRemoteSpy.mockRestore();
            }
        });

        test("Trust loads the plugin and lasts for this page only: nothing is saved", async () => {
            const host = "signed-in-trust.example.com";
            const manager = createManager();
            const saveSpy = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
            const loadRemoteSpy = rs.spyOn(manager as any, "loadFromRemoteFile").mockResolvedValue(undefined);
            try {
                await manager.loadFromUrl(`https://${host}/plugin/`);
                clickButton(dialogButtons(dialogArgs)[1]);

                expect(loadRemoteSpy).toHaveBeenCalledWith(`https://${host}/plugin/`);
                expect(saveSpy).not.toHaveBeenCalled();
                expect(Config.instance.trustedDomains).not.toContain(`https://${host}`);

                // Same page: no second prompt.
                dialogArgs = undefined;
                await manager.loadFromUrl(`https://${host}/other/`);
                expect(dialogArgs).toBeUndefined();
                expect(loadRemoteSpy).toHaveBeenCalledTimes(2);
            } finally {
                saveSpy.mockRestore();
                loadRemoteSpy.mockRestore();
            }
        });

        test("an origin allowlisted by the deployment loads without a prompt", async () => {
            DeploymentConfig.set({ security: { pluginOrigins: ["https://*.plugins.example.lan"] } });
            const manager = createManager();
            const loadRemoteSpy = rs.spyOn(manager as any, "loadFromRemoteFile").mockResolvedValue(undefined);
            try {
                await manager.loadFromUrl("https://cad.plugins.example.lan/macro/");

                expect(dialogArgs).toBeUndefined();
                expect(loadRemoteSpy).toHaveBeenCalledWith("https://cad.plugins.example.lan/macro/");
            } finally {
                loadRemoteSpy.mockRestore();
            }
        });
    });

    test("a plain-HTTP plugin origin is named with a warning", async () => {
        const manager = createManager();
        await manager.loadFromUrl("http://plain-http-isolated.example.com/plugin/");

        const content = dialogArgs![1] as HTMLElement;
        expect(content.textContent).toContain("http://plain-http-isolated.example.com");
        expect(content.querySelector('[data-warning="plainHttp"]')).not.toBeNull();
        expect(content.querySelector('[data-warning="signedIn"]')).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("a non-http plugin URL is refused without a prompt", async () => {
        const manager = createManager();
        const toasts: unknown[][] = [];
        PubSub.default.sub("showToast", (...args: unknown[]) => toasts.push(args));
        try {
            await manager.loadFromUrl("javascript:alert(1)");
        } finally {
            PubSub.default.removeAll("showToast");
        }

        expect(dialogArgs).toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(toasts[0]?.[0]).toBe("warning.plugin.refused{0}");
    });
});
