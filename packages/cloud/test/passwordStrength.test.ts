// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { estimatePasswordStrength, PASSWORD_MIN_LENGTH } from "../src/account/passwordStrength";

describe("estimatePasswordStrength", () => {
    test("below the server's minimum length: too short", () => {
        const hint = estimatePasswordStrength("a".repeat(PASSWORD_MIN_LENGTH - 1));
        expect(hint).toEqual({ strength: "tooShort", score: 0, message: "account.password.tooShort{0}" });
    });

    test.each([
        ["aaaaaaaaaaaa", "weak"],
        ["abcdefghijkl", "weak"],
        ["password1234", "weak"],
        ["qwertyuiop12", "weak"],
        ["sunflower12", "fair"],
        ["kitchen table", "good"],
        ["Tr0ub4dor&3xq", "strong"],
        ["correct horse battery staple", "strong"],
    ])("%j reads as %s", (password, strength) => {
        expect(estimatePasswordStrength(password).strength).toBe(strength);
    });

    test("the user's own email and name don't count", () => {
        const personal = ["ada.lovelace@example.test", "Ada Lovelace"];
        expect(estimatePasswordStrength("lovelace1815", personal).strength).toBe("weak");
        expect(estimatePasswordStrength("lovelace1815").strength).not.toBe("weak");
    });

    test("the score grows with the strength", () => {
        const scores = ["aaaaaaaaaaaa", "sunflower12", "kitchen table", "Tr0ub4dor&3xq"].map(
            (p) => estimatePasswordStrength(p).score,
        );
        expect(scores).toEqual([1, 2, 3, 4]);
    });
});
