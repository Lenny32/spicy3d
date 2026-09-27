// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { trimEndChars, trimTrailingSlashes } from "../src";

describe("trimEndChars", () => {
    test.each([
        ["a.b.,:", ".,:", "a.b"],
        ["abc", ".", "abc"],
        ["...", ".", ""],
        ["", ".", ""],
        ["body.box12", "0123456789", "body.box"],
    ])("%s without trailing %s", (text, chars, expected) => {
        expect(trimEndChars(text, chars)).toBe(expected);
    });

    test("stays linear on a long run of trimmed chars", () => {
        const text = `x${"!".repeat(200_000)}y`;
        const start = performance.now();
        expect(trimEndChars(text, "!")).toBe(text);
        expect(trimEndChars(`x${"!".repeat(200_000)}`, "!")).toBe("x");
        expect(performance.now() - start).toBeLessThan(1000);
    });
});

test("trimTrailingSlashes keeps inner slashes", () => {
    expect(trimTrailingSlashes("https://host/app///")).toBe("https://host/app");
    expect(trimTrailingSlashes("https://host/app")).toBe("https://host/app");
});
