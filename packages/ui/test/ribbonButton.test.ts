// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import type { CommandData, CommandKeys, I18nKeys } from "@spicy3d/core";
import { Binding, CommandStore, Config, Observable, PubSub, ShortcutProfiles } from "@spicy3d/core";

// CSS module under test
rs.mock("../src/ribbon/ribbonButton.module.css", () => ({
    normal: "rb-normal",
    small: "rb-small",
    icon: "rb-icon",
    smallIcon: "rb-small-icon",
    largeButtonText: "rb-large-text",
    smallButtonText: "rb-small-text",
    checked: "rb-checked",
    iconOnly: "rb-icon-only",
}));

// Mock element helpers
import "./_helpers/mockElement";

import { RibbonPushButton, RibbonToggleButton } from "../src/ribbon/ribbonButton";

class TestCommand {
    async execute() {}
}

const PUSH_KEY = "test.ribbon.push" as unknown as CommandKeys;
const TOGGLE_KEY = "test.ribbon.toggle" as unknown as CommandKeys;

function registerPushCommand() {
    CommandStore.registerCommand(TestCommand, { key: PUSH_KEY, icon: "icon-test-push" });
}

function registerToggleCommand(obs: Observable, prop: string) {
    CommandStore.registerCommand(TestCommand, {
        key: TOGGLE_KEY,
        icon: "icon-test-toggle",
        toggle: new Binding(obs, prop as keyof Observable),
    });
}

class ToggleState extends Observable {
    get checked() {
        return this.getPrivateValue("checked", false);
    }
    set checked(value: boolean) {
        this.setProperty("checked", value);
    }
}

