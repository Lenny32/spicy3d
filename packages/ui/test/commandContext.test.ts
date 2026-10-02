// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import type { AsyncController, I18nKeys, INode, INodeList, Locale, ParameterValue } from "@spicy3d/core";
import {
    CancelableCommand,
    Combobox,
    CommandStore,
    I18n,
    LENGTH_UNITS,
    Observable,
    PathBinding,
    PropertyUtils,
    PubSub,
    property,
} from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";

// CSS module under test
rs.mock("../src/ribbon/commandContext.module.css", () => ({
    panel: "cc-panel",
    container: "cc-container",
    command: "cc-command",
    icon: "cc-icon",
    title: "cc-title",
    closeButton: "cc-close-button",
    row: "cc-row",
    footer: "cc-footer",
    primaryButton: "cc-primary-button",
    selectionSummary: "cc-selection-summary",
    cancelButton: "cc-cancel",
    selectionButton: "cc-selection-button",
    selectionControl: "cc-selection-control",
    selectionInfo: "cc-selection-info",
    selectionCount: "cc-selection-count",
    selectionCountLabel: "cc-selection-count-label",
    group: "cc-group",
    select: "cc-select",
    input: "cc-input",
    button: "cc-button",
    materialButton: "cc-material-button",
    nodeList: "cc-node-list",
    nodeItem: "cc-node-item",
    nodeName: "cc-node-name",
    nodeRemove: "cc-node-remove",
    nodeAdd: "cc-node-add",
    active: "cc-active",
}));

// Mock element helpers
import "./_helpers/mockElement";

import { CommandContext } from "../src/ribbon/commandContext";
import { mustQuery } from "./_helpers/domHelpers";

const CMD_KEY = "test.context.command";
const CANCEL_CMD_KEY = "test.context.cancelable";
const MATERIAL_CMD_KEY = "test.context.material";
const LENGTH_CMD_KEY = "test.context.length";
const LIVE_CMD_KEY = "test.context.live";

class TestCommand extends Observable {
    async execute() {}

    private _flag = false;
    @property("test.flag" as I18nKeys)
    get flag() {
        return this._flag;
    }
    set flag(value: boolean) {
        this._flag = value;
    }

    private _size = 1;
    @property("test.size" as I18nKeys)
    get size() {
        return this._size;
    }
    set size(value: number) {
        this._size = value;
    }

    private _name = "abc";
    @property("test.name" as I18nKeys)
    get name() {
        return this._name;
    }
    set name(value: string) {
        this._name = value;
    }

    private _mode = "a";
    @property("test.mode" as I18nKeys)
    get mode() {
        return this._mode;
    }
    set mode(value: string) {
        this.setProperty("mode", value);
    }

    private _detail = 1;
    @property("test.detail" as I18nKeys, { dependencies: [{ property: "mode", value: "b" }] })
    get detail() {
        return this._detail;
    }
    set detail(value: number) {
        this._detail = value;
    }

    choice = "x";
    @property("test.choice" as I18nKeys, {
        combobox: Combobox.from(["x", "y"]),
    })
    get choiceProp() {
        return this.choice;
    }
    set choiceProp(value: string) {
        this.choice = value;
    }

    actionCalled = 0;
    @property("test.action" as I18nKeys)
    action() {
        this.actionCalled++;
    }
}

/** A combobox whose "auto" item reads its label from the command (see `Combobox.withLiveLabel`). */
class LiveLabelCommand extends Observable {
    async execute() {}

    @property("test.live" as I18nKeys, {
        combobox: Combobox.from(["test.live.auto", "test.live.other"]).withLiveLabel(
            "test.live.auto",
            "autoLabel",
        ),
    })
    get choice() {
        return this.getPrivateValue("choice", "test.live.auto");
    }
    set choice(value: string) {
        this.setProperty("choice", value);
    }

