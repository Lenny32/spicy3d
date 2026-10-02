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
    type IVisualObject,
    onFeatureFocusRequested,
    PubSub,
    ShapeTypes,
    Signal,
    VisualStates,
} from "@spicy3d/core";
import {
    createMockHighlighter,
    createMockVisualWithDocument,
    createPlainNode,
    TestDocument,
} from "@spicy3d/core/test-utils";

type DialogButton = { content: string; onclick?: () => void };

const { showDialogMock } = rs.hoisted(() => {
    const fn = (_title: string, content: HTMLElement, confirm?: (() => void) | DialogButton[]) => {
        fn.content = content;
        fn.confirm = typeof confirm === "function" ? confirm : undefined;
        fn.buttons = Array.isArray(confirm) ? confirm : undefined;
    };
    fn.content = undefined as HTMLElement | undefined;
    fn.confirm = undefined as (() => void) | undefined;
    fn.buttons = undefined as DialogButton[] | undefined;
    return { showDialogMock: fn };
});

rs.mock("../src/dialog", () => ({ showDialog: showDialogMock }));

import { closeContextMenu } from "../src/contextMenu";
import menuStyle from "../src/contextMenu.module.css";
import { TimelineBar } from "../src/timeline";
import style from "../src/timeline/timelineBar.module.css";

function iconNode(name: string, icon: string): INode {
    return Object.assign(createPlainNode(name, name), { icon });
}

function bodyNode(name: string, features: FeatureItem[], faces: Record<string, number[]> = {}) {
    return Object.assign(iconNode(name, "icon-body"), {
        featureItems: () => features,
        setFeatureParameter: () => {},
        setFeatureSuppressed: rs.fn((_featureId: string, _suppressed: boolean) => {}),
        moveFeature: () => {},
        renameFeature: rs.fn((_featureId: string, _name: string) => {}),
        removeFeature: rs.fn((_featureId: string) => {}),
        reselectShapes: rs.fn((_featureId: string) => {}),
        activateReference: rs.fn((_featureId: string, _key: string) => {}),
        editFeature: rs.fn((_featureId: string) => {}),
        featureFaces: (featureId: string) => faces[featureId] ?? [],
    });
}

function extrude(id: string, item?: Partial<FeatureItem>): FeatureItem {
    return { id, display: "command.feature.fuse" as I18nKeys, icon: "icon-extrude", parameters: [], ...item };
}

/** A selection announcing every change, as the real one does. */
function testSelection() {
    const onNodeChanged = new Signal<(selected: INode[]) => void>();
    const setSelectedNodes = rs.fn((nodes: INode[], _toggle: boolean) => {
        onNodeChanged.emit(nodes);
        return nodes.length;
    });
    return { selection: { onNodeChanged, setSelectedNodes } as unknown as ISelection, setSelectedNodes };
}

function testDocument() {
    const { selection, setSelectedNodes } = testSelection();
    const document = new TestDocument({ selection });
    const mock = createMockHighlighter();
    const visuals = new Map<INode, IVisualObject>();
    document.visual = createMockVisualWithDocument(document, {
        highlighter: mock.highlighter,
        context: { getVisual: (node: INode) => visuals.get(node) },
    });
    const visualOf = (node: INode) => {
        const visual = { node } as unknown as IVisualObject;
        visuals.set(node, visual);
        return visual;
    };
    return { document, setSelectedNodes, highlighter: mock, visualOf };
}

function setup() {
    const test = testDocument();
    const bar = new TimelineBar({ activeView: undefined } as unknown as IApplication);
    globalThis.document.body.append(bar);
    return { ...test, bar };
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
    const menu = globalThis.document.body.querySelector<HTMLElement>(`.${menuStyle.menu}`);
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
}

function menuLabels(menu: HTMLElement): string[] {
    return [...menu.querySelectorAll<HTMLElement>(`.${menuStyle.item}`)].map((x) => x.textContent ?? "");
}

function chooseMenuItem(menu: HTMLElement, label: string) {
    const item = [...menu.querySelectorAll<HTMLElement>(`.${menuStyle.item}`)].find(
        (x) => x.textContent === label,
    );
    expect(item).toBeDefined();
    item?.click();
}