describe("RibbonPushButton", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(PUSH_KEY);
        CommandStore.unregisterCommand(TOGGLE_KEY);
    });

    describe("constructor", () => {
        test("should render large button icon-only, name in the tooltip", () => {
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", () => {});
            expect(btn.className).toBe("rb-normal rb-icon-only");

            const icon = btn.querySelector("svg");
            expect(icon).not.toBeNull();
            expect(icon!.getAttribute("icon")).toBe("icon-test");
            expect(icon!.classList.contains("rb-icon")).toBe(true);

            expect(btn.querySelector("label")).toBeNull();
            expect(btn.title).toBe(`command.${PUSH_KEY}`);
        });

        test("should drop the small button's text when iconOnly", () => {
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "small", () => {}, undefined, true);
            expect(btn.className).toBe("rb-small rb-icon-only");
            expect(btn.querySelector("svg")).not.toBeNull();
            expect(btn.querySelector("label")).toBeNull();
        });

        test("should render small button with small classes", () => {
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "small", () => {});
            expect(btn.className).toBe("rb-small");

            const icon = btn.querySelector("svg");
            expect(icon).not.toBeNull();
            expect(icon!.classList.contains("rb-small-icon")).toBe(true);

            const text = btn.querySelector("label");
            expect(text).not.toBeNull();
            expect(text!.className).toBe("rb-small-text");
        });

        test("should set title from default display key", () => {
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", () => {});
            expect(btn.title).toBe(`command.${PUSH_KEY}`);
        });

        test("should use provided display key for title", () => {
            const btn = new RibbonPushButton(
                PUSH_KEY,
                "icon-test",
                "large",
                () => {},
                "common.ok" as unknown as I18nKeys,
            );
            expect(btn.title).toBe("common.ok");
        });
    });

    describe("click", () => {
        test("should invoke onClick callback", () => {
            const onClick = rs.fn(() => {});
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", onClick);
            btn.click();
            expect(onClick).toHaveBeenCalledTimes(1);
        });

        test("should not invoke onClick after dispose", () => {
            const onClick = rs.fn(() => {});
            const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", onClick);
            btn.dispose();
            btn.click();
            expect(onClick).not.toHaveBeenCalled();
        });
    });

    describe("fromCommandName", () => {
        test("should return undefined for unregistered command", () => {
            const button = RibbonPushButton.fromCommandName(
                "test.ribbon.missing" as unknown as CommandKeys,
                "large",
            );
            expect(button).toBeUndefined();
        });

        test("should create push button that publishes executeCommand on click", () => {
            registerPushCommand();
            const published: string[] = [];
            const callback = (cmd: string) => published.push(cmd);
            PubSub.default.sub("executeCommand", callback);
            try {
                const btn = RibbonPushButton.fromCommandName(PUSH_KEY, "large");
                expect(btn).toBeInstanceOf(RibbonPushButton);
                btn!.click();
                expect(published).toContain(PUSH_KEY);
            } finally {
                PubSub.default.remove("executeCommand", callback);
            }
        });

        test("should create toggle button when command data has toggle binding", () => {
            const state = new ToggleState();
            registerToggleCommand(state, "checked");
            const btn = RibbonPushButton.fromCommandName(TOGGLE_KEY, "large");
            expect(btn).toBeInstanceOf(RibbonToggleButton);
        });
    });

    describe("updateShortcut", () => {
        test("should append shortcut to title and update it on change", () => {
            const profile = ShortcutProfiles[Config.instance.navigation3D].global;
            profile[PUSH_KEY] = "Ctrl+T";
            try {
                const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", () => {});
                expect(btn.title).toBe(`command.${PUSH_KEY} (Ctrl+T)`);
                expect(btn.shortcut).toBe("Ctrl+T");

                profile[PUSH_KEY] = "Ctrl+U";
                btn.updateShortcut();
                expect(btn.title).toBe(`command.${PUSH_KEY} (Ctrl+U)`);
            } finally {
                delete profile[PUSH_KEY];
            }
        });

        test("should remove shortcut from title when shortcut is cleared", () => {
            const profile = ShortcutProfiles[Config.instance.navigation3D].global;
            profile[PUSH_KEY] = "Ctrl+T";
            try {
                const btn = new RibbonPushButton(PUSH_KEY, "icon-test", "large", () => {});
                expect(btn.shortcut).toBe("Ctrl+T");

                delete profile[PUSH_KEY];
                btn.updateShortcut();
                expect(btn.title).not.toContain("Ctrl+T");
                expect(btn.shortcut).toBeUndefined();
            } finally {
                delete profile[PUSH_KEY];
            }
        });
    });
});

describe("RibbonToggleButton", () => {
    afterEach(() => {
        CommandStore.unregisterCommand(TOGGLE_KEY);
    });

    function createToggleButton(initial: boolean) {
        const state = new ToggleState();
        state.checked = initial;
        const data: CommandData = {
            key: TOGGLE_KEY,
            icon: "icon-toggle",
            toggle: new Binding(state, "checked"),
        };
        const btn = new RibbonToggleButton(data, "large");
        return { state, btn };
    }

    test("should reflect checked state in className", () => {
        const { btn } = createToggleButton(true);
        expect(btn.className).toBe("rb-normal rb-icon-only rb-checked");
    });

    test("should not have checked class when unchecked", () => {
        const { btn } = createToggleButton(false);
        expect(btn.className).toBe("rb-normal rb-icon-only");
    });

    test("should toggle checked class when bound property changes", () => {
        const { state, btn } = createToggleButton(false);
        expect(btn.classList.contains("rb-checked")).toBe(false);

        state.checked = true;
        expect(btn.classList.contains("rb-checked")).toBe(true);

        state.checked = false;
        expect(btn.classList.contains("rb-checked")).toBe(false);
    });

    test("should publish executeCommand with command key on click", () => {
        const published: string[] = [];
        const callback = (cmd: string) => published.push(cmd);
        PubSub.default.sub("executeCommand", callback);
        try {
            const { btn } = createToggleButton(false);
            btn.click();
            expect(published).toContain(TOGGLE_KEY);
        } finally {
            PubSub.default.remove("executeCommand", callback);
        }
    });
});
