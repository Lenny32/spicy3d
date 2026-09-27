// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isCompleteAccountLink, parseAccountLink } from "../src/links";

describe("parseAccountLink", () => {
    test.each([
        ["/verify-email", "?userId=u&token=t", { kind: "verifyEmail", userId: "u", token: "t" }, "/"],
        [
            "/reset-password",
            "?userId=u&token=a%2Bb%3D",
            { kind: "resetPassword", userId: "u", token: "a+b=" },
            "/",
        ],
        [
            "/sub/confirm-email-change/",
            "?userId=u&email=n%40x.test&token=t",
            { kind: "confirmEmailChange", userId: "u", email: "n@x.test", token: "t" },
            "/sub/",
        ],
    ])("%s%s", (pathname, search, link, appPath) => {
        expect(parseAccountLink(pathname, search)).toEqual({ link, appPath });
    });

    test.each([
        "/",
        "/index.html",
        "/reset-password-now",
        "/verify-email/extra",
    ])("%s is not a link", (pathname) => {
        expect(parseAccountLink(pathname, "?userId=u&token=t")).toBeUndefined();
    });

    test("missing parameters make an incomplete link, reported as invalid", () => {
        const route = parseAccountLink("/reset-password", "?userId=u");
        expect(route?.link).toEqual({ kind: "resetPassword", userId: "u", token: "" });
        expect(isCompleteAccountLink(route!.link)).toBe(false);
        expect(isCompleteAccountLink({ kind: "verifyEmail", userId: "u", token: "t" })).toBe(true);
        expect(
            isCompleteAccountLink({ kind: "confirmEmailChange", userId: "u", email: "", token: "t" }),
        ).toBe(false);
    });
});
