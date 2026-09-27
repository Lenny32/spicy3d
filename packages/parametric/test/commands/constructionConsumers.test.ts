// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AsyncController,
    ConstructionNode,
    type INode,
    type IView,
    Signal,
    setActiveConstructionPlane,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { PlanePickHandler } from "../../src/sketch/commands/planePickHandler";
import {
    CreateSketch,
    CreateSketchOnUcsYZ,
    CreateSketchOnUcsZX,
} from "../../src/sketch/commands/sketchCommands";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchNode } from "../../src/sketch/sketchNode";

function setup() {
    const app = createMockApplication();
    const selection = createMockSelection();
    const onNodeChanged = new Signal<(nodes: INode[]) => void>();
    Object.assign(selection, { onNodeChanged });
    const doc = new TestDocument({ application: app, selection });
    doc.visual = createMockVisualWithDocument(doc);
    app.activeView = { document: doc } as unknown as IView;
    return { app, doc, onNodeChanged };
}

function ucs(doc: TestDocument) {
    const node = new ConstructionNode({
        document: doc,
        definition: {
            kind: "ucs",
            origin: { kind: "fixed", geometry: { kind: "point", point: new XYZ({ x: 2, y: 3, z: 4 }) } },
            first: { kind: "fixed", geometry: { kind: "axis", origin: XYZ.zero, direction: XYZ.unitX } },
            second: { kind: "fixed", geometry: { kind: "axis", origin: XYZ.zero, direction: XYZ.unitY } },
        },
    });
    doc.modelManager.addNode(node);
    return node;
}

afterEach(() => {
    rs.restoreAllMocks();
});

test("an in-progress sketch plane picker accepts tree selection and removes the subscription", () => {
    const { doc, onNodeChanged } = setup();
    const source = new ConstructionNode({
        document: doc,
        definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 12 },
    });
    doc.modelManager.addNode(source);
    doc.selection.getSelectedNodes = () => [source];
    const controller = new AsyncController();
    const handler = new PlanePickHandler(doc, controller);
    onNodeChanged.emit([source]);
    expect(controller.result?.status).toBe("success");
    expect(handler.result).toMatchObject({ kind: "construction", ref: { kind: "datum", nodeId: source.id } });
    expect(handler.result?.kind).toBe("construction");
    if (handler.result?.kind !== "construction") throw new Error("Expected persistent plane reference");
    expect(handler.result.plane.origin.z).toBeCloseTo(12);
    handler.dispose();
    handler.result = undefined;
    onNodeChanged.emit([source]);
    expect(handler.result).toBeUndefined();
});

test.each([
    false,
    true,
])("UCS YZ remains associative when active working plane is used: %s", async (active) => {
    const { app, doc } = setup();
    const source = ucs(doc);
    doc.selection.getSelectedNodes = () => [source];
    if (active)
        setActiveConstructionPlane(app.activeView!, { kind: "datum", nodeId: source.id, member: "YZ" });
    const enter = rs.spyOn(SketchEditor, "enter").mockImplementation(() => ({}) as SketchEditor);
    const command = active ? new CreateSketch() : new CreateSketchOnUcsYZ();
    await command.execute(app);
    expect(enter).toHaveBeenCalledTimes(1);
    const sketch = enter.mock.calls[0][0] as SketchNode;
    expect(sketch.constructionPlaneRef).toEqual({ kind: "datum", nodeId: source.id, member: "YZ" });
    expect(sketch.plane.normal.isEqualTo(XYZ.unitX)).toBe(true);
    expect(sketch.plane.origin.isEqualTo(new XYZ({ x: 2, y: 3, z: 4 }))).toBe(true);
});

test.each([
    { member: "YZ" as const, Command: CreateSketchOnUcsYZ, normal: XYZ.unitX },
    { member: "ZX" as const, Command: CreateSketchOnUcsZX, normal: XYZ.unitY },
])("UCS $member command honors its member when the UCS is picked from the tree", async ({
    member,
    Command,
    normal,
}) => {
    const { app, doc, onNodeChanged } = setup();
    const source = ucs(doc);
    let selected: INode[] = [];
    doc.selection.getSelectedNodes = () => selected;
    const pickAsync = rs.fn(async (_handler: PlanePickHandler) => {
        selected = [source];
        onNodeChanged.emit([source]);
    });
    Object.assign(doc, { picker: { pickAsync } });
    const enter = rs.spyOn(SketchEditor, "enter").mockImplementation(() => ({}) as SketchEditor);
    await new Command().execute(app);
    expect(pickAsync).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(1);
    const sketch = enter.mock.calls[0][0] as SketchNode;
    expect(sketch.constructionPlaneRef).toEqual({ kind: "datum", nodeId: source.id, member });
    expect(sketch.plane.normal.isEqualTo(normal)).toBe(true);
    expect(sketch.plane.origin.isEqualTo(new XYZ({ x: 2, y: 3, z: 4 }))).toBe(true);
});
