// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { REDACTED, redactSecrets, redactUrl } from "../src";

describe("redactUrl", () => {
    test.each([
        ["https://host/a/b.step", "https://host/a/b.step"],
        ["https://host/a/b.step?sig=abc&x=1", `https://host/a/b.step?${REDACTED}`],
        ["ws://127.0.0.1:3000/?token=deadbeef", `ws://127.0.0.1:3000/?${REDACTED}`],
        ["https://host/reset-password#token=abc", `https://host/reset-password#${REDACTED}`],
        ["https://user:secret@host/x", "https://host/x"],
    ])("%s → %s", (input, expected) => {
        expect(redactUrl(input)).toBe(expected);
    });

    test("accepts a URL object", () => {
        expect(redactUrl(new URL("https://host/p?token=1"))).toBe(`https://host/p?${REDACTED}`);
    });

    test("a value that is not a URL has its secrets masked instead", () => {
        expect(redactUrl("plugins/x?token=abc")).toBe(`plugins/x?token=${REDACTED}`);
    });
});

describe("redactSecrets", () => {
    test.each([
        [
            "failed to fetch https://h/f.step?sig=xyz: 403",
            `failed to fetch https://h/f.step?${REDACTED}: 403`,
        ],
        ["Authorization: Bearer spicy_pat_abcdefgh12345", `Authorization: ${REDACTED} ${REDACTED}`],
        ["bearer abc.def.ghi rejected", `bearer ${REDACTED} rejected`],
        ['{"token":"abc","name":"Box"}', `{"token":"${REDACTED}","name":"Box"}`],
        ["password=hunter2&user=ada", `password=${REDACTED}&user=ada`],
        ["apiKey: sk-live-123", `apiKey: ${REDACTED}`],
        [
            "copied spicy_pat_0123456789abcdef to the clipboard",
            `copied spicy_pat_${REDACTED} to the clipboard`,
        ],
    ])("%s", (input, expected) => {
        expect(redactSecrets(input)).toBe(expected);
    });

    test("text without secrets is unchanged", () => {
        const text = "[cloud] rename of 01J9 failed: offline";
        expect(redactSecrets(text)).toBe(text);
    });
});
