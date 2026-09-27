// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, test } from "@rstest/core";
import type { CommandKeys, PushButton, RibbonCommand } from "@spicy3d/core";
import { CommandStore, ObservableCollection, PubSub, RibbonGroup } from "@spicy3d/core";

// CSS modules under test (plus those of buttons created via createRibbonButton)
rs.mock("../src/ribbon/ribbonGroup.module.css", () => ({
    ribbonGroup: "rg-group",
    content: "rg-content",
    headerContainer: "rg-header-container",
    header: "rg-header",
    arrow: "rg-arrow",
    collapsedDropdown: "rg-collapsed-dropdown",
    collapsedDropdownItem: "rg-collapsed-item",
    collapsedDropdownIcon: "rg-collapsed-icon",
    collapsedDropdownText: "rg-collapsed-text",
    separator: "rg-separator",
    finish: "rg-finish",
}));

rs.mock("../src/ribbon/ribbonStack.module.css", () => ({
    root: "rs-root",
}));

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
    text: "rpd-text",
    smallText: "rpd-text-small",
    arrow: "rpd-arrow",
    smallArrow: "rpd-arrow-small",
    dropdown: "rpd-dropdown",
    dropdownItem: "rpd-dropdown-item",
    dropdownIcon: "rpd-dropdown-icon",
    dropdownText: "rpd-dropdown-text",
}));

rs.mock("../src/ribbon/ribbonSplitButton.module.css", () => ({
    split: "rsb-split",
    splitSmall: "rsb-split-small",
    mainArea: "rsb-main",
    smallMainArea: "rsb-main-small",
    arrowButton: "rsb-arrow-btn",
    smallArrowButton: "rsb-arrow-btn-small",
    arrow: "rsb-arrow",
    smallArrow: "rsb-arrow-small",
    text: "rsb-text",
    smallText: "rsb-text-small",
    dropdown: "rsb-dropdown",
    dropdownItem: "rsb-dropdown-item",
    dropdownIcon: "rsb-dropdown-icon",
    dropdownText: "rsb-dropdown-text",
}));

// Mock element helpers — real events so el.click() triggers handlers
import "./_helpers/mockElementRealEvents";

import { RibbonPushButton } from "../src/ribbon/ribbonButton";
import {
    createRibbonButton,
    flattenGroupItems,
    groupMenuItems,
    RibbonGroupElement,
} from "../src/ribbon/ribbonGroup";
import { RibbonPulldownButton } from "../src/ribbon/ribbonPulldownButton";
import { RibbonSplitButton } from "../src/ribbon/ribbonSplitButton";
import { RibbonStack } from "../src/ribbon/ribbonStack";
import { mustQuery } from "./_helpers/domHelpers";

const CMD_A = "test.group.a" as unknown as CommandKeys;
const CMD_B = "test.group.b" as unknown as CommandKeys;
const CMD_C = "test.group.c" as unknown as CommandKeys;
const CMD_D = "test.group.d" as unknown as CommandKeys;

class TestCommand {
    async execute() {}
}

function makePushButton(command: CommandKeys): PushButton {
    return { type: "push", size: "large", command, icon: "icon-test", onClick: () => {} } as PushButton;
}

function makeGroup(items: RibbonCommand[] = [], collapsedItems: CommandKeys[] = []): RibbonGroup {
    return new RibbonGroup("group.test" as RibbonGroup["groupName"], items, collapsedItems);
}

describe("RibbonStack", () => {
    test("should apply root class", () => {
        const stack = new RibbonStack();
        expect(stack.className).toBe("rs-root");
    });
});

describe("createRibbonButton", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(CMD_A);
        CommandStore.unregisterCommand(CMD_B);
    });

    test("should create push button from registered command name", () => {
        CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
        const el = createRibbonButton(CMD_A);
        expect(el).toBeInstanceOf(RibbonPushButton);
    });

    test("should create stack of small buttons from ObservableCollection", () => {
        CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
        CommandStore.registerCommand(TestCommand, { key: CMD_B, icon: "icon-b" });
        const el = createRibbonButton(new ObservableCollection<CommandKeys>(CMD_A, CMD_B));
        expect(el).toBeInstanceOf(RibbonStack);
        expect(el.childElementCount).toBe(2);
        expect(el.children[0].className).toBe("rb-small");
    });

    test("should create push button from push item", () => {
        const el = createRibbonButton(makePushButton(CMD_A));
        expect(el).toBeInstanceOf(RibbonPushButton);
    });

    test("should create pulldown button from pulldown item", () => {
        const el = createRibbonButton({
            type: "pulldown",
            icon: "icon-pd",
            display: "PD" as never,
            items: [],
        } as RibbonCommand);
        expect(el).toBeInstanceOf(RibbonPulldownButton);
    });

    test("should create split button from split item", () => {
        const el = createRibbonButton({
            type: "split",
            items: [makePushButton(CMD_A)],
        } as RibbonCommand);
        expect(el).toBeInstanceOf(RibbonSplitButton);
    });

    test("should throw for unknown item type", () => {
        expect(() => createRibbonButton({ type: "unknown" } as unknown as RibbonCommand)).toThrow(
            "unknown ribbon button type",
        );
    });
});