const t = (key: string, ...args: unknown[]) => I18n.translate(key as I18nKeys, ...args) ?? key;

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
        closeContextMenu();
        globalThis.document.body.innerHTML = "";
        showDialogMock.content = undefined;
        showDialogMock.confirm = undefined;
        showDialogMock.buttons = undefined;
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

    test("accepted timeout displays a warning on the timeline step", () => {
        const { document, bar } = setup();
        const warning =
            "Self-intersection check timed out after 30000 ms (result unknown; geometry not verified)";
        document.modelManager.rootNode.add(bodyNode("Body 1", [extrude("f1", { warning })]));
        show(document);
        const items = entries(bar);
        expect(items).toHaveLength(1);
        expect(items[0].title).toContain(warning);
        expect(items[0].classList.contains(style.warning)).toBe(true);
        expect(items[0].classList.contains(style.error)).toBe(false);
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
        const { document } = testDocument();
        document.modelManager.rootNode.add(iconNode("Sketch 1", "icon-sketch"));
        const bar = new TimelineBar({ activeView: { document } } as unknown as IApplication);

        globalThis.document.body.append(bar);

        expect(entries(bar).map((x) => x.title)).toEqual(["Sketch 1"]);
    });

    test("stops following a document once another one is active", async () => {
        const { document, bar } = setup();
        show(document);
        show(testDocument().document);

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

        chooseMenuItem(rightClick(entries(bar)[0]), t("common.rename"));
        const box = showDialogMock.content as HTMLInputElement;
        expect(box.value).toBe(I18n.translate("command.feature.fuse"));
        box.value = "  Boss ";
        expect(showDialogMock.confirm).toBeTypeOf("function");
        showDialogMock.confirm?.();

        expect(body.renameFeature).toHaveBeenCalledWith("f1", "Boss");
        expect(globalThis.document.body.querySelector(`.${menuStyle.menu}`)).toBeNull();
    });

    test("right-click renames a node", () => {
        const { document, bar } = setup();
        const sketch = iconNode("Sketch 1", "icon-sketch");
        document.modelManager.rootNode.add(sketch);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[0]), t("common.rename"));
        (showDialogMock.content as HTMLInputElement).value = "Profile";
        expect(showDialogMock.confirm).toBeTypeOf("function");
        showDialogMock.confirm?.();

        expect(sketch.name).toBe("Profile");
    });

    test("right-click deletes the last feature at once", () => {
        const { document, bar } = setup();
        const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")]);
        document.modelManager.rootNode.add(body);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[1]), t("common.delete"));

        expect(body.removeFeature).toHaveBeenCalledWith("f2");
        expect(showDialogMock.buttons).toBeUndefined();
    });

    test("deleting a feature later ones may build on asks first", () => {
        const { document, bar } = setup();
        const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")]);
        document.modelManager.rootNode.add(body);
        show(document);

        chooseMenuItem(rightClick(entries(bar)[0]), t("common.delete"));
        expect(body.removeFeature).not.toHaveBeenCalled();
        const confirm = showDialogMock.buttons?.find((x) => x.content === "common.delete");
        expect(confirm?.onclick).toBeTypeOf("function");
        confirm?.onclick?.();

        expect(body.removeFeature).toHaveBeenCalledWith("f1");
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
            chooseMenuItem(rightClick(entries(bar)[0]), t("common.delete"));
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
        const menuOpen = () => globalThis.document.body.querySelector(`.${menuStyle.menu}`) !== null;

        rightClick(entries(bar)[0]);
        globalThis.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(menuOpen()).toBe(false);

        rightClick(entries(bar)[0]);
        globalThis.document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        expect(menuOpen()).toBe(false);
    });

    describe("edit", () => {
        test("a feature's menu edits the feature and the nodes it holds", () => {
            const { document, bar } = setup();
            const sketch = iconNode("Sketch 1", "icon-sketch");
            const body = bodyNode("Body 1", [
                extrude("f1", {
                    display: "command.feature.extrude" as I18nKeys,
                    reselectable: true,
                    references: [{ key: "sketchId", display: "body.sketch" as I18nKeys, node: sketch }],
                }),
            ]);
            document.modelManager.rootNode.add(body);
            show(document);

            const menu = rightClick(entries(bar)[0]);

            expect(menuLabels(menu)).toEqual([
                t("timeline.edit{0}", t("command.feature.extrude")),
                t("timeline.edit{0}", t("body.sketch")),
                t("features.reselect"),
                t("features.suppress"),
                t("common.rename"),
                t("common.delete"),
            ]);
            chooseMenuItem(menu, t("timeline.edit{0}", t("body.sketch")));
            expect(body.activateReference).toHaveBeenCalledWith("f1", "sketchId");
            chooseMenuItem(rightClick(entries(bar)[0]), t("features.reselect"));
            expect(body.reselectShapes).toHaveBeenCalledWith("f1");
        });

        test("editing a feature opens it in the body's feature list", () => {
            const { document, bar, setSelectedNodes } = setup();
            const body = bodyNode("Body 1", [extrude("f1")]);
            document.modelManager.rootNode.add(body);
            show(document);
            const focused: string[] = [];
            const stop = onFeatureFocusRequested((_node, featureId) => focused.push(featureId));
            try {
                chooseMenuItem(rightClick(entries(bar)[0]), t("timeline.edit{0}", t("command.feature.fuse")));
            } finally {
                stop();
            }

            expect(focused).toEqual(["f1"]);
            expect(setSelectedNodes).toHaveBeenCalledWith([body], false);
        });

        test("an editable feature reopens in its interactive session, by menu or double-click", () => {
            const { document, bar } = setup();
            const body = bodyNode("Body 1", [extrude("f1", { editable: true }), extrude("f2")]);
            document.modelManager.rootNode.add(body);
            show(document);

            chooseMenuItem(rightClick(entries(bar)[0]), t("timeline.edit{0}", t("command.feature.fuse")));
            expect(body.editFeature).toHaveBeenCalledWith("f1");
            entries(bar)[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            expect(body.editFeature).toHaveBeenCalledTimes(2);

            // A feature without a session only opens its row.
            entries(bar)[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            expect(body.editFeature).toHaveBeenCalledTimes(2);
        });

        test("suppressing a feature is one undo step", () => {
            const { document, bar } = setup();
            const body = bodyNode("Body 1", [extrude("f1", { suppressed: true })]);
            document.modelManager.rootNode.add(body);
            show(document);

            chooseMenuItem(rightClick(entries(bar)[0]), t("features.unsuppress"));

            expect(body.setFeatureSuppressed).toHaveBeenCalledWith("f1", false);
            expect(document.history.undoCount()).toBe(1);
        });

        test("double-click opens a node the way the tree does (a sketch enters its session)", () => {
            const { document, bar, setSelectedNodes } = setup();
            const sketch = iconNode("Sketch 1", "icon-sketch");
            document.modelManager.rootNode.add(sketch);
            show(document);
            const opened: INode[] = [];
            const onOpen = (node: INode) => opened.push(node);
            PubSub.default.sub("nodeDoubleClicked", onOpen);
            try {
                entries(bar)[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            } finally {
                PubSub.default.remove("nodeDoubleClicked", onOpen);
            }

            expect(opened).toEqual([sketch]);
            expect(setSelectedNodes).toHaveBeenCalledWith([sketch], false);
        });
    });

    describe("highlight", () => {
        const faceHighlight = (visual: IVisualObject, type: number, indexes: number[]) => ({
            shape: visual,
            state: VisualStates.faceHighlight,
            type,
            indexes,
        });

        test("a click on a feature highlights the faces it created", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")], { f1: [0, 1], f2: [4] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);

            entries(bar)[1].click();

            expect(highlighter.addCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [4])]);
        });

        test("a click on a node highlights its whole shape", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const box = iconNode("Box 1", "icon-box");
            const visual = visualOf(box);
            document.modelManager.rootNode.add(box);
            show(document);

            entries(bar)[0].click();

            expect(highlighter.addCalls).toEqual([faceHighlight(visual, ShapeTypes.shape, [])]);
        });

        test("a feature that created no face highlights nothing", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1")]);
            visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);

            entries(bar)[0].click();

            expect(highlighter.addCalls).toEqual([]);
        });

        test("the highlight moves with the next click and goes with the selection", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")], { f1: [0], f2: [1] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);

            entries(bar)[0].click();
            entries(bar)[1].click();
            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [0])]);

            document.selection.setSelectedNodes([], false);
            expect(highlighter.removeCalls).toEqual([
                faceHighlight(visual, ShapeTypes.face, [0]),
                faceHighlight(visual, ShapeTypes.face, [1]),
            ]);
        });

        test("a change to the document takes the highlight off", async () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1")], { f1: [2] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);
            entries(bar)[0].click();

            await commit(document);

            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [2])]);
        });

        test("switching documents takes the highlight off", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1")], { f1: [2] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);
            entries(bar)[0].click();

            show(testDocument().document);

            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [2])]);
        });

        test("hovering a step highlights what it made until the pointer leaves", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")], { f1: [0], f2: [1] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);

            entries(bar)[1].dispatchEvent(new MouseEvent("mouseenter"));
            expect(highlighter.addCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [1])]);

            entries(bar)[1].dispatchEvent(new MouseEvent("mouseleave"));
            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [1])]);
        });

        test("hovering another step stands in for the clicked one's highlight, which comes back", () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1"), extrude("f2")], { f1: [0], f2: [1] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);
            entries(bar)[0].click();

            entries(bar)[1].dispatchEvent(new MouseEvent("mouseenter"));
            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [0])]);
            entries(bar)[1].dispatchEvent(new MouseEvent("mouseleave"));

            expect(highlighter.addCalls).toEqual([
                faceHighlight(visual, ShapeTypes.face, [0]),
                faceHighlight(visual, ShapeTypes.face, [1]),
                faceHighlight(visual, ShapeTypes.face, [0]),
            ]);
            expect(highlighter.removeCalls).toEqual([
                faceHighlight(visual, ShapeTypes.face, [0]),
                faceHighlight(visual, ShapeTypes.face, [1]),
            ]);
        });

        test("a change to the document takes the hover highlight off", async () => {
            const { document, bar, highlighter, visualOf } = setup();
            const body = bodyNode("Body 1", [extrude("f1")], { f1: [2] });
            const visual = visualOf(body);
            document.modelManager.rootNode.add(body);
            show(document);
            entries(bar)[0].dispatchEvent(new MouseEvent("mouseenter"));

            await commit(document);

            expect(highlighter.removeCalls).toEqual([faceHighlight(visual, ShapeTypes.face, [2])]);
        });
    });

    describe("mark", () => {
        const marked = (bar: TimelineBar) =>
            entries(bar).map((x) => x.classList.contains(style.selected) && x.getAttribute("aria-current"));

        test("a click marks the step's icon, the next click moves it, the selection takes it off", () => {
            const { document, bar } = setup();
            document.modelManager.rootNode.add(bodyNode("Body 1", [extrude("f1"), extrude("f2")]));
            show(document);
            expect(marked(bar)).toEqual([false, false]);

            entries(bar)[0].click();
            expect(marked(bar)).toEqual(["true", false]);
            entries(bar)[1].click();
            expect(marked(bar)).toEqual([false, "true"]);

            document.selection.setSelectedNodes([], false);
            expect(marked(bar)).toEqual([false, false]);
        });

        test("an edited step stays marked through its session and across rebuilds", async () => {
            const { document, bar } = setup();
            const body = bodyNode("Body 1", [extrude("f1", { editable: true }), extrude("f2")]);
            const other = iconNode("Box 1", "icon-box");
            document.modelManager.rootNode.add(body, other);
            show(document);

            entries(bar)[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            // The edit session empties the selection, and gives the body back when it ends.
            document.selection.setSelectedNodes([], false);
            expect(marked(bar)).toEqual(["true", false, false]);
            await commit(document);
            expect(marked(bar)).toEqual(["true", false, false]);
            document.selection.setSelectedNodes([body], false);
            expect(marked(bar)).toEqual(["true", false, false]);

            // Past the session, the mark goes with the selection again.
            document.selection.setSelectedNodes([], false);
            expect(marked(bar)).toEqual([false, false, false]);
        });

        test("selecting another node takes an edited step's mark off", () => {
            const { document, bar } = setup();
            const other = iconNode("Box 1", "icon-box");
            document.modelManager.rootNode.add(
                bodyNode("Body 1", [extrude("f1", { editable: true })]),
                other,
            );
            show(document);

            entries(bar)[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            document.selection.setSelectedNodes([other], false);

            expect(marked(bar)).toEqual([false, false]);
        });
    });
});
