// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ConstructionNode, type IView, SelectNodeStep, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockSelection, TestDocument } from "@spicy3d/core/test-utils";
import { EditConstructionCommand, OffsetPlaneCommand, UcsCommand } from "../src/commands/construction";

afterEach(() => {
    document.querySelectorAll(".spicy-construction-editor").forEach((element) => element.remove());
    rs.restoreAllMocks();
});

function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: createMockSelection() });
    app.activeView = { document: doc } as unknown as IView;
    const display = rs.spyOn(doc.visual.context, "displayMesh");
    const remove = rs.spyOn(doc.visual.context, "removeMesh");
    return { app, doc, display, remove };
}

function panel(): HTMLElement {
    const root = document.querySelector<HTMLElement>(".spicy-construction-editor");
    expect(root).not.toBeNull();
    return root!;
}

function button(text: string): HTMLButtonElement {
    const result = [...panel().querySelectorAll("button")].find((element) => element.textContent === text);
    expect(result).not.toBeUndefined();
    return result!;
}

async function chooseSource(label: string, mode: string) {
    const sourceLabel = [...panel().querySelectorAll("label")].find(
        (element) => element.textContent === label,
    );
    expect(sourceLabel).not.toBeUndefined();
    const row = sourceLabel!.parentElement!;
    const select = row.querySelector("select");
    const pick = row.querySelector("button");
    expect(select).not.toBeNull();
    expect(pick).not.toBeNull();
    select!.value = mode;
    pick!.click();
    await Promise.resolve();
    await Promise.resolve();
}

