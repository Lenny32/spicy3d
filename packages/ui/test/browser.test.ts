// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Act,
    BrowserProviders,
    FolderNode,
    I18n,
    type INode,
    type IVisualObject,
    Mesh,
    MeshNode,
    NodeSelectionHandler,
    ShapeTypes,
    VisualStates,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { SelectionManager } from "../../app/src/selectionManager";
import { closeContextMenu } from "../src/contextMenu";
import { Browser } from "../src/project/browser";
import { mustQuery } from "./_helpers/domHelpers";
import "./_helpers/cssMocks";

rs.mock("../src/project/browser.module.css", () => ({
    browser: "browser",
    content: "content",
    row: "row",
    selected: "selected",
    focused: "focused",
    control: "control",
    icon: "icon",
    typeIcon: "typeIcon",
    name: "name",
    rename: "rename",
    warning: "warning",
    swatch: "swatch",
    hiddenObject: "hiddenObject",
    dropTarget: "dropTarget",
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
    closeContextMenu();
    while (cleanup.length) cleanup.pop()!();
});

function setup(count = 2) {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    const visuals = new Map<INode, IVisualObject>();
    const addState = rs.fn((_visual: IVisualObject, _state: number, _type: number) => {});
    doc.visual = createMockVisualWithDocument(doc, {
        highlighter: { addState },
        context: {
            getVisual: (node) => visuals.get(node),
            getNode: (visual) => [...visuals].find(([, item]) => item === visual)?.[0],
        },
    });
    doc.selection = new SelectionManager(doc);
    const handler = new NodeSelectionHandler(doc, false);
    doc.visual.eventHandler = handler;
    const owner = new FolderNode({ document: doc, name: "Base" });
    doc.modelManager.addNode(owner);
    const nodes = Array.from(
        { length: count },
        (_, index) => new MeshNode({ document: doc, name: `Body${index}`, mesh: new Mesh() }),
    );
    owner.add(...nodes);
    for (const node of nodes) visuals.set(node, {} as IVisualObject);
    const browser = new Browser(doc);
    window.document.body.append(browser);
    const row = (key: string) => mustQuery<HTMLElement>(browser, `[data-key="${key}"]`);
    cleanup.push(() => {
        browser.dispose();
        doc.selection.dispose();
        handler.dispose();
        doc.dispose();
    });
    return { browser, doc, owner, nodes, row, visuals, addState, app };
}

describe("Browser interactions", () => {
    test("CAD type artwork updates independently from the accessible visibility control", () => {
        const { row, nodes, owner, doc } = setup();
        const href = (key: string, selector = "[data-type-icon] use") =>
            mustQuery(row(key), selector).getAttributeNS("http://www.w3.org/1999/xlink", "href");
        expect(href(doc.modelManager.rootNode.id)).toBe("#icon-browser-document");
        expect(href(owner.id)).toBe("#icon-browser-component");
        expect(href(nodes[0].id)).toBe("#icon-browser-mesh");
        const visibility = mustQuery<HTMLButtonElement>(row(nodes[0].id), "[data-visibility]");
        expect(visibility.getAttribute("aria-label")).toBe(I18n.translate("items.menu.hide"));
        visibility.click();
        expect(visibility.getAttribute("aria-label")).toBe(I18n.translate("items.menu.show"));
        expect(href(nodes[0].id, "[data-visibility] use")).toBe("#icon-eye-slash");
        expect(href(nodes[0].id)).toBe("#icon-browser-mesh");
        const nested = new FolderNode({ document: doc, name: "Nested" });
        owner.add(nested);
        expect(href(owner.id)).toBe("#icon-browser-assembly");
        const folder = row(`${owner.id}:category:bodies`);
        expect(
            mustQuery(folder, "[data-type-icon] use").getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        ).toBe("#icon-browser-folder-open");
        mustQuery<HTMLButtonElement>(folder, "[data-expand]").click();
        expect(
            mustQuery(folder, "[data-type-icon] use").getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        ).toBe("#icon-browser-folder");
    });

    test("provider descriptions refresh CAD icons and preserve custom type artwork", () => {
        const { browser, row, nodes } = setup();
        for (const [type, expected] of [
            ["sketch", "#icon-browser-sketch"],
            ["extension-object", "#icon-measure"],
        ]) {
            const unregister = BrowserProviders.register({
                describe: (node) =>
                    node === nodes[0] ? { type, category: "objects", icon: "icon-measure" } : undefined,
            });
            try {
                browser.reveal(nodes[0].id);
                expect(
                    mustQuery(row(nodes[0].id), "[data-type-icon] use").getAttributeNS(
                        "http://www.w3.org/1999/xlink",
                        "href",
                    ),
                ).toBe(expected);
                expect(
                    mustQuery(row(nodes[0].id), "[data-visibility] use").getAttributeNS(
                        "http://www.w3.org/1999/xlink",
                        "href",
                    ),
                ).toBe("#icon-eye");
            } finally {
                unregister();
            }
        }
    });

    test("dragging an object into a valid component changes model ownership", () => {
        const { browser, doc, row, nodes } = setup();
        const target = new FolderNode({ document: doc, name: "Target" });
        doc.modelManager.addNode(target);
        row(nodes[0].id).dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
        row(target.id).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
        expect(nodes[0].parent).toBe(target);
        expect(browser.model.entries.get(nodes[0].id)?.parentKey).toBe(`${target.id}:category:bodies`);
        doc.history.undo();
        expect(nodes[0].parent?.name).toBe("Base");
    });

    test("read-only objects cannot be renamed, deleted, or have visibility changed from the Browser", () => {
        const { browser, doc, row, nodes } = setup();
        Object.assign(doc.repository, { isReadOnly: true });
        row(nodes[0].id).click();
        browser.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
        expect(row(nodes[0].id).querySelector("input")).toBeNull();
        const visibility = mustQuery<HTMLButtonElement>(row(nodes[0].id), "[data-visibility]");
        expect(visibility.disabled).toBe(true);
        visibility.click();
        expect(nodes[0].visible).toBe(true);
        browser.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        expect(nodes[0].parent?.name).toBe("Base");
    });
    test("selection highlights objects, Ctrl toggles, and Shift selects visible object rows", () => {
        const { doc, row, nodes, addState, visuals } = setup(4);
        row(nodes[0].id).click();
        expect(doc.selection.getSelectedNodes()).toEqual([nodes[0]]);
        expect(row(nodes[0].id).getAttribute("aria-selected")).toBe("true");
        expect(addState).toHaveBeenCalledWith(
            visuals.get(nodes[0]),
            VisualStates.edgeSelected,
            ShapeTypes.shape,
        );
        expect(doc.modelManager.currentNode).toBeUndefined();
        row(nodes[2].id).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        expect(doc.selection.getSelectedNodes()).toEqual([nodes[0], nodes[2]]);
        row(nodes[2].id).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        expect(doc.selection.getSelectedNodes()).toEqual([nodes[0]]);
        row(nodes[0].id).click();
        row(nodes[3].id).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        expect(doc.selection.getSelectedNodes()).toEqual(nodes);
    });

    test("component selection highlights its bodies; double-click explicitly activates it", () => {
        const { browser, doc, owner, row, nodes, addState } = setup();
        row(owner.id).click();
        expect(doc.selection.getSelectedNodes()).toEqual([owner]);
        expect(addState).toHaveBeenCalledTimes(nodes.length);
        row(owner.id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(browser.model.activeKey).toBe(owner.id);
        expect(doc.modelManager.currentNode).toBe(owner);
        expect(mustQuery(row(owner.id), "[data-active]").textContent).toBe("●");
    });

    test("viewport picks reveal collapsed components while preserving subshape selection", () => {
        const { browser, doc, owner, row, nodes, visuals } = setup();
        mustQuery<HTMLButtonElement>(row(owner.id), "[data-expand]").click();
        expect(browser.querySelector(`[data-key="${nodes[0].id}"]`)).toBeNull();
        doc.selection.setSelectedNodes([nodes[0]], false);
        expect(row(owner.id).getAttribute("aria-expanded")).toBe("true");
        doc.selection.clearSelection();
        const pick = {
            owner: visuals.get(nodes[1]),
            shape: { id: "face", shapeType: ShapeTypes.face },
            indexes: [0],
        };
        doc.selection.setSelectedShapes([pick as any], VisualStates.faceSelected, false);
        expect(row(nodes[1].id).getAttribute("aria-selected")).toBe("true");
        expect(doc.selection.getSelectedNodes()).toEqual([]);
        expect(doc.selection.getSelectedShapes()).toEqual([pick]);
    });

    test("visibility updates both ways and toggling is undoable", () => {
        const { doc, row, nodes } = setup();
        nodes[0].visible = false;
        const visibilityIcon = () =>
            mustQuery(row(nodes[0].id), "[data-visibility] use").getAttributeNS(
                "http://www.w3.org/1999/xlink",
                "href",
            );
        expect(visibilityIcon()).toBe("#icon-eye-slash");
        mustQuery<HTMLButtonElement>(row(nodes[0].id), "[data-visibility]").click();
        expect(nodes[0].visible).toBe(true);
        expect(visibilityIcon()).toBe("#icon-eye");
        doc.history.undo();
        expect(nodes[0].visible).toBe(false);
        expect(visibilityIcon()).toBe("#icon-eye-slash");
    });

    test.each([
        ["Enter", "Shell", "Shell"],
        ["Escape", "Cancelled", "Body0"],
        ["Enter", " ", "Body0"],
    ])("inline rename with %s and %s results in %s", (key, value, expected) => {
        const { browser, row, nodes } = setup();
        row(nodes[0].id).click();
        browser.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
        const editor = mustQuery<HTMLInputElement>(row(nodes[0].id), "input");
        editor.value = value;
        editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        expect(nodes[0].name).toBe(expected);
    });

    test("expansion survives unrelated changes and disconnect/reconnect", () => {
        const { browser, doc, owner, row, nodes } = setup();
        mustQuery<HTMLButtonElement>(row(owner.id), "[data-expand]").click();
        nodes[0].name = "Changed";
        expect(row(owner.id).getAttribute("aria-expanded")).toBe("false");
        browser.remove();
        nodes[1].name = "While detached";
        window.document.body.append(browser);
        expect(row(owner.id).getAttribute("aria-expanded")).toBe("false");
        doc.selection.setSelectedNodes([nodes[1]], false);
        expect(row(nodes[1].id).textContent).toContain("While detached");
    });

    test("saved views restore cameras and retain the current projection mode", () => {
        const { browser, doc, app, row } = setup();
        const camera = {
            cameraPosition: new XYZ(5, 5, 5),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitZ,
            cameraType: "orthographic",
            lookAt: rs.fn(),
        };
        app.activeView = createMockView({ document: doc, cameraController: camera as any });
        const view = new Act({
            name: "Saved",
            cameraPosition: XYZ.unitX,
            cameraTarget: XYZ.unitY,
            cameraUp: XYZ.unitZ,
        });
        doc.acts.push(view);
        const entry = [...browser.model.entries.values()].find((item) => item.view === view)!;
        browser.reveal(entry.key);
        row(entry.key).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(camera.lookAt).toHaveBeenCalledWith(XYZ.unitX, XYZ.unitY, XYZ.unitZ);
        expect(camera.cameraType).toBe("orthographic");
    });

    test("origins can be shown and selected without modifying saved data", () => {
        const { browser, doc, owner, row } = setup();
        const key = `${owner.id}:origin:4`;
        browser.reveal(key);
        const before = doc.modelManager.serialize();
        row(key).click();
        const entry = browser.model.entries.get(key)!;
        expect(entry.node?.visible).toBe(true);
        expect(doc.selection.getSelectedNodes()).toEqual([entry.node]);
        expect(doc.modelManager.serialize()).toEqual(before);
        row(key).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        const menu = mustQuery(window.document.body, "[role=menu]");
        expect(menu.textContent).not.toContain("Delete");
        expect(menu.textContent).not.toContain("Rename");
    });

    test("provider edit actions and command selection filters are respected", () => {
        const { browser, doc, row, nodes } = setup();
        const edit = rs.fn((_node: INode) => {});
        const unregister = BrowserProviders.register({
            describe: (node) =>
                node === nodes[0]
                    ? {
                          type: "sketch",
                          category: "sketches",
                          icon: "icon-shape",
                          editLabel: "browser.editSketch",
                          edit,
                      }
                    : undefined,
        });
        try {
            browser.reveal(nodes[0].id);
            row(nodes[0].id).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            expect(edit).toHaveBeenCalledWith(nodes[0]);
            doc.visual.eventHandler = new NodeSelectionHandler(doc, true, undefined, {
                allow: (node) => node === nodes[1],
            });
            row(nodes[0].id).click();
            expect(doc.selection.getSelectedNodes()).toEqual([]);
            browser.reveal(nodes[1].id);
            row(nodes[1].id).click();
            expect(doc.selection.getSelectedNodes()).toEqual([nodes[1]]);
        } finally {
            doc.visual.eventHandler.dispose();
            unregister();
        }
    });

    test("5,000 objects render bounded rows and reveal offscreen viewport selections", () => {
        const { browser, doc, row, nodes } = setup(5000);
        expect(browser.model.entries.size).toBeGreaterThan(5000);
        expect(browser.querySelectorAll("[role=treeitem]").length).toBeLessThanOrEqual(36);
        doc.selection.setSelectedNodes([nodes[4999]], false);
        expect(row(nodes[4999].id).getAttribute("aria-selected")).toBe("true");
        expect(browser.scrollTop).toBeGreaterThan(100000);
        expect(browser.querySelectorAll("[role=treeitem]").length).toBeLessThanOrEqual(36);
    });
});
