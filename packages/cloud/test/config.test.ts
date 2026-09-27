// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import { Logger } from "@spicy3d/core";
import { checkApiVersion, discoverCloud, SUPPORTED_API_VERSIONS } from "../src/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = "https://spicy.test";

const CONFIG = {
    version: "0.0.1",
    apiVersion: "1",
    publicUrl: BASE,
    eventsSocket: "wss://spicy.test/ws/events",
    features: { signup: true, emailVerification: false, email: false, mcp: true },
    mcp: { endpoint: "https://spicy.test/mcp", pageSocket: "wss://spicy.test/ws/mcp-page" },
    storage: {
        maxUploadBytes: 1024,
        maxManifestBytes: 1024,
        quotaBytes: null,
        trashRetentionDays: 30,
        autosaveRetention: {},
    },
    serverTime: "2026-09-27T10:00:00.000Z",
};

function discoverWith(answer: (request: Request) => Response | Promise<Response>) {
    const fetch = rs.fn(async (request: Request) => answer(request));
    return { discovery: discoverCloud({ baseUrl: `${BASE}/`, fetch }), fetch };
}

let warn: ReturnType<typeof rs.spyOn>;
let error: ReturnType<typeof rs.spyOn>;

beforeEach(() => {
    warn = rs.spyOn(Logger, "warn").mockImplementation(() => {});
    error = rs.spyOn(Logger, "error").mockImplementation(() => {});
    rs.spyOn(Logger, "info").mockImplementation(() => {});
});

afterEach(() => {
    rs.restoreAllMocks();
});

describe("discoverCloud", () => {
    // (`cache: "no-store"` is set too, but Happy-DOM's Request doesn't expose `cache`.)
    test("asks GET /api/config anonymously, same origin", async () => {
        const { discovery, fetch } = discoverWith(() => Response.json(CONFIG));

        expect((await discovery).status).toBe("ready");
        expect(fetch).toHaveBeenCalledTimes(1);
        const request = fetch.mock.calls[0][0];
        expect(request.url).toBe(`${BASE}/api/config`);
        expect(request.method).toBe("GET");
        expect(request.credentials).toBe("same-origin");
        expect(request.headers.get("X-Spicy3D-Request")).toBeNull();
    });

    test("a compatible server is ready with its config", async () => {
        const { discovery } = discoverWith(() => Response.json(CONFIG));

        expect(await discovery).toEqual({ status: "ready", config: CONFIG });
    });

    test.each([
        ["404 from static hosting", () => new Response("Not Found", { status: 404 })],
        ["a server error", () => new Response("", { status: 500 })],
        ["HTML (SPA fallback)", () => new Response("<!doctype html><html></html>", { status: 200 })],
        ["JSON that isn't a config", () => Response.json({ hello: "world" })],
        ["a JSON array", () => Response.json([CONFIG])],
        ["an apiVersion that isn't a string", () => Response.json({ ...CONFIG, apiVersion: 1 })],
        [
            "no network",
            () => {
                throw new TypeError("Failed to fetch");
            },
        ],
    ])("%s → dormant, without warnings or errors", async (_case, answer) => {
        const { discovery } = discoverWith(answer);

        expect(await discovery).toEqual({ status: "dormant" });
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    test("the app's own placeholder (public/api/config, served without a server) → dormant", async () => {
        const placeholder = readFileSync(path.join(repoRoot, "public/api/config"), "utf8");
        const { discovery } = discoverWith(() => new Response(placeholder, { status: 200 }));

        expect(await discovery).toEqual({ status: "dormant" });
    });

    test.each([
        ["2", "serverNewer"],
        ["0", "serverOlder"],
    ] as const)("apiVersion %s → incompatible (%s)", async (apiVersion, compatibility) => {
        const config = { ...CONFIG, apiVersion };
        const { discovery } = discoverWith(() => Response.json(config));

        expect(await discovery).toEqual({ status: "incompatible", config, compatibility });
    });
});

describe("checkApiVersion", () => {
    test("the client supports API 1", () => {
        expect(SUPPORTED_API_VERSIONS).toEqual({ min: 1, max: 1 });
    });

    test.each([
        ["1", "compatible"],
        ["1.4", "compatible"],
        [" v1 ", "compatible"],
        ["2", "serverNewer"],
        ["10", "serverNewer"],
        ["0", "serverOlder"],
        ["", "serverNewer"],
        ["banana", "serverNewer"],
    ] as const)("%j → %s", (apiVersion, expected) => {
        expect(checkApiVersion(apiVersion)).toBe(expected);
    });

    test("a wider range accepts the versions inside it", () => {
        const range = { min: 2, max: 3 };
        expect(checkApiVersion("1", range)).toBe("serverOlder");
        expect(checkApiVersion("2", range)).toBe("compatible");
        expect(checkApiVersion("3", range)).toBe("compatible");
        expect(checkApiVersion("4", range)).toBe("serverNewer");
    });
});
