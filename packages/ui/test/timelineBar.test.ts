// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    type FeatureItem,
    I18n,
    type I18nKeys,
    type IApplication,
    type IFeatureListNode,
    type INode,
    type ISelection,
    type IView,
    PubSub,
} from "@spicy3d/core";
import { createPlainNode, TestDocument } from "@spicy3d/core/test-utils";

const { showDialogMock } = rs.hoisted(() => {
    const fn = (_title: string, content: HTMLElement, onConfirm?: () => void) => {
        fn.content = content;
        fn.confirm = onConfirm;
    };
    fn.content = undefined as HTMLElement | undefined;
    fn.confirm = undefined as (() => void) | undefined;
    return { showDialogMock: fn };
});

rs.mock("../src/dialog", () => ({ showDialog: showDialogMock }));

import { TimelineBar } from "../src/timeline";
import style from "../src/timeline/timelineBar.module.css";

function iconNode(name: string, icon: string): INode {
    return Object.assign(createPlainNode(name, name), { icon });
}

function bodyNode(name: string, features: FeatureItem[]) {
    return Object.assign(iconNode(name, "icon-body"), {
        featureItems: () => features,
        setFeatureParameter: () => {},
        setFeatureSuppressed: () => {},
        moveFeature: () => {},
        renameFeature: rs.fn((_featureId: string, _name: string) => {}),
        removeFeature: rs.fn((_featureId: string) => {}),
    }) as INode & IFeatureListNode & { renameFeature: ReturnType<typeof rs.fn> };
}

function extrude(id: string, item?: Partial<FeatureItem>): FeatureItem {
    return { id, display: "command.feature.fuse" as I18nKeys, icon: "icon-extrude", parameters: [], ...item };
}

function setup() {
    const setSelectedNodes = rs.fn((nodes: INode[], _toggle: boolean) => nodes.length);
    const document = new TestDocument({ selection: { setSelectedNodes } as unknown as ISelection });
    const bar = new TimelineBar({ activeView: undefined } as unknown as IApplication);
    globalThis.document.body.append(bar);
    return { document, bar, setSelectedNodes };
}

function show(document: TestDocument) {
    PubSub.default.pub("activeViewChanged", { document } as unknown as IView);
}

function entries(bar: TimelineBar): HTMLElement[] {
    return [...bar.querySelectorAll<HTMLElement>(`.${style.entry}`)];
}

/** A committed change: what makes the bar re-read the document. */
async function commit(document: TestDocument) {
    document.history.add({ name: "change", undo: () => {}, redo: () => {}, dispose: () => {} });
    await Promise.resolve();
}

function rightClick(item: HTMLElement): HTMLElement {
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const menu = globalThis.document.body.querySelector<HTMLElement>(`.${style.menu}`);
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
}

function chooseMenuItem(menu: HTMLElement, index: number) {
    menu.querySelectorAll<HTMLElement>(`.${style.menuItem}`)[index].click();
}

