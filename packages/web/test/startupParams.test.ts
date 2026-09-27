// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { parseStartupParams } from "../src/startupParams";

describe("parseStartupParams", () => {
    test("should return empty plugins and undefined fileUrl when no params", () => {
        expect(parseStartupParams("")).toEqual({ plugins: [], fileUrl: undefined });
    });

    test("should parse a single plugin param", () => {
        expect(parseStartupParams("?plugin=https://example.com/my-plugin.js")).toEqual({
            plugins: ["https://example.com/my-plugin.js"],
            fileUrl: undefined,
        });
    });

    test("should parse multiple repeated plugin params in order", () => {
        const result = parseStartupParams("?plugin=a.js&plugin=b.js&plugin=c.js");
        expect(result).toEqual({
            plugins: ["a.js", "b.js", "c.js"],
            fileUrl: undefined,
        });
    });

    test("should ignore empty plugin params", () => {
        const result = parseStartupParams("?plugin=&plugin=a.js");
        expect(result).toEqual({ plugins: ["a.js"], fileUrl: undefined });
    });

    test("should parse url param as fileUrl", () => {
        expect(parseStartupParams("?url=https%3A%2F%2Fexample.com%2Fmodel.step")).toEqual({
            plugins: [],
            fileUrl: "https://example.com/model.step",
        });
    });

    test("should parse model param as fileUrl", () => {
        expect(parseStartupParams("?model=https%3A%2F%2Fexample.com%2Fmodel.brep")).toEqual({
            plugins: [],
            fileUrl: "https://example.com/model.brep",
        });
    });

    test("should prefer url over model when both are present", () => {
        const result = parseStartupParams("?url=from-url.step&model=from-model.step");
        expect(result).toEqual({ plugins: [], fileUrl: "from-url.step" });
    });

    test("should parse combined plugin and url params", () => {
        const result = parseStartupParams("?plugin=a.js&plugin=b.js&url=model.step");
        expect(result).toEqual({
            plugins: ["a.js", "b.js"],
            fileUrl: "model.step",
        });
    });

    test("should ignore unrelated params", () => {
        expect(parseStartupParams("?foo=1&bar=2")).toEqual({ plugins: [], fileUrl: undefined });
    });

    test("should decode the mcp bridge url", () => {
        const bridge = "ws://127.0.0.1:7777/?token=abc";
        const result = parseStartupParams(`?mcp=${encodeURIComponent(bridge)}`);
        expect(result.mcpUrl).toBe(bridge);
    });
});
