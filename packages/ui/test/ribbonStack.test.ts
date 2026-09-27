// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";

rs.mock("../src/ribbon/ribbonStack.module.css", () => ({
    root: "rs-root",
}));

import { RibbonStack } from "../src/ribbon/ribbonStack";

describe("RibbonStack", () => {
    test("should apply root class on construction", () => {
        const stack = new RibbonStack();
        expect(stack.className).toBe("rs-root");
    });

    test("should be registered as the ribbon-stack custom element", () => {
        const el = document.createElement("ribbon-stack");
        expect(el).toBeInstanceOf(RibbonStack);
        expect(el.className).toBe("rs-root");
    });

    test("should host stacked button children", () => {
        const stack = new RibbonStack();
        stack.append(document.createElement("span"), document.createElement("span"));
        expect(stack.childElementCount).toBe(2);
    });
});