describe("construction command forms", () => {
    test("cancelling during an active pick signals its controller and leaves no model mutation", async () => {
        const { app, doc } = setup();
        const cancelObserved = rs.fn();
        const pick = rs.spyOn(SelectNodeStep.prototype, "execute").mockImplementation(
            (_document, controller) =>
                new Promise((resolve) => {
                    controller.onCancelled(() => {
                        cancelObserved();
                        resolve(undefined);
                    });
                }),
        );
        const beforeHistory = doc.history.undoCount();
        const command = new OffsetPlaneCommand();
        const completion = command.execute(app);
        await chooseSource("Plane", "datum");
        expect(pick).toHaveBeenCalledTimes(1);
        button("Cancel").click();
        await completion;
        expect(cancelObserved).toHaveBeenCalledTimes(1);
        expect(doc.history.undoCount()).toBe(beforeHistory);
        expect(doc.modelManager.findNode((node) => node instanceof ConstructionNode)).toBeUndefined();
        expect(document.querySelector(".spicy-construction-editor")).toBeNull();
    });

    test("default zero offset previews and commits a referenced document object", async () => {
        const { app, doc, display, remove } = setup();
        const command = new OffsetPlaneCommand();
        const completion = command.execute(app);
        await chooseSource("Plane", "XY");
        expect(panel().querySelector("[role=status]")?.textContent).toBe("Preview ready");
        expect(display).toHaveBeenCalledTimes(1);
        expect(doc.modelManager.findNode((node) => node instanceof ConstructionNode)).toBeUndefined();
        button("Create").click();
        await completion;
        const node = doc.modelManager.findNode(
            (item) => item instanceof ConstructionNode,
        ) as ConstructionNode;
        expect(node).toBeInstanceOf(ConstructionNode);
        expect(node.definition).toEqual({
            kind: "plane-offset",
            source: { kind: "origin-plane", plane: "XY" },
            distance: 0,
        });
        expect(node.geometry.isOk).toBe(true);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".spicy-construction-editor")).toBeNull();
    });

    test("numeric changes update the preview and cancellation leaves model and history untouched", async () => {
        const { app, doc, display, remove } = setup();
        const beforeHistory = doc.history.undoCount();
        const command = new OffsetPlaneCommand();
        const completion = command.execute(app);
        await chooseSource("Plane", "XY");
        const input = panel().querySelector<HTMLInputElement>("input[type=number]");
        expect(input).not.toBeNull();
        input!.value = "12";
        input!.dispatchEvent(new Event("input"));
        expect(display).toHaveBeenCalledTimes(2);
        const meshes = display.mock.calls[1][0];
        expect(meshes.length).toBe(4);
        expect(meshes[0].position[2]).toBeCloseTo(12);
        button("Cancel").click();
        await completion;
        expect(remove).toHaveBeenCalledTimes(2);
        expect(doc.history.undoCount()).toBe(beforeHistory);
        expect(doc.modelManager.findNode((node) => node instanceof ConstructionNode)).toBeUndefined();
    });

    test("editing changes the definition in one undoable transaction and retains its source identity", async () => {
        const { app, doc } = setup();
        const node = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 3 },
        });
        doc.modelManager.addNode(node);
        doc.selection.getSelectedNodes = () => [node];
        const beforeHistory = doc.history.undoCount();
        const command = new EditConstructionCommand();
        const completion = command.execute(app);
        const input = panel().querySelector<HTMLInputElement>("input[type=number]");
        expect(input).not.toBeNull();
        expect(input!.value).toBe("3");
        input!.value = "15";
        input!.dispatchEvent(new Event("input"));
        expect(node.definition).toMatchObject({ distance: 3 });
        button("Apply").click();
        await completion;
        expect(node.definition).toEqual({
            kind: "plane-offset",
            source: { kind: "origin-plane", plane: "XY" },
            distance: 15,
        });
        expect(doc.history.undoCount()).toBe(beforeHistory + 1);
        doc.history.undo();
        expect(node.definition).toMatchObject({ distance: 3 });
        doc.history.redo();
        expect(node.definition).toMatchObject({ distance: 15 });
    });

    test.each([
        "point-along-path",
        "plane-along-path",
    ] as const)("editing a saved To Object %s definition previews and applies without re-picking", async (kind) => {
        const { app, doc, display } = setup();
        const toPoint = {
            kind: "fixed" as const,
            geometry: { kind: "point" as const, point: new XYZ({ x: 7, y: 2, z: 0 }) },
        };
        const path = {
            kind: "fixed" as const,
            geometry: { kind: "axis" as const, origin: XYZ.zero, direction: XYZ.unitX },
        };
        const definition =
            kind === "point-along-path"
                ? { kind, path, position: { kind: "to-point" as const, point: toPoint } }
                : { kind, path, position: { kind: "to-point" as const, point: toPoint }, offset: 0 };
        const node = new ConstructionNode({ document: doc, definition });
        doc.modelManager.addNode(node);
        doc.selection.getSelectedNodes = () => [node];
        const completion = new EditConstructionCommand().execute(app);
        expect(panel().querySelector("[role=status]")?.textContent).toBe("Preview ready");
        expect(display).toHaveBeenCalledTimes(1);
        const toPointRow = [...panel().querySelectorAll("label")].find(
            (element) => element.textContent === "To Object point",
        );
        expect(toPointRow).not.toBeUndefined();
        expect(toPointRow!.parentElement!.querySelector("small")?.textContent).toBe("Fixed point");
        button("Apply").click();
        await completion;
        expect(document.querySelector(".spicy-construction-editor")).toBeNull();
        expect(node.definition).toMatchObject({ kind, position: { kind: "to-point", point: toPoint } });
        expect(node.definition).not.toHaveProperty("toPoint");
        const geometry = node.geometry.unchecked()!;
        const origin =
            geometry.kind === "point"
                ? geometry.point
                : (geometry as { plane: { origin: XYZ } }).plane.origin;
        expect(origin.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }))).toBe(true);
    });

    test("picking a construction source retains its ID", async () => {
        const { app, doc } = setup();
        const source = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 5 },
        });
        doc.modelManager.addNode(source);
        const pick = rs
            .spyOn(SelectNodeStep.prototype, "execute")
            .mockResolvedValue({ type: "node", nodes: [source], shapes: [], view: app.activeView! });
        const completion = new OffsetPlaneCommand().execute(app);
        await chooseSource("Plane", "datum");
        expect(pick).toHaveBeenCalledTimes(1);
        button("Create").click();
        await completion;
        const created = doc.modelManager.findNode(
            (node) => node instanceof ConstructionNode && node !== source,
        ) as ConstructionNode;
        expect(created).toBeInstanceOf(ConstructionNode);
        expect(created.definition).toMatchObject({ source: { kind: "datum", nodeId: source.id } });
    });

    test("default UCS reversal controls preserve positive X and Y", async () => {
        const { app, doc } = setup();
        const nodes = [
            new ConstructionNode({
                document: doc,
                definition: {
                    kind: "point-vertex",
                    vertex: { kind: "fixed", geometry: { kind: "point", point: XYZ.zero } },
                },
            }),
            new ConstructionNode({
                document: doc,
                definition: {
                    kind: "axis-two-points",
                    first: { kind: "fixed", geometry: { kind: "point", point: XYZ.zero } },
                    second: { kind: "fixed", geometry: { kind: "point", point: XYZ.unitX } },
                },
            }),
            new ConstructionNode({
                document: doc,
                definition: {
                    kind: "axis-two-points",
                    first: { kind: "fixed", geometry: { kind: "point", point: XYZ.zero } },
                    second: { kind: "fixed", geometry: { kind: "point", point: XYZ.unitY } },
                },
            }),
        ];
        nodes.forEach((node) => doc.modelManager.addNode(node));
        const queue: ConstructionNode[] = [...nodes];
        rs.spyOn(SelectNodeStep.prototype, "execute").mockImplementation(async () => ({
            type: "node",
            nodes: [queue.shift()!],
            shapes: [],
            view: app.activeView!,
        }));
        const completion = new UcsCommand().execute(app);
        await chooseSource("Origin point", "datum");
        await chooseSource("First direction", "datum");
        await chooseSource("Second direction", "datum");
        button("Create").click();
        await completion;
        const created = doc.modelManager.findNode(
            (node) => node instanceof ConstructionNode && node.definition.kind === "ucs",
        ) as ConstructionNode;
        expect(created).toBeInstanceOf(ConstructionNode);
        const geometry = created.geometry.unchecked()!;
        expect(geometry.kind).toBe("ucs");
        if (geometry.kind !== "ucs") throw new Error("Expected UCS");
        expect(geometry.x.isEqualTo(XYZ.unitX)).toBe(true);
        expect(geometry.y.isEqualTo(XYZ.unitY)).toBe(true);
    });
});
