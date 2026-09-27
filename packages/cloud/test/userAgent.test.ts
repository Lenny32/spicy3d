// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describeUserAgent } from "../src/account/userAgent";

describe("describeUserAgent", () => {
    test.each([
        [
            "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
            { browser: "Firefox", os: "Linux" },
        ],
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
            { browser: "Edge", os: "Windows" },
        ],
        [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            { browser: "Safari", os: "macOS" },
        ],
        [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
            { browser: "Chrome", os: "iOS" },
        ],
        [
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
            { browser: "Chrome", os: "Android" },
        ],
        ["curl/8.5.0", { browser: "curl" }],
    ])("%s", (userAgent, expected) => {
        expect(describeUserAgent(userAgent)).toEqual(expected);
    });

    test.each([null, undefined, "", "???"])("%j: unknown", (userAgent) => {
        expect(describeUserAgent(userAgent)).toEqual({});
    });
});