    get autoLabel(): string {
        return this.getPrivateValue("autoLabel", "test.live.auto");
    }
    set autoLabel(value: string) {
        this.setProperty("autoLabel", value);
    }
}

class CancelableTestCommand extends Observable {
    async execute() {}
    cancel = rs.fn(async () => {});
}

/** A command whose field is a dimensional one, so expressions are accepted there. */
class LengthCommand extends Observable {
    readonly document = new TestDocument();

    private _depth: ParameterValue = 0;
    @property("test.depth" as I18nKeys, { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this._depth;
    }
    set depth(value: ParameterValue) {
        this._depth = value;
    }

    async execute() {}
}

class MaterialCommand extends Observable {
    async execute() {}
    private _materialId = "m1";
    @property("test.material" as I18nKeys, { type: "materialId" })
    get materialId() {
        return this._materialId;
    }
    set materialId(value: string) {
        this._materialId = value;
    }
}

const NODE_LIST_CMD_KEY = "test.context.nodeList";
const PICK_CMD_KEY = "test.context.pick";

const namedNode = (name: string) => ({ id: name, name }) as unknown as INode;

/** A command listing nodes in its options tab (an `INodeList` property). */
class NodeListCommand extends Observable {
    async execute() {}

    readonly left = namedNode("Left");
    readonly right = namedNode("Right");
    readonly removed = rs.fn((_node: INode) => {});
    readonly toggled = rs.fn(() => {});

    @property("test.bodies" as I18nKeys, { type: "nodeList" })
    get bodies(): INodeList | undefined {
        return this.getPrivateValue("bodies", undefined);
    }
    set bodies(value: INodeList | undefined) {
        this.setProperty("bodies", value);
    }

    list(nodes: INode[], options: { label?: string; fixed?: INode[]; adding?: boolean } = {}): INodeList {
        return {
            label: options.label,
            nodes,
            fixed: options.fixed,
            remove: this.removed,
            add: options.adding === undefined ? undefined : { active: options.adding, toggle: this.toggled },
        };
    }
}

/** A running command whose document's selection is a plain list (for a node pick's control). */
class PickCommand extends CancelableCommand {
    selected: INode[] = [];
    private readonly handlers = new Set<(nodes: INode[]) => void>();
    readonly deselect = rs.fn((nodes: INode[], _toggle: boolean) => {
        this.selected = this.selected.filter((x) => !nodes.includes(x));
        for (const handler of this.handlers) handler(this.selected);
        return nodes.length;
    });
    private readonly selection = {
        getSelectedNodes: () => this.selected,
        getSelectedShapes: () => [],
        getSelectedNodeLength: () => this.selected.length,
        setSelectedNodes: this.deselect,
        onNodeChanged: {
            sub: (handler: (nodes: INode[]) => void) => this.handlers.add(handler),
            remove: (handler: (nodes: INode[]) => void) => this.handlers.delete(handler),
        },
        onShapeChanged: { sub: () => {}, remove: () => {} },
    };

    override get document() {
        return { selection: this.selection } as never;
    }