describe("TimelineBar", () => {
    const scrolled: HTMLElement[] = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

    beforeEach(() => {
        HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
            scrolled.push(this);
        };
    });

    afterEach(() => {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
        scrolled.length = 0;
        PubSub.default.pub("activeViewChanged", undefined);
        globalThis.document.body.innerHTML = "";
        showDialogMock.content = undefined;
        showDialogMock.confirm = undefined;
    });

    test("is hidden without a document and shows one icon per step of the active one", () => {
        const { document, bar } = setup();
        expect(bar.classList.contains(style.hidden)).toBe(true);
        const body = bodyNode("Body 1", [extrude("f1"), extrude("f2", { name: "Boss", suppressed: true })]);
        document.modelManager.rootNode.add(iconNode("Sketch 1", "icon-sketch"), body);

        show(document);

        expect(bar.classList.contains(style.hidden)).toBe(false);
        const items = entries(bar);
        expect(items.map((x) => x.title)).toEqual([
            "Sketch 1",
            I18n.translate("timeline.feature{0}{1}", I18n.translate("command.feature.fuse"), "Body 1"),
            I18n.translate("timeline.feature{0}{1}", "Boss", "Body 1"),
        ]);
        expect(items[2].classList.contains(style.suppressed)).toBe(true);
        expect(items[0].querySelector("use")?.getAttribute("xlink:href")).toBe("#icon-sketch");
    });

    test("a failing feature is marked and says why on hover", () => {
        const { document, bar } = setup();
        document.modelManager.rootNode.add(bodyNode("Body 1", [extrude("f1", { error: "No profile" })]));

        show(document);

        const [item] = entries(bar);
        expect(item.classList.contains(style.error)).toBe(true);
        expect(item.title.endsWith("\nNo profile")).toBe(true);
    });

    test("follows the history and scrolls a new step into view, not the ones already there", async () => {
        const { document, bar } = setup();
        document.modelManager.rootNode.add(iconNode("Sketch 1", "icon-sketch"));
        show(document);
        expect(scrolled).toEqual([]);

        document.modelManager.rootNode.add(iconNode("Box 1", "icon-box"));
        await commit(document);

        const items = entries(bar);
        expect(items.map((x) => x.title)).toEqual(["Sketch 1", "Box 1"]);
        expect(scrolled).toEqual([items[1]]);

        await commit(document);
        expect(scrolled).toHaveLength(1);
    });

    test("opens on the document already active when it is attached", () => {
        const document = new TestDocument();
        document.modelManager.rootNode.add(iconNode("Sketch 1", "icon-sketch"));
        const bar = new TimelineBar({ activeView: { document } } as unknown as IApplication);

        globalThis.document.body.append(bar);

        expect(entries(bar).map((x) => x.title)).toEqual(["Sketch 1"]);
    });

    test("stops following a document once another one is active", async () => {
        const { document, bar } = setup();
        show(document);
        show(new TestDocument());

        document.modelManager.rootNode.add(iconNode("Box 1", "icon-box"));
        await commit(document);

        expect(entries(bar)).toEqual([]);
    });

    test("the mouse wheel scrolls the strip sideways", () => {
        const { document, bar } = setup();
        show(document);
        const track = bar.firstElementChild as HTMLElement;
        track.scrollLeft = 0;
        const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });

        track.dispatchEvent(wheel);

        expect(wheel.defaultPrevented).toBe(true);
        expect(track.scrollLeft).toBe(40);
    });

    test("a click selects the step's node", () => {
        const { document, bar, setSelectedNodes } = setup();
        const sketch = iconNode("Sketch 1", "icon-sketch");
        document.modelManager.rootNode.add(sketch);
        show(document);

        entries(bar)[0].click();

        expect(setSelectedNodes).toHaveBeenCalledWith([sketch], false);
    });

    test("right-click renames a feature in one undo step", () => {
        const { document, bar } = setup();
        const body = bodyNode("Body 1", [extrude("f1")]);
        document.modelManager.rootNode.add(body);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[0]), 0);
        const box = showDialogMock.content as HTMLInputElement;
        expect(box.value).toBe(I18n.translate("command.feature.fuse"));
        box.value = "  Boss ";
        expect(showDialogMock.confirm).toBeTypeOf("function");
        showDialogMock.confirm?.();

        expect(body.renameFeature).toHaveBeenCalledWith("f1", "Boss");
        expect(globalThis.document.body.querySelector(`.${style.menu}`)).toBeNull();
    });

    test("right-click renames a node", () => {
        const { document, bar } = setup();
        const sketch = iconNode("Sketch 1", "icon-sketch");
        document.modelManager.rootNode.add(sketch);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[0]), 0);
        (showDialogMock.content as HTMLInputElement).value = "Profile";
        expect(showDialogMock.confirm).toBeTypeOf("function");
        showDialogMock.confirm?.();

        expect(sketch.name).toBe("Profile");
    });

    test("right-click deletes a feature", () => {
        const { document, bar } = setup();
        const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")]);
        document.modelManager.rootNode.add(body);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[1]), 1);

        expect(body.removeFeature).toHaveBeenCalledWith("f2");
    });

    test("right-click deletes a node through the delete command", () => {
        const { document, bar, setSelectedNodes } = setup();
        const sketch = iconNode("Sketch 1", "icon-sketch");
        document.modelManager.rootNode.add(sketch);
        show(document);
        const executed: string[] = [];
        const onExecute = (command: string) => executed.push(command);
        PubSub.default.sub("executeCommand", onExecute);
        try {
            chooseMenuItem(rightClick(entries(bar)[0]), 1);
        } finally {
            PubSub.default.remove("executeCommand", onExecute);
        }

        expect(setSelectedNodes).toHaveBeenCalledWith([sketch], false);
        expect(executed).toEqual(["modify.deleteNode"]);
    });

    test("the menu closes on Escape and on a click elsewhere", () => {
        const { document, bar } = setup();
        document.modelManager.rootNode.add(iconNode("Sketch 1", "icon-sketch"));
        show(document);
        const menuOpen = () => globalThis.document.body.querySelector(`.${style.menu}`) !== null;

        rightClick(entries(bar)[0]);
        globalThis.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(menuOpen()).toBe(false);

        rightClick(entries(bar)[0]);
        globalThis.document.body.click();
        expect(menuOpen()).toBe(false);
    });
});
