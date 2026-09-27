// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type BannerOptions, PubSub } from "@spicy3d/core";
import { Account } from "../src/account/account";
import type { ConfigResponse } from "../src/api";
import { CloudClient } from "../src/client";
import { API_VERSION_BANNER_ID, Cloud, startCloud } from "../src/cloud";

const config = { version: "0.0.2", apiVersion: 1 } as unknown as ConfigResponse;

let published: [string, unknown[]][];

beforeEach(() => {
    published = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation((event: string, ...args: unknown[]) => {
        published.push([event, args]);
    });
});

afterEach(() => {
    rs.restoreAllMocks();
    Cloud.current.connection = undefined;
});

function bannerOf(): BannerOptions {
    expect(published).toHaveLength(1);
    expect(published[0][0]).toBe("showBanner");
    return published[0][1][0] as BannerOptions;
}

describe("startCloud", () => {
    test("dormant: no connection, no UI", () => {
        expect(startCloud({ status: "dormant" })).toBeUndefined();
        expect(Cloud.current.connection).toBeUndefined();
        expect(published).toEqual([]);
    });

    test("ready: the connection is set, with a client on the given base URL", () => {
        const connection = startCloud({ status: "ready", config }, { baseUrl: "https://spicy.test/" });

        expect(connection?.config).toBe(config);
        expect(connection?.client).toBeInstanceOf(CloudClient);
        expect(connection?.client.baseUrl).toBe("https://spicy.test");
        expect(Cloud.current.connection).toBe(connection);
        expect(published).toEqual([]);
    });

    test("ready: the connection's account is the app's account, not signed in yet", () => {
        expect(Cloud.current.account).toBeUndefined();

        const connection = startCloud({ status: "ready", config }, { baseUrl: "https://spicy.test" });

        expect(connection?.account).toBeInstanceOf(Account);
        expect(connection?.account.client).toBe(connection?.client);
        expect(Cloud.current.account).toBe(connection?.account);
        expect(Cloud.current.account?.status).toBe("unknown");
    });

    test("ready: observers learn about the connection", () => {
        const changed: string[] = [];
        const handler = (property: string | number | symbol) => changed.push(String(property));
        Cloud.current.onPropertyChanged(handler);
        try {
            startCloud({ status: "ready", config }, { baseUrl: "https://spicy.test" });
        } finally {
            Cloud.current.removePropertyChanged(handler);
        }
        expect(changed).toEqual(["connection"]);
    });

    test("a newer server: a non-blocking reload banner, and no connection", () => {
        const reload = rs.fn(() => {});
        rs.stubGlobal("location", { ...globalThis.location, reload });
        try {
            expect(
                startCloud({ status: "incompatible", config, compatibility: "serverNewer" }),
            ).toBeUndefined();

            const banner = bannerOf();
            expect(banner).toMatchObject({
                id: API_VERSION_BANNER_ID,
                level: "warn",
                message: "cloud.banner.appOutdated",
            });
            expect(banner.dismissible).not.toBe(false);
            expect(banner.action?.label).toBe("common.reload");
            banner.action?.run();
            expect(reload).toHaveBeenCalledTimes(1);
        } finally {
            rs.unstubAllGlobals();
        }
        expect(Cloud.current.connection).toBeUndefined();
    });

    test("an older server: a banner without reload (reloading wouldn't help)", () => {
        startCloud({ status: "incompatible", config, compatibility: "serverOlder" });

        const banner = bannerOf();
        expect(banner).toMatchObject({ id: API_VERSION_BANNER_ID, message: "cloud.banner.serverOutdated" });
        expect(banner.action).toBeUndefined();
        expect(Cloud.current.connection).toBeUndefined();
    });
});
