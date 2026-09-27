// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, test } from "@rstest/core";
import type { CommandKeys, PulldownButton } from "@spicy3d/core";
import { CommandStore, PubSub } from "@spicy3d/core";

// CSS modules under test
rs.mock("../src/ribbon/ribbonButton.module.css", () => ({
    normal: "rb-normal",
    small: "rb-small",
    icon: "rb-icon",
    smallIcon: "rb-small-icon",
    largeButtonText: "rb-large-text",
    smallButtonText: "rb-small-text",
    checked: "rb-checked",
}));

rs.mock("../src/ribbon/ribbonPulldownButton.module.css", () => ({
    pulldown: "rpd-pulldown",
    pulldownSmall: "rpd-pulldown-small",
    smallText: "rpd-text-small",
    arrow: "rpd-arrow",
    smallArrow: "rpd-arrow-small",
    dropdown: "rpd-dropdown",
    dropdownItem: "rpd-dropdown-item",
    dropdownIcon: "rpd-dropdown-icon",
    dropdownText: "rpd-dropdown-text",
}));

// Mock element helpers — real events so el.click() triggers handlers
import "./_helpers/mockElementRealEvents";

import { RibbonPulldownButton } from "../src/ribbon/ribbonPulldownButton";
import { mustQuery } from "./_helpers/domHelpers";

const CMD_A = "test.pulldown.a" as unknown as CommandKeys;
const CMD_B = "test.pulldown.b" as unknown as CommandKeys;

class TestCommand {
    async execute() {}
}

function makeData(items: PulldownButton["items"]): PulldownButton {
    return { type: "pulldown", icon: "icon-pulldown", display: "Test" as never, items } as PulldownButton;
}

describe("RibbonPulldownButton", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(CMD_A);
        CommandStore.unregisterCommand(CMD_B);
        document.body.querySelectorAll(".rpd-dropdown").forEach((el) => el.remove());
    });

    describe("rendering", () => {
        test("should render large pulldown icon-only with arrow, name in the tooltip", () => {
            const btn = new RibbonPulldownButton(makeData([]), "large");
            expect(btn.className).toBe("rpd-pulldown");

            const icon = btn.querySelector("svg");
            expect(icon).not.toBeNull();
            expect(icon!.getAttribute("icon")).toBe("icon-pulldown");
            expect(icon!.classList.contains("rb-icon")).toBe(true);

            expect(btn.querySelector("label")).toBeNull();
            expect(btn.title).not.toBe("");

            expect(btn.querySelector(".rpd-arrow")).not.toBeNull();
        });

        test("should render small pulldown with small classes", () => {
            const btn = new RibbonPulldownButton(makeData([]), "small");
            expect(btn.className).toBe("rpd-pulldown-small");
            const icon = btn.querySelector("svg");
            expect(icon).not.toBeNull();
            expect(icon!.classList.contains("rb-small-icon")).toBe(true);
            expect(btn.querySelector(".rpd-text-small")).not.toBeNull();
            expect(btn.querySelector(".rpd-arrow-small")).not.toBeNull();
        });
    });

    describe("dropdown", () => {
        test("should not open dropdown when items are empty", () => {
            const btn = new RibbonPulldownButton(makeData([]), "large");
            document.body.appendChild(btn);
            try {
                btn.click();
                expect(document.body.querySelector(".rpd-dropdown")).toBeNull();
            } finally {
                btn.dispose();
                btn.remove();
            }
        });

        test("should open dropdown with all items on click", () => {
            CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
            CommandStore.registerCommand(TestCommand, { key: CMD_B, icon: "icon-b" });
            const btn = new RibbonPulldownButton(makeData([CMD_A, CMD_B]), "large");
            document.body.appendChild(btn);
            try {
                btn.click();
                const dropdown = document.body.querySelector(".rpd-dropdown");
                expect(dropdown).not.toBeNull();
                expect(dropdown!.querySelectorAll(".rpd-dropdown-item").length).toBe(2);
            } finally {
                btn.dispose();
                btn.remove();
            }
        });

        test("should toggle dropdown closed on second click", () => {
            CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
            const btn = new RibbonPulldownButton(makeData([CMD_A]), "large");
            document.body.appendChild(btn);
            try {
                btn.click();
                expect(document.body.querySelector(".rpd-dropdown")).not.toBeNull();
                btn.click();
                expect(document.body.querySelector(".rpd-dropdown")).toBeNull();
            } finally {
                btn.dispose();
                btn.remove();
            }
        });

        test("should publish executeCommand and close dropdown when item clicked", () => {
            CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
            const published: string[] = [];
            const callback = (cmd: string) => published.push(cmd);
            PubSub.default.sub("executeCommand", callback);
            const btn = new RibbonPulldownButton(makeData([CMD_A]), "large");
            document.body.appendChild(btn);
            try {
                btn.click();
                const item = mustQuery(document.body, ".rpd-dropdown-item");
                item.click();
                expect(published).toContain(CMD_A);
                expect(document.body.querySelector(".rpd-dropdown")).toBeNull();
            } finally {
                PubSub.default.remove("executeCommand", callback);
                btn.dispose();
                btn.remove();
            }
        });
    });
});
