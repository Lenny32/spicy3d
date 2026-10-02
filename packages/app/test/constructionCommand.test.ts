// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ConstructionNode, type ICommand, type IView, PubSub, SelectNodeStep, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockSelection, TestDocument } from "@spicy3d/core/test-utils";
import { EditConstructionCommand, OffsetPlaneCommand, UcsCommand } from "../src/commands/construction";

const mountContent = (_command: ICommand, content?: HTMLElement) => {
    if (content) document.body.append(content);
};

beforeEach(() => {
    PubSub.default.sub("openCommandContext", mountContent);
});

afterEach(() => {
    PubSub.default.remove("openCommandContext", mountContent);
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
        (element) => element.firstChild?.textContent === label,
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
    test("opens one command context containing its form and marks the point source optional", async () => {
        const { app } = setup();
        const opened = rs.fn((_command: ICommand, _content?: HTMLElement) => {});
        PubSub.default.sub("openCommandContext", opened);
        try {
            const command = new OffsetPlaneCommand();
            const completion = command.execute(app);
            expect(opened.mock.calls).toEqual([[command, panel()]]);
            expect(document.querySelectorAll(".spicy-construction-editor").length).toBe(1);
            const label = [...panel().querySelectorAll("label")].find(
                (element) => element.firstChild?.textContent === "To Object point",
            );
            expect(label).not.toBeUndefined();
            expect(label!.textContent).toBe("To Object point (optional)");
            button("Cancel").click();
            await completion;
            expect(document.querySelector(".spicy-construction-editor")).toBeNull();
        } finally {
            PubSub.default.remove("openCommandContext", opened);
        }
    });

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
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
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
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
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

    test("a distance expression is kept as typed, shows its value and follows the variables", async () => {
        const { app, doc, display } = setup();
        doc.variables.setItems([{ id: "v1", name: "sec_x_1", expression: "12", type: "length" }]);
        const completion = new OffsetPlaneCommand().execute(app);
        await chooseSource("Plane", "XY");
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
        expect(input).not.toBeNull();
        expect(input!.type).toBe("text");
        input!.value = "sec_x_1 * 2";
        input!.dispatchEvent(new Event("input"));
        expect(panel().querySelector("[data-evaluated=distance]")?.textContent).toBe("= 24 mm");
        const meshes = display.mock.calls.at(-1)![0];
        expect(meshes[0].position[2]).toBeCloseTo(24);
        button("Create").click();
        await completion;
        const node = doc.modelManager.findNode((n) => n instanceof ConstructionNode) as ConstructionNode;
        expect(node.definition).toMatchObject({ distance: "sec_x_1 * 2" });

        doc.variables.setItems([{ id: "v1", name: "sec_x_1", expression: "5", type: "length" }]);

        const geometry = node.geometry.unchecked()!;
        expect(geometry.kind === "plane" && geometry.plane.origin.z).toBeCloseTo(10);
    });

    test("a unit typed into a length field is converted to millimetres", async () => {
        const { app, doc } = setup();
        const completion = new OffsetPlaneCommand().execute(app);
        await chooseSource("Plane", "XY");
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
        expect(input).not.toBeNull();
        input!.value = "2 cm";
        input!.dispatchEvent(new Event("input"));
        button("Create").click();
        await completion;
        const node = doc.modelManager.findNode((n) => n instanceof ConstructionNode) as ConstructionNode;
        expect(node.definition).toMatchObject({ distance: 20 });
    });

    test("an expression that is not a length is reported and not taken", async () => {
        const { app, doc } = setup();
        doc.variables.setItems([{ id: "v1", name: "tilt", expression: "30", type: "angle" }]);
        const completion = new OffsetPlaneCommand().execute(app);
        await chooseSource("Plane", "XY");
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
        expect(input).not.toBeNull();
        input!.value = "7";
        input!.dispatchEvent(new Event("input"));
        input!.value = "tilt + 1";
        input!.dispatchEvent(new Event("input"));
        const status = panel().querySelector("[role=status]")?.textContent ?? "";
        // The test locale is the identity: the key with its argument filled in.
        expect(status).toMatch(/^construction\.error\.lengthDimension mismatch/);
        expect(panel().querySelector("[data-evaluated=distance]")?.textContent).toBe("");
        button("Create").click();
        await completion;
        const node = doc.modelManager.findNode((n) => n instanceof ConstructionNode) as ConstructionNode;
        expect(node.definition).toMatchObject({ distance: 7 });
    });

    test("editing shows a stored expression and its value; the angle field takes angle variables", async () => {
        const { app, doc } = setup();
        doc.variables.setItems([
            { id: "v1", name: "sec_x_1", expression: "12", type: "length" },
            { id: "v2", name: "tilt", expression: "30", type: "angle" },
        ]);
        const node = new ConstructionNode({
            document: doc,
            definition: {
                kind: "plane-angle",
                axis: { kind: "fixed", geometry: { kind: "axis", origin: XYZ.zero, direction: XYZ.unitX } },
                baseline: { kind: "origin-plane", plane: "XY" },
                angle: 10,
                offset: "sec_x_1 / 2",
            },
        });
        doc.modelManager.addNode(node);
        doc.selection.getSelectedNodes = () => [node];
        const completion = new EditConstructionCommand().execute(app);
        const offset = panel().querySelector<HTMLInputElement>("input[data-parameter=offset]");
        const angle = panel().querySelector<HTMLInputElement>("input[data-parameter=angle]");
        expect(offset).not.toBeNull();
        expect(angle).not.toBeNull();
        expect(offset!.value).toBe("sec_x_1 / 2");
        expect(panel().querySelector("[data-evaluated=offset]")?.textContent).toBe("= 6 mm");
        angle!.value = "sec_x_1";
        angle!.dispatchEvent(new Event("input"));
        expect(panel().querySelector("[role=status]")?.textContent).toMatch(
            /^construction\.error\.angleDimension mismatch/,
        );
        angle!.value = "tilt * 2";
        angle!.dispatchEvent(new Event("input"));
        expect(panel().querySelector("[data-evaluated=angle]")?.textContent).toBe("= 60 °");
        button("Apply").click();
        await completion;
        expect(node.definition).toMatchObject({ angle: "tilt * 2", offset: "sec_x_1 / 2" });
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
            (element) => element.firstChild?.textContent === "To Object point",
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

    test("a length field reads and shows the project unit", async () => {
        const { app, doc } = setup();
        doc.settings.lengthUnit = "cm";
        doc.variables.setItems([{ id: "v1", name: "w", expression: "12", type: "length" }]);
        const completion = new OffsetPlaneCommand().execute(app);
        await chooseSource("Plane", "XY");
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=distance]");
        expect(input).not.toBeNull();
        expect(input!.parentElement!.firstChild!.textContent).toBe("Distance (cm)");
        input!.value = "w * 2";
        input!.dispatchEvent(new Event("input"));
        expect(panel().querySelector("[data-evaluated=distance]")?.textContent).toBe("= 2.4 cm");
        input!.value = "10";
        input!.dispatchEvent(new Event("input"));
        button("Create").click();
        await completion;
        const node = doc.modelManager.findNode((n) => n instanceof ConstructionNode) as ConstructionNode;
        expect(node.definition).toMatchObject({ distance: 100 });
    });

    test("switching a path position to normalized resets it, and a ratio refuses an expression", async () => {
        const { app, doc } = setup();
        doc.variables.setItems([{ id: "v1", name: "len", expression: "8", type: "length" }]);
        const path = {
            kind: "fixed" as const,
            geometry: { kind: "axis" as const, origin: XYZ.zero, direction: XYZ.unitX },
        };
        const node = new ConstructionNode({
            document: doc,
            definition: { kind: "point-along-path", path, position: { kind: "distance", value: "len / 2" } },
        });
        doc.modelManager.addNode(node);
        doc.selection.getSelectedNodes = () => [node];
        const completion = new EditConstructionCommand().execute(app);
        const input = panel().querySelector<HTMLInputElement>("input[data-parameter=value]");
        expect(input).not.toBeNull();
        expect(input!.value).toBe("len / 2");
        const mode = [...panel().querySelectorAll("select")].find((select) =>
            [...select.options].some((item) => item.value === "normalized"),
        );
        expect(mode).not.toBeUndefined();
        mode!.value = "normalized";
        mode!.dispatchEvent(new Event("change"));
        expect(input!.value).toBe("0");
        // The ratio reaches core as a number: the fixed axis is refused for being unbounded, not
        // for a NaN ratio left over from the distance expression.
        const status = () => panel().querySelector("[role=status]")?.textContent ?? "";
        expect(status()).toMatch(/unbounded axis needs a distance/);
        input!.value = "len";
        input!.dispatchEvent(new Event("input"));
        expect(status()).toMatch(/^construction\.error\.ratio/);
        input!.value = "0.25";
        input!.dispatchEvent(new Event("input"));
        expect(status()).toMatch(/unbounded axis needs a distance/);
        mode!.value = "distance";
        mode!.dispatchEvent(new Event("change"));
        expect(input!.value).toBe("0");
        input!.value = "len / 4";
        input!.dispatchEvent(new Event("input"));
        button("Apply").click();
        await completion;
        expect(node.definition).toMatchObject({ position: { kind: "distance", value: "len / 4" } });
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