    protected async executeAsync() {}
}

const clickWithEvent = (el: Element) =>
    (el as unknown as { _onclick: (e: unknown) => void })._onclick({ stopPropagation: () => {} });

function findInput(ctx: CommandContext, type: string): HTMLInputElement {
    return mustQuery(ctx, `input[type='${type}']`);
}

describe("CommandContext", () => {
    let contexts: CommandContext[];

    beforeEach(() => {
        contexts = [];
        CommandStore.registerCommand(TestCommand, { key: CMD_KEY, icon: "icon-ctx" });
        CommandStore.registerCommand(CancelableTestCommand, { key: CANCEL_CMD_KEY, icon: "icon-ctx" });
        CommandStore.registerCommand(MaterialCommand, { key: MATERIAL_CMD_KEY, icon: "icon-ctx" });
        CommandStore.registerCommand(LengthCommand, { key: LENGTH_CMD_KEY, icon: "icon-ctx" });
        CommandStore.registerCommand(NodeListCommand, { key: NODE_LIST_CMD_KEY, icon: "icon-ctx" });
        CommandStore.registerCommand(PickCommand, { key: PICK_CMD_KEY, icon: "icon-ctx" });
        // I18n.isI18nKey (used by the combobox editor) reads the en translation table
        I18n.addLanguage({ display: "English", language: "en", translation: {} as Locale["translation"] });
    });

    afterEach(() => {
        contexts.forEach((c) => {
            c.remove();
            c.dispose();
        });
        CommandStore.unregisterCommand(CMD_KEY);
        CommandStore.unregisterCommand(CANCEL_CMD_KEY);
        CommandStore.unregisterCommand(MATERIAL_CMD_KEY);
        CommandStore.unregisterCommand(LENGTH_CMD_KEY);
        CommandStore.unregisterCommand(NODE_LIST_CMD_KEY);
        CommandStore.unregisterCommand(PICK_CMD_KEY);
        I18n.removeLanguage("en");
    });

    function track(ctx: CommandContext): CommandContext {
        contexts.push(ctx);
        return ctx;
    }

    describe("header", () => {
        test("names the panel and associates every editable field with its label", () => {
            const ctx = track(new CommandContext(new TestCommand()));
            const title = mustQuery(ctx, ".cc-title");
            expect(ctx.getAttribute("role")).toBe("region");
            expect(ctx.getAttribute("aria-labelledby")).toBe(title.id);
            const controls = ctx.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
            expect(controls.length).toBe(6);
            expect(new Set([...controls].map((control) => control.id)).size).toBe(6);
            for (const control of controls) {
                expect(control.id).not.toBe("");
                expect(mustQuery<HTMLLabelElement>(control.parentElement!, "label").htmlFor).toBe(control.id);
            }
        });

        test("the header close button cancels the active command", () => {
            const command = new CancelableTestCommand();
            const ctx = track(new CommandContext(command));
            const close = mustQuery<HTMLButtonElement>(ctx, ".cc-close-button");
            expect(close.type).toBe("button");
            expect(close.getAttribute("aria-label")).toBe(I18n.translate("common.cancel"));
            (close as unknown as { _onclick: () => void })._onclick();
            expect(command.cancel).toHaveBeenCalledTimes(1);
        });

        test("should render command icon and title", () => {
            const ctx = track(new CommandContext(new TestCommand()));
            expect(ctx.className).toBe("cc-panel");

            const header = mustQuery(ctx, ".cc-command");

            const icon = mustQuery(header, "svg");
            expect(icon.getAttribute("icon")).toBe("icon-ctx");
            expect(icon.classList.contains("cc-icon")).toBe(true);

            mustQuery(header, ".cc-title");
        });

        test("should not render cancel button for non-cancelable command", () => {
            const ctx = track(new CommandContext(new TestCommand()));
            expect(ctx.querySelector(".cc-cancel")).toBeNull();
        });
    });

    test("mounts a session form once and keeps it through selection confirmation", () => {
        const command = new CancelableTestCommand();
        const form = document.createElement("div");
        const input = document.createElement("input");
        input.value = "12";
        const apply = document.createElement("button");
        apply.textContent = "Create";
        form.append(input, apply);
        const ctx = track(new CommandContext(command, form));
        document.body.append(ctx);

        expect(mustQuery(ctx, ".cc-container").firstElementChild).toBe(form);
        expect(ctx.querySelectorAll("input").length).toBe(1);
        expect(ctx.querySelector(".cc-cancel")).toBeNull();
        const close = mustQuery(ctx, ".cc-close-button");
        const controller = { success: rs.fn(() => {}), cancel: rs.fn(() => {}) };
        PubSub.default.pub("showSelectionControl", controller as unknown as AsyncController);
        expect(form.inert).toBe(true);
        const buttons = ctx.querySelectorAll(".cc-selection-control .cc-selection-button");
        expect(buttons.length).toBe(2);
        (buttons[1] as unknown as { _onclick: () => void })._onclick();
        expect(controller.success).toHaveBeenCalledTimes(1);

        PubSub.default.pub("clearSelectionControl");
        expect(form.inert).toBe(false);
        expect(mustQuery(ctx, ".cc-container").firstElementChild).toBe(form);
        expect(input.value).toBe("12");
        (close as unknown as { _onclick: () => void })._onclick();
        expect(command.cancel).toHaveBeenCalledTimes(1);
    });

    describe("dragging", () => {
        const hosts: HTMLElement[] = [];
        afterEach(() => {
            hosts.splice(0).forEach((host) => host.remove());
        });

        function draggableContext() {
            const host = document.createElement("div");
            hosts.push(host);
            Object.defineProperties(host, {
                clientWidth: { value: 1000 },
                clientHeight: { value: 700 },
            });
            rs.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 1000, 700));
            const ctx = track(new CommandContext(new CancelableTestCommand()));
            Object.defineProperty(ctx, "offsetParent", { value: host });
            rs.spyOn(ctx, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 62, 320, 400));
            host.append(ctx);
            document.body.append(host);
            return { ctx, header: mustQuery(ctx, ".cc-command") };
        }

        function pointer(target: EventTarget, type: string, x: number, y: number, pointerId = 3) {
            target.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    button: 0,
                    pointerId,
                    clientX: x,
                    clientY: y,
                }),
            );
        }

        test("moves by the header without moving the viewport", () => {
            const { ctx, header } = draggableContext();
            pointer(header, "pointerdown", 420, 80);
            expect(header.hasPointerCapture(3)).toBe(true);
            pointer(document, "pointermove", 320, 180);
            expect(ctx.style.left).toBe("200px");
            expect(ctx.style.top).toBe("112px");
            expect(ctx.style.right).toBe("auto");
            pointer(document, "pointerup", 320, 180);
            expect(header.hasPointerCapture(3)).toBe(false);
        });

        test.each([
            { x: -1000, y: -1000, left: "8px", top: "8px" },
            { x: 2000, y: 2000, left: "548px", top: "292px" },
        ])("keeps a dragged panel visible and outside the navigation strip ($x, $y)", ({
            x,
            y,
            left,
            top,
        }) => {
            const { ctx, header } = draggableContext();
            pointer(header, "pointerdown", 420, 80);
            pointer(document, "pointermove", x, y);
            expect(ctx.style.left).toBe(left);
            expect(ctx.style.top).toBe(top);
            pointer(document, "pointerup", x, y);
        });

        test("the close button and other pointers do not drag the panel", () => {
            const { ctx, header } = draggableContext();
            pointer(mustQuery(ctx, ".cc-close-button"), "pointerdown", 420, 80);
            pointer(document, "pointermove", 320, 180);
            expect(ctx.style.left).toBe("");
            pointer(header, "pointerdown", 420, 80);
            pointer(document, "pointermove", 320, 180, 4);
            expect(ctx.style.left).toBe("");
            pointer(document, "pointerup", 320, 180, 4);
            pointer(document, "pointermove", 320, 180);
            expect(ctx.style.left).toBe("200px");
            pointer(document, "pointerup", 320, 180);
        });

        test.each(["pointerup", "pointercancel", "lostpointercapture"])("stops dragging on %s", (event) => {
            const { ctx, header } = draggableContext();
            pointer(header, "pointerdown", 420, 80);
            pointer(document, "pointermove", 320, 180);
            pointer(event === "lostpointercapture" ? header : document, event, 320, 180);
            pointer(document, "pointermove", 520, 280);
            expect(ctx.style.left).toBe("200px");
            expect(ctx.style.top).toBe("112px");
        });

        test("removing the panel releases an active drag", () => {
            const { ctx, header } = draggableContext();
            pointer(header, "pointerdown", 420, 80);
            pointer(document, "pointermove", 320, 180);
            ctx.remove();
            pointer(document, "pointermove", 520, 280);
            expect(ctx.style.left).toBe("200px");
            expect(ctx.style.top).toBe("112px");
        });
    });

    describe("dimensional fields", () => {
        function dimensionalContext(
            variables: { name: string; expression: string; type?: "length" | "angle" }[],
        ) {
            const command = new LengthCommand();
            command.document.variables.setItems(
                variables.map((x, index) => ({
                    id: `v${index}`,
                    name: x.name,
                    expression: x.expression,
                    type: x.type ?? "length",
                })),
            );
            const ctx = track(new CommandContext(command));
            const input = mustQuery<HTMLInputElement>(ctx, "input[type='text']");
            return {
                command,
                input,
                type: (value: string) => {
                    // The real element is the target: a refusal is supposed to put the field
                    // back to the command's own value, and that is only observable here.
                    input.value = value;
                    (input as unknown as { _onblur: (e: { target: HTMLInputElement }) => void })._onblur({
                        target: input,
                    });
                },
            };
        }

        test("stores a parameter name as written, not what it resolves to", () => {
            const { command, type } = dimensionalContext([{ name: "w", expression: "50" }]);

            type("w * 2");

            // The relation is what a feature keeps — that is what lets a later edit to `w`
            // carry through instead of freezing today's number.
            expect(command.depth).toBe("w * 2");
        });

        test("stores a plain number as a number", () => {
            const { command, type } = dimensionalContext([]);

            type("25");

            expect(command.depth).toBe(25);
        });

        test("refuses an expression the parameters cannot resolve", () => {
            const { command, type } = dimensionalContext([]);

            type("nope");

            expect(command.depth).toBe(0);
        });

        test("refuses a value of the wrong dimension", () => {
            const { command, type } = dimensionalContext([{ name: "a", expression: "45", type: "angle" }]);

            type("a");

            expect(command.depth).toBe(0);
        });

        // A field left showing text the command refused is a lie the user confirms against:
        // nothing re-renders the binding (a plain setter emits no property change), so the
        // refusal has to put the value back itself.
        test.each([
            { value: "nope", variables: [] as { name: string; expression: string; type?: "angle" }[] },
            { value: "a", variables: [{ name: "a", expression: "45", type: "angle" as const }] },
        ])("a refused `$value` does not stay in the field", ({ value, variables }) => {
            const { command, input, type } = dimensionalContext(variables);

            type(value);

            expect(command.depth).toBe(0);
            expect(input.value).toBe("0");
        });

        test("an accepted expression is what the field goes on showing", () => {
            const { input, type } = dimensionalContext([{ name: "w", expression: "50" }]);

            type("w * 2");

            expect(input.value).toBe("w * 2");
        });
    });

    describe("property controls", () => {
        test("boolean property should render checkbox that toggles the property", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            const checkbox = findInput(ctx, "checkbox");
            expect(command.flag).toBe(false);

            (checkbox as unknown as { _onclick: () => void })._onclick();
            expect(command.flag).toBe(true);

            (checkbox as unknown as { _onclick: () => void })._onclick();
            expect(command.flag).toBe(false);
        });

        test("number property should render text input that parses on blur", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            const inputs = ctx.querySelectorAll("input[type='text']");
            expect(inputs.length).toBeGreaterThan(0);
            // first text input is the number property (declared before the string one)
            const input = inputs[0] as HTMLInputElement;
            (input as unknown as { _onblur: (e: { target: { value: string } }) => void })._onblur({
                target: { value: "3.5" },
            });
            expect(command.size).toBe(3.5);
        });

        test("string property should render text input that assigns on blur", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            const inputs = ctx.querySelectorAll("input[type='text']");
            const input = inputs[1] as HTMLInputElement;
            (input as unknown as { _onblur: (e: { target: { value: string } }) => void })._onblur({
                target: { value: "hello" },
            });
            expect(command.name).toBe("hello");
        });

        test("function property should render button that invokes the method", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            const button = mustQuery(ctx, "button");

            (button as unknown as { _onclick: () => void })._onclick();
            expect(command.actionCalled).toBe(1);
        });

        test("combobox property should render select and assign selected item on change", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            const select = mustQuery<HTMLSelectElement>(ctx, "select");
            expect(select.querySelectorAll("option").length).toBe(2);

            (
                select as unknown as { _onchange: (e: { target: { selectedIndex: number } }) => void }
            )._onchange({
                target: { selectedIndex: 1 },
            });
            expect(command.choice).toBe("y");
        });

        test("combobox selection should follow the command property value, not the shared combobox state", () => {
            const combobox = PropertyUtils.getProperty(TestCommand.prototype, "choiceProp")!.combobox!;
            const originalIndex = combobox.selectedIndex;
            try {
                // Stale shared state left over from a previous execution must not win over
                // the command property value (default "x").
                combobox.selectedIndex = 1;
                const ctx1 = track(new CommandContext(new TestCommand()));
                const options1 = mustQuery<HTMLSelectElement>(ctx1, "select").querySelectorAll("option");
                expect((options1[0] as any)._selected).toBe(true);
                expect((options1[1] as any)._selected).toBe(false);

                combobox.selectedIndex = 0;
                const command = new TestCommand();
                command.choice = "y";
                const ctx2 = track(new CommandContext(command));
                const options2 = mustQuery<HTMLSelectElement>(ctx2, "select").querySelectorAll("option");
                expect((options2[0] as any)._selected).toBe(false);
                expect((options2[1] as any)._selected).toBe(true);
            } finally {
                combobox.selectedIndex = originalIndex;
            }
        });
    });

    test("a live-labelled combobox item follows the command's label property", () => {
        I18n.combineTranslation("en", {
            "test.live.auto": "Auto",
            "test.live.auto.cut": "Auto (Cut)",
            "test.live.other": "Other",
        });
        CommandStore.registerCommand(LiveLabelCommand, { key: LIVE_CMD_KEY, icon: "icon-ctx" });
        try {
            const command = new LiveLabelCommand();
            const ctx = track(new CommandContext(command));
            const options = mustQuery<HTMLSelectElement>(ctx, "select").querySelectorAll("option");
            expect(options).toHaveLength(2);
            const binding = (options[0] as any)._textContent;
            expect(binding).toBeInstanceOf(PathBinding);
            const shown = { textContent: "" };
            binding.setBinding(shown, "textContent");
            expect(shown.textContent).toBe("Auto");

            command.autoLabel = "test.live.auto.cut";

            expect(shown.textContent).toBe("Auto (Cut)");
            // Other items keep their static label.
            expect((options[1] as any)._textContent).not.toBeInstanceOf(PathBinding);
            binding.removeBinding();
        } finally {
            CommandStore.unregisterCommand(LIVE_CMD_KEY);
        }
    });

    test("a combobox follows a value the command sets itself (an edit session loading its own)", () => {
        CommandStore.registerCommand(LiveLabelCommand, { key: LIVE_CMD_KEY, icon: "icon-ctx" });
        try {
            const command = new LiveLabelCommand();
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);
            const box = mustQuery<HTMLSelectElement>(ctx, "select");

            command.choice = "test.live.other";
            expect(box.selectedIndex).toBe(1);
            command.choice = "test.live.auto";
            expect(box.selectedIndex).toBe(0);
        } finally {
            CommandStore.unregisterCommand(LIVE_CMD_KEY);
        }
    });

    describe("dependent property visibility", () => {
        test("should hide dependent property until dependency matches, then reveal on change", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            // detail depends on mode === "b"; mode starts as "a" so detail is hidden.
            // The detail control is the text input inside the second group — locate it
            // via the property order: detail input is the last text input.
            const inputs = ctx.querySelectorAll("input[type='text']");
            const detailInput = inputs[inputs.length - 1] as HTMLInputElement;
            const detailControl = detailInput.parentElement as HTMLElement;
            expect(detailControl).not.toBeNull();
            expect(detailControl.style.display).toBe("none");

            command.mode = "b";
            expect(detailControl.style.display).toBe("");

            command.mode = "a";
            expect(detailControl.style.display).toBe("none");
        });
    });

    describe("cancelable command", () => {
        test("should render cancel button that calls command.cancel", () => {
            const command = new CancelableTestCommand();
            const ctx = track(new CommandContext(command));
            const cancelButton = mustQuery(ctx, ".cc-cancel .cc-selection-button");

            (cancelButton as unknown as { _onclick: () => void })._onclick();
            expect(command.cancel).toHaveBeenCalledTimes(1);
        });
    });

    describe("selection control", () => {
        test("keeps editable fields and their values across selection steps", () => {
            const command = new TestCommand();
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);
            const input = findInput(ctx, "text");
            input.value = "7";
            const controller = { success: rs.fn(() => {}), cancel: rs.fn(() => {}) };

            PubSub.default.pub("showSelectionControl", controller as unknown as AsyncController);
            expect(findInput(ctx, "text")).toBe(input);
            expect(input.value).toBe("7");
            (input as unknown as { _onblur: (e: { target: HTMLInputElement }) => void })._onblur({
                target: input,
            });
            expect(command.size).toBe(7);

            PubSub.default.pub("clearSelectionControl");
            expect(findInput(ctx, "text")).toBe(input);
            expect(mustQuery(ctx, ".cc-container").parentElement).toBe(ctx);
            expect(input.value).toBe("7");
        });

        test("should show selection control on pubsub event and call controller on confirm", () => {
            const command = new CancelableTestCommand();
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            const controller = { success: rs.fn(() => {}), cancel: rs.fn(() => {}) };
            PubSub.default.pub("showSelectionControl", controller as unknown as AsyncController);

            const control = ctx.querySelector(".cc-selection-control");
            expect(control).not.toBeNull();
            // close icon hidden while selection control is shown
            const closeIcon = mustQuery(ctx, ".cc-cancel");
            expect(closeIcon.style.display).toBe("none");

            const buttons = control!.querySelectorAll(".cc-selection-button");
            expect(buttons.length).toBe(2);
            expect(buttons[1].tagName).toBe("BUTTON");
            expect((buttons[1] as HTMLButtonElement).type).toBe("button");
            (buttons[1] as unknown as { _onclick: () => void })._onclick();
            expect(controller.success).toHaveBeenCalledTimes(1);

            PubSub.default.pub("clearSelectionControl");
            expect(ctx.querySelector(".cc-selection-control")).toBeNull();
            expect(closeIcon.style.display).toBe("");
        });

        test("should call controller.cancel on cancel button click", () => {
            const command = new CancelableTestCommand();
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            const controller = { success: rs.fn(() => {}), cancel: rs.fn(() => {}) };
            PubSub.default.pub("showSelectionControl", controller as unknown as AsyncController);

            const buttons = ctx.querySelectorAll(".cc-selection-control .cc-selection-button");
            expect(buttons.length).toBe(2);
            expect(buttons[0].tagName).toBe("BUTTON");
            (buttons[0] as unknown as { _onclick: () => void })._onclick();
            expect(controller.cancel).toHaveBeenCalledTimes(1);

            PubSub.default.pub("clearSelectionControl");
        });
    });

    describe("node list property", () => {
        const names = (root: Element) =>
            [...root.querySelectorAll(".cc-node-name")].map((x) => x.textContent);

        test("shows one entry per node under its caption; a remove button hands the node back", () => {
            const command = new NodeListCommand();
            command.bodies = command.list([command.left, command.right], {
                label: "Objects to cut: 2 bodies",
            });
            const ctx = track(new CommandContext(command));

            const list = mustQuery(ctx, ".cc-node-list");
            expect(list.previousElementSibling?.textContent).toBe("Objects to cut: 2 bodies");
            expect(names(ctx)).toEqual(["Left", "Right"]);
            const removes = ctx.querySelectorAll(".cc-node-remove");
            expect(removes.length).toBe(2);

            clickWithEvent(removes[1]);
            expect(command.removed.mock.calls).toEqual([[command.right]]);
        });

        test("fixed nodes have no remove button; without an add toggle there is no add button", () => {
            const command = new NodeListCommand();
            command.bodies = command.list([command.left, command.right], { fixed: [command.left] });
            const ctx = track(new CommandContext(command));

            const items = ctx.querySelectorAll(".cc-node-item");
            expect(items.length).toBe(2);
            expect(items[0].querySelector(".cc-node-remove")).toBeNull();
            expect(items[1].querySelector(".cc-node-remove")).not.toBeNull();
            expect(ctx.querySelector(".cc-node-add")).toBeNull();
        });

        test("the add button toggles, shows when it is on, and the list redraws on a new value", () => {
            const command = new NodeListCommand();
            command.bodies = command.list([command.left], { adding: false });
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            const add = mustQuery(ctx, ".cc-node-add");
            expect(add.classList.contains("cc-active")).toBe(false);
            clickWithEvent(add);
            expect(command.toggled).toHaveBeenCalledTimes(1);

            command.bodies = command.list([command.left, command.right], { adding: true });
            expect(names(ctx)).toEqual(["Left", "Right"]);
            expect(mustQuery(ctx, ".cc-node-add").classList.contains("cc-active")).toBe(true);
        });

        test("without a caption the property's display name is shown; no value = an empty list", () => {
            const command = new NodeListCommand();
            const ctx = track(new CommandContext(command));

            const list = mustQuery(ctx, ".cc-node-list");
            expect(list.childElementCount).toBe(0);
            expect(list.previousElementSibling?.textContent).toBe(I18n.translate("test.bodies" as I18nKeys));
        });
    });

    describe("node pick selection control", () => {
        const show = (options?: { nodes?: boolean }) => {
            const controller = { success: rs.fn(() => {}), cancel: rs.fn(() => {}) };
            PubSub.default.pub("showSelectionControl", controller as unknown as AsyncController, options);
        };

        test("lists the picked nodes; a remove button deselects one", () => {
            const command = new PickCommand();
            const left = namedNode("Left");
            const right = namedNode("Right");
            command.selected = [left, right];
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            show({ nodes: true });

            const control = mustQuery(ctx, ".cc-selection-control");
            const listed = () => [...control.querySelectorAll(".cc-node-name")].map((x) => x.textContent);
            expect(listed()).toEqual(["Left", "Right"]);

            clickWithEvent(control.querySelectorAll(".cc-node-remove")[0]);
            expect(command.deselect.mock.calls).toEqual([[[left], true]]);
            expect(listed()).toEqual(["Right"]);
            expect(mustQuery(control, ".cc-selection-count").textContent).toBe("1");
            // Confirm and cancel stay the only selection buttons.
            expect(control.querySelectorAll(".cc-selection-button").length).toBe(2);

            PubSub.default.pub("clearSelectionControl");
        });

        test("a shape pick's control lists nothing", () => {
            const command = new PickCommand();
            command.selected = [namedNode("Left")];
            const ctx = track(new CommandContext(command));
            document.body.appendChild(ctx);

            show();

            expect(mustQuery(ctx, ".cc-selection-control").querySelector(".cc-node-list")).toBeNull();
            PubSub.default.pub("clearSelectionControl");
        });
    });

    describe("material property", () => {
        test("should throw for materialId property on non-cancelable command", () => {
            expect(() => new CommandContext(new MaterialCommand())).toThrow(
                "MaterialEditor only support CancelableCommand",
            );
        });
    });
});
