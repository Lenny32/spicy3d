// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import type { CommandKeys } from "@spicy3d/core";
import { CommandStore, PubSub } from "@spicy3d/core";

rs.mock("../src/commandSearch/commandSearch.module.css", () => ({
    root: "cs-root",
    input: "cs-input",
    list: "cs-list",
    item: "cs-item",
    selected: "cs-selected",
    icon: "cs-icon",
    text: "cs-text",
}));

import "./_helpers/mockElementRealEvents";

import { CommandSearch, searchCommands } from "../src/commandSearch/commandSearch";

const FILLET = "test.search.fillet" as unknown as CommandKeys;
const FILL = "test.search.fill" as unknown as CommandKeys;
const MOVE = "test.search.move" as unknown as CommandKeys;
const KEYS = [FILLET, FILL, MOVE];

/** A class per command: CommandStore keeps the data on the constructor's prototype. */
const commandClass = () =>
    class {
        async execute() {}
    };

function press(target: HTMLElement, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("CommandSearch", () => {
    beforeEach(() => {
        for (const key of KEYS) CommandStore.registerCommand(commandClass(), { key, icon: "icon-x" });
    });

    afterEach(() => {
        for (const key of KEYS) CommandStore.unregisterCommand(key);
        document.body.querySelectorAll(".cs-root").forEach((el) => el.remove());
        PubSub.default.removeAll("executeCommand");
    });

    test("searchCommands should keep only matches, earliest match first", () => {
        const results = searchCommands("search.fil");
        expect(results).toContain(FILLET);
        expect(results).toContain(FILL);
        expect(results).not.toContain(MOVE);
    });

    test("searchCommands should never offer the search command itself", () => {
        expect(searchCommands("commandSearch")).not.toContain("edit.commandSearch");
    });

    test("typing should filter the list", () => {
        const popup = CommandSearch.open({ x: 10, y: 10 });
        popup.input.value = "search.move";
        popup.input.dispatchEvent(new Event("input"));
        expect(popup.results).toEqual([MOVE]);
        expect(popup.querySelectorAll(".cs-item").length).toBe(1);
        expect(popup.querySelector(".cs-selected")).not.toBeNull();
    });

    test("ArrowDown then Enter should run the second match and close", () => {
        const published: CommandKeys[] = [];
        PubSub.default.sub("executeCommand", (cmd) => published.push(cmd));
        const popup = CommandSearch.open({ x: 10, y: 10 });
        popup.input.value = "search.fil";
        popup.input.dispatchEvent(new Event("input"));
        expect(popup.results.length).toBe(2);
        const second = popup.results[1];

        press(popup.input, "ArrowDown");
        expect(popup.selectedIndex).toBe(1);
        press(popup.input, "Enter");

        expect(published).toEqual([second]);
        expect(popup.isConnected).toBe(false);
    });

    test("Escape should close without running anything", () => {
        const published: CommandKeys[] = [];
        PubSub.default.sub("executeCommand", (cmd) => published.push(cmd));
        const popup = CommandSearch.open({ x: 10, y: 10 });
        press(popup.input, "Escape");
        expect(popup.isConnected).toBe(false);
        expect(published).toEqual([]);
    });

    test("a pointerdown outside should close the popup", () => {
        const popup = CommandSearch.open({ x: 10, y: 10 });
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(popup.isConnected).toBe(false);
    });

    test("opening again should replace the open popup", () => {
        const first = CommandSearch.open({ x: 10, y: 10 });
        const second = CommandSearch.open({ x: 20, y: 20 });
        expect(first.isConnected).toBe(false);
        expect(second.isConnected).toBe(true);
    });
});
