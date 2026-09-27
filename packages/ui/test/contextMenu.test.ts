// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { I18n } from "@spicy3d/core";
import "./_helpers/cssMocks";
import { type ContextMenuEntry, closeContextMenu, showContextMenu } from "../src/contextMenu";
import { mustQuery } from "./_helpers/domHelpers";

function items() {
    return [...document.body.querySelectorAll<HTMLButtonElement>(".ctx-item")];
}

function entries(run = rs.fn(() => {})): ContextMenuEntry[] {
    return [
        "separator",
        { label: "common.rename", icon: "icon-edit", run },
        "separator",
        "separator",
        { label: "common.clone", disabled: true, run },
        { label: "common.delete", danger: true, run },
        "separator",
    ];
}

describe("showContextMenu", () => {
    afterEach(() => closeContextMenu());

    test("renders the actions with their labels, dropping stray separators", () => {
        showContextMenu({ x: 10, y: 20 }, entries());
        const menu = mustQuery<HTMLElement>(document.body, ".ctx-menu");

        expect(menu.getAttribute("role")).toBe("menu");
        expect(items().map((x) => x.textContent)).toEqual(
            (["common.rename", "common.clone", "common.delete"] as const).map((x) => I18n.translate(x)),
        );
        expect(menu.querySelectorAll(".ctx-separator").length).toBe(1);
        expect(items()[1].disabled).toBe(true);
        expect(items()[2].classList.contains("ctx-danger")).toBe(true);
    });

    test("a click runs the action and closes the menu", () => {
        const run = rs.fn(() => {});
        showContextMenu({ x: 0, y: 0 }, entries(run));

        items()[2].click();

        expect(run).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector(".ctx-menu")).toBeNull();
    });

    test("a disabled action does nothing", () => {
        const run = rs.fn(() => {});
        showContextMenu({ x: 0, y: 0 }, entries(run));

        items()[1].click();

        expect(run).not.toHaveBeenCalled();
        expect(document.body.querySelector(".ctx-menu")).not.toBeNull();
    });

    test("closes on Escape and on a press outside, not on a press inside", () => {
        showContextMenu({ x: 0, y: 0 }, entries());
        items()[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(document.body.querySelector(".ctx-menu")).not.toBeNull();

        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(document.body.querySelector(".ctx-menu")).toBeNull();

        showContextMenu({ x: 0, y: 0 }, entries());
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(document.body.querySelector(".ctx-menu")).toBeNull();
    });

    test("only one menu is open at a time", () => {
        showContextMenu({ x: 0, y: 0 }, entries());
        showContextMenu({ x: 5, y: 5 }, entries());

        expect(document.body.querySelectorAll(".ctx-menu").length).toBe(1);
    });

    test("arrow keys move between enabled actions, skipping disabled ones", () => {
        showContextMenu({ x: 0, y: 0 }, entries());
        const [rename, , remove] = items();
        expect(document.activeElement).toBe(rename);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        expect(document.activeElement).toBe(remove);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        expect(document.activeElement).toBe(rename);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
        expect(document.activeElement).toBe(remove);
    });

    describe("position", () => {
        function withGeometry<T>(size: { width: number; height: number }, open: () => T): T {
            const descriptors = [
                Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
                Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
            ];
            const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
            const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
            Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
                configurable: true,
                get: () => size.width,
            });
            Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
                configurable: true,
                get: () => size.height,
            });
            Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
            Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
            try {
                return open();
            } finally {
                Object.defineProperty(HTMLElement.prototype, "offsetWidth", descriptors[0]!);
                Object.defineProperty(HTMLElement.prototype, "offsetHeight", descriptors[1]!);
                Object.defineProperty(window, "innerWidth", innerWidth!);
                Object.defineProperty(window, "innerHeight", innerHeight!);
            }
        }

        test("opens down-right of the pointer when there is room", () => {
            withGeometry({ width: 150, height: 100 }, () => showContextMenu({ x: 100, y: 200 }, entries()));
            const menu = mustQuery<HTMLElement>(document.body, ".ctx-menu");

            expect(menu.style.left).toBe("100px");
            expect(menu.style.top).toBe("200px");
        });

        test("flips up and left near the bottom-right corner", () => {
            withGeometry({ width: 150, height: 100 }, () => showContextMenu({ x: 750, y: 580 }, entries()));
            const menu = mustQuery<HTMLElement>(document.body, ".ctx-menu");

            expect(menu.style.left).toBe("600px"); // 750 - 150
            expect(menu.style.top).toBe("480px"); // 580 - 100
        });
    });
});
