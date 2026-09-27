// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IHighlightable, isHighlightable } from "../src/highlightable";

describe("isHighlightable", () => {
    test("returns true for object with highlight and unhighlight methods", () => {
        const obj: IHighlightable = {
            highlight() {},
            unhighlight() {},
        };
        expect(isHighlightable(obj)).toBe(true);
    });

    test.each([
        ["object missing highlight method", { unhighlight() {} }],
        ["object missing unhighlight method", { highlight() {} }],
        ["null", null],
        ["undefined", undefined],
        ["plain object", {}],
        ["string", "hello"],
        ["number", 42],
    ])("returns falsy for %s", (_name, value) => {
        expect(isHighlightable(value)).toBeFalsy();
    });

    test("class implementing IHighlightable passes the check", () => {
        class MyHighlightable implements IHighlightable {
            highlight(): void {}
            unhighlight(): void {}
        }
        expect(isHighlightable(new MyHighlightable())).toBe(true);
    });
});
