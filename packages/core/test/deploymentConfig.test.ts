// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig, resolveAppUrl } from "../src";

function serving(status: number, body: string) {
    return rs.fn(async (_request: Request) => new Response(body, { status }));
}

describe("DeploymentConfig", () => {
    afterEach(() => DeploymentConfig.reset());

    test("loads deployment.json from the app folder", async () => {
        const fetch = serving(200, JSON.stringify({ mcpBridge: { downloadUrl: "downloads/" } }));

        await DeploymentConfig.load({ baseUrl: "https://cad.example.com/app", fetch });

        const request = fetch.mock.calls[0][0];
        expect(request.url).toBe("https://cad.example.com/app/deployment.json");
        expect(DeploymentConfig.section("mcpBridge")).toEqual({ downloadUrl: "downloads/" });
    });

    test.each([
        ["a 404", serving(404, "not found")],
        ["a server error", serving(500, "oops")],
        ["invalid JSON", serving(200, "<html>")],
        ["a JSON array", serving(200, "[1, 2]")],
        [
            "no network",
            rs.fn(async (_request: Request): Promise<Response> => {
                throw new TypeError("Failed to fetch");
            }),
        ],
    ])("%s leaves the defaults", async (_case, fetch) => {
        DeploymentConfig.set({ ai: { defaultPreset: "stale" } });

        const loaded = await DeploymentConfig.load({ baseUrl: "https://cad.example.com/", fetch });

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(loaded).toEqual({});
        expect(DeploymentConfig.section("ai")).toBeUndefined();
    });

    test("a server that never answers is given up on, and the request aborted", async () => {
        let signal: AbortSignal | undefined;
        const fetch = rs.fn((request: Request) => {
            signal = request.signal;
            return new Promise<Response>(() => {});
        });
        DeploymentConfig.set({ ai: { defaultPreset: "stale" } });

        const loaded = await DeploymentConfig.load({
            baseUrl: "https://cad.example.com/",
            fetch,
            timeoutMs: 20,
        });

        expect(loaded).toEqual({});
        expect(signal?.aborted).toBe(true);
    });

    test("a section that is not an object is ignored", () => {
        DeploymentConfig.set({ ai: "on", mcpBridge: ["x"] });

        expect(DeploymentConfig.section("ai")).toBeUndefined();
        expect(DeploymentConfig.section("mcpBridge")).toBeUndefined();
    });
});

describe("resolveAppUrl", () => {
    test.each([
        ["downloads/mcp-bridge/", "https://cad.example.com/app/downloads/mcp-bridge/"],
        ["/downloads/", "https://cad.example.com/downloads/"],
        ["https://files.example.com/bridge/", "https://files.example.com/bridge/"],
    ])("%s", (value, expected) => {
        expect(resolveAppUrl(value, "https://cad.example.com/app/")).toBe(expected);
    });

    test("an invalid URL is undefined", () => {
        expect(resolveAppUrl("http://[::1", "https://cad.example.com/")).toBeUndefined();
    });
});
