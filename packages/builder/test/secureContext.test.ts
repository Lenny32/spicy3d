// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type BannerOptions, DeploymentConfig, PubSub } from "@spicy3d/core";
import { AppBuilder } from "../src/appBuilder";
import {
    INSECURE_CONTEXT_BANNER_ID,
    isInsecureRemoteContext,
    warnIfInsecureContext,
} from "../src/secureContext";

describe("insecure-context banner", () => {
    test.each([
        [false, "192.168.1.20", true],
        [false, "spicy.lan", true],
        [false, "localhost", false],
        [false, "app.localhost", false],
        [false, "127.0.0.1", false],
        [false, "[::1]", false],
        [true, "192.168.1.20", false],
        [true, "cad.example.com", false],
        [undefined, "192.168.1.20", false],
    ])("secure %p on %s → insecure %p", (secure, hostname, expected) => {
        expect(isInsecureRemoteContext(secure, hostname)).toBe(expected);
    });

    test("plain HTTP on a LAN address shows a warning banner", () => {
        const banners: BannerOptions[] = [];
        const listener = (banner: BannerOptions) => banners.push(banner);
        PubSub.default.sub("showBanner", listener);
        try {
            expect(warnIfInsecureContext(false, "192.168.1.20")).toBe(true);
            expect(warnIfInsecureContext(true, "192.168.1.20")).toBe(false);
            expect(warnIfInsecureContext(false, "localhost")).toBe(false);
        } finally {
            PubSub.default.remove("showBanner", listener);
        }

        expect(banners).toEqual([
            { id: INSECURE_CONTEXT_BANNER_ID, level: "warn", message: "app.insecureContext" },
        ]);
    });
});

describe("AppBuilder.useDeploymentConfig", () => {
    afterEach(() => DeploymentConfig.reset());

    test("reads deployment.json before the other steps", async () => {
        const fetch = rs.fn(
            async (_request: Request) => new Response(JSON.stringify({ ai: { defaultPreset: "lan" } })),
        );
        const builder = new AppBuilder().useDeploymentConfig({ baseUrl: "https://cad.example.com/", fetch });
        const inits = (builder as unknown as { _inits: (() => Promise<void>)[] })._inits;

        await inits.at(-1)?.();

        expect(fetch.mock.calls[0][0].url).toBe("https://cad.example.com/deployment.json");
        expect(DeploymentConfig.section("ai")).toEqual({ defaultPreset: "lan" });
    });
});