describe("RibbonGroupElement", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(CMD_A);
        CommandStore.unregisterCommand(CMD_B);
        document.body.querySelectorAll(".rg-collapsed-dropdown").forEach((el) => el.remove());
    });

    test("should render group with content buttons and header", () => {
        const group = makeGroup([makePushButton(CMD_A), makePushButton(CMD_B)]);
        const el = new RibbonGroupElement(group);
        expect(el.className).toBe("rg-group");

        // The collection mock does not apply className — the content container is the
        // first child appended by initHTML.
        const content = el.children[0] as HTMLElement;
        expect(content).toBeInstanceOf(HTMLElement);
        expect(content.childElementCount).toBe(2);

        const header = el.querySelector(".rg-header");
        expect(header).not.toBeNull();

        expect(el.querySelector(".rg-arrow")).not.toBeNull();
    });

    test("should not open collapsed dropdown when collapsedItems is empty", () => {
        const el = new RibbonGroupElement(makeGroup());
        document.body.appendChild(el);
        try {
            mustQuery(el, ".rg-arrow").click();
            expect(document.body.querySelector(".rg-collapsed-dropdown")).toBeNull();
        } finally {
            el.dispose();
            el.remove();
        }
    });

    test("should open collapsed dropdown with collapsed items on arrow click", () => {
        CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
        CommandStore.registerCommand(TestCommand, { key: CMD_B, icon: "icon-b" });
        const group = makeGroup([], [CMD_A, CMD_B]);
        const el = new RibbonGroupElement(group);
        document.body.appendChild(el);
        try {
            mustQuery(el, ".rg-arrow").click();
            const dropdown = document.body.querySelector(".rg-collapsed-dropdown");
            expect(dropdown).not.toBeNull();
            expect(dropdown!.querySelectorAll(".rg-collapsed-item").length).toBe(2);
        } finally {
            el.dispose();
            el.remove();
        }
    });

    test("should publish executeCommand and close when collapsed item clicked", () => {
        CommandStore.registerCommand(TestCommand, { key: CMD_A, icon: "icon-a" });
        const published: string[] = [];
        const callback = (cmd: string) => published.push(cmd);
        PubSub.default.sub("executeCommand", callback);
        const group = makeGroup([], [CMD_A]);
        const el = new RibbonGroupElement(group);
        document.body.appendChild(el);
        try {
            mustQuery(el, ".rg-arrow").click();
            const item = mustQuery(document.body, ".rg-collapsed-item");
            item.click();
            expect(published).toContain(CMD_A);
            expect(document.body.querySelector(".rg-collapsed-dropdown")).toBeNull();
        } finally {
            PubSub.default.remove("executeCommand", callback);
            el.dispose();
            el.remove();
        }
    });
});

describe("group menu", () => {
    test("should invoke a custom button callback and close without dispatching its command", () => {
        const onClick = rs.fn(() => {});
        const published = rs.fn((_command: CommandKeys) => {});
        const button = { ...makePushButton(CMD_A), onClick };
        const el = new RibbonGroupElement(makeGroup([button]));
        PubSub.default.sub("executeCommand", published);
        document.body.appendChild(el);
        try {
            mustQuery(el, ".rg-header").click();
            mustQuery(document.body, ".rg-collapsed-item").click();
            expect(onClick).toHaveBeenCalledTimes(1);
            expect(published).not.toHaveBeenCalled();
            expect(document.body.querySelector(".rg-collapsed-dropdown")).toBeNull();
        } finally {
            PubSub.default.remove("executeCommand", published);
            el.dispose();
            el.remove();
        }
    });

    const menuKeys = (items: (PushButton | CommandKeys)[]) =>
        items.map((x) => (typeof x === "string" ? x : x.command));

    afterEach(() => {
        for (const key of [CMD_A, CMD_B, CMD_C, CMD_D]) CommandStore.unregisterCommand(key);
        document.body.querySelectorAll(".rg-collapsed-dropdown").forEach((el) => el.remove());
    });

    test("flattenGroupItems should expand stacks, split and pulldown buttons", () => {
        const items: RibbonCommand[] = [
            CMD_A,
            new ObservableCollection(CMD_B, CMD_C),
            { type: "split", items: [CMD_D, CMD_A] } as RibbonCommand,
            { type: "pulldown", icon: "i", display: "x" as never, items: [CMD_B] } as RibbonCommand,
            makePushButton(CMD_C),
        ];
        expect(menuKeys(flattenGroupItems(items))).toEqual([CMD_A, CMD_B, CMD_C, CMD_D, CMD_A, CMD_B, CMD_C]);
    });

    test("groupMenuItems should list each command once, buttons before menu-only items", () => {
        const group = makeGroup([CMD_A, new ObservableCollection(CMD_B, CMD_A)], [CMD_B, CMD_C]);
        const { items, collapsed } = groupMenuItems(group);
        expect(menuKeys(items)).toEqual([CMD_A, CMD_B]);
        expect(menuKeys(collapsed)).toEqual([CMD_C]);
    });

    test("clicking the label should open a menu of every item, a separator, then collapsed items", () => {
        for (const key of [CMD_A, CMD_B, CMD_C, CMD_D]) {
            CommandStore.registerCommand(TestCommand, { key, icon: "icon-x" });
        }
        const group = makeGroup([CMD_A, new ObservableCollection(CMD_B, CMD_C)], [CMD_D]);
        const el = new RibbonGroupElement(group);
        document.body.appendChild(el);
        try {
            mustQuery(el, ".rg-header").click();
            const dropdown = mustQuery(document.body, ".rg-collapsed-dropdown");
            const children = [...dropdown.children];
            expect(children.map((c) => c.className)).toEqual([
                "rg-collapsed-item",
                "rg-collapsed-item",
                "rg-collapsed-item",
                "rg-separator",
                "rg-collapsed-item",
            ]);
        } finally {
            el.dispose();
            el.remove();
        }
    });

    test("a primary group should get the finish class", () => {
        const group = RibbonGroup.fromProfile({
            groupName: "ribbon.group.finish",
            items: [],
            primary: true,
        });
        expect(new RibbonGroupElement(group).className).toBe("rg-group rg-finish");
    });
});
