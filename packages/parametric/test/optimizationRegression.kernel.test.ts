// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    EditableShapeNode,
    type ICameraController,
    type INodeVisual,
    Matrix4,
    Plane,
    Result,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { sketchProfiles } from "../src/features/profileBuilder";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchEditor } from "../src/sketch/editor/sketchEditor";
import { captureExternalRef } from "../src/sketch/externalRef";
import { ConstraintKind, type SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let doc: TestDocument;
let factory: ShapeFactory;

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
});

beforeEach(() => {
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
    doc = new TestDocument({ application: createMockApplication(), selection: createMockSelection() });
    doc.visual = createMockVisualWithDocument(doc);
    doc.application.activeView = createMockView({
        document: doc,
        cameraController: {
            cameraPosition: new XYZ({ x: 0, y: -100, z: 100 }),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitZ,
            cameraType: "perspective",
            lookAt: rs.fn(),
            fitContent: rs.fn(),
        } as unknown as ICameraController,
    });
});

afterEach(() => {
    SketchEditor.exit();
    doc.dispose();
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

function rectangle(size: number): SketchData {
    return {
        entities: [
            { id: 1, type: "line", params: [0, 0, size, 0] },
            { id: 2, type: "line", params: [size, 0, size, size] },
            { id: 3, type: "line", params: [size, size, 0, size] },
            { id: 4, type: "line", params: [0, size, 0, 0] },
        ],
        constraints: [],
    };
}

function sketch(data: SketchData): SketchNode {
    const node = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(node);
    return node;
}

function expectVolume(body: ParametricBodyNode, volume: number): void {
    expect(body.shape.isOk).toBe(true);
    expect(body.featureItems().map((item) => item.error)).toEqual(body.features.map(() => undefined));
    expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
}

const horizontal = { id: 10, kind: ConstraintKind.Horizontal, refs: [{ entityId: 1, pointIndex: 0 }] };

test.each([
    ["entity endpoint", 3925, 3900],
    ["constraint addition", 3925, 3925],
    ["constraint removal", 3925, 3925],
    ["extrude depth", 3925, 3850],
    ["suppression", 3925, 4000],
    ["unsuppression", 4000, 3925],
    ["reorder", 3925, 3875],
    ["plane move", 3925, 3875],
] as const)("rollback + %s + undo/redo preserves the prefix and rebuilds the correct suffix", (change, before, after) => {
    const base = sketch(rectangle(20));
    const pocketData = rectangle(5);
    if (change === "constraint removal") pocketData.constraints.push(horizontal);
    const pocket = sketch(pocketData);
    const refill = sketch(rectangle(5));
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            { id: "base", type: "extrude", sketchId: base.id, depth: 10 },
            {
                id: "cut",
                type: "extrude",
                sketchId: pocket.id,
                depth: 5,
                operation: "cut",
                suppressed: change === "unsuppression",
            },
            { id: "refill", type: "extrude", sketchId: refill.id, depth: 2, operation: "fuse" },
        ],
    });
    doc.modelManager.addNode(body);
    expectVolume(body, before);
    const prefix = body.timelineStateAt(1)!.shape;
    const baseProfiles = sketchProfiles(base).value;
    const initialJson = body.featuresJson;
    const initialData = pocket.dataJson;
    const initialPlane = pocket.plane;
    const count = doc.history.undoCount();
    const prism = rs.spyOn(factory, "prismTracked");
    expect(body.setRollbackIndex(1)).toBe(true);
    Transaction.execute(doc, change, () => {
        switch (change) {
            case "entity endpoint": {
                // Move one shared vertex, keeping the profile closed (area 25 -> 30).
                const data = pocket.data;
                data.entities[0].params[2] = 7;
                data.entities[1].params[0] = 7;
                pocket.setDataEmitShapeChanged(data);
                break;
            }
            case "constraint addition":
                pocket.setDataEmitShapeChanged({ ...pocket.data, constraints: [horizontal] });
                break;
            case "constraint removal":
                pocket.setDataEmitShapeChanged({ ...pocket.data, constraints: [] });
                break;
            case "extrude depth":
                body.setFeatureParameter("cut", "depth", 8);
                break;
            case "suppression":
            case "unsuppression":
                body.setFeatureSuppressed("cut", change === "suppression");
                break;
            case "reorder":
                body.moveFeature("refill", -1);
                break;
            case "plane move":
                pocket.plane = Plane.XY.translateTo(new XYZ({ x: 0, y: 0, z: 2 }));
                break;
        }
    });
    expect(prism).not.toHaveBeenCalled();
    expect(body.shape.value).toBe(prefix);
    expect(body.setRollbackIndex(undefined)).toBe(true);
    expectVolume(body, after);
    const geometryUnchanged = change === "constraint addition" || change === "constraint removal";
    expect(prism).toHaveBeenCalledTimes(geometryUnchanged ? 0 : change === "suppression" ? 1 : 2);
    const editedJson = body.featuresJson;
    const editedData = pocket.dataJson;
    const editedPlane = pocket.plane;
    expect(body.timelineStateAt(1)!.shape).toBe(prefix);
    expect(sketchProfiles(base).value).toBe(baseProfiles);

    doc.history.undo();
    expectVolume(body, before);
    expect(body.featuresJson).toBe(initialJson);
    expect(pocket.dataJson).toBe(initialData);
    expect(pocket.plane).toEqual(initialPlane);
    expect(body.timelineStateAt(1)!.shape).toBe(prefix);
    doc.history.redo();
    expectVolume(body, after);
    expect(body.featuresJson).toBe(editedJson);
    expect(pocket.dataJson).toBe(editedData);
    expect(pocket.plane).toEqual(editedPlane);
    expect(body.timelineStateAt(1)!.shape).toBe(prefix);
    expect(sketchProfiles(base).value).toBe(baseProfiles);
    expect(doc.history.undoCount()).toBe(count + 1);
});

test("deleting a boolean tool during rollback fails restoration, undo heals and redo reports it again", () => {
    const base = sketch(rectangle(20));
    const tool = new EditableShapeNode({
        document: doc,
        name: "cut tool",
        shape: factory.box(Plane.XY, 5, 5, 5).value,
    });
    doc.modelManager.addNode(tool);
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            { id: "base", type: "extrude", sketchId: base.id, depth: 10 },
            { id: "cut", type: "boolean", operation: "cut", toolIds: [tool.id], consumeTools: false },
        ],
    });
    doc.modelManager.addNode(body);
    expectVolume(body, 3875);
    const prefix = body.timelineStateAt(1)!.shape;
    const features = body.featuresJson;
    body.setRollbackIndex(1);
    const parent = tool.parent!;
    expect(parent).not.toBeUndefined();
    Transaction.execute(doc, "delete tool", () => parent.remove(tool));
    expect(body.setRollbackIndex(undefined)).toBe(false);
    expect(body.featureItems()[1].error).toBe("Boolean tool not found");
    expect(body.shape.value).toBe(prefix);
    doc.history.undo();
    expect(tool.parent).toBe(parent);
    expect(body.setRollbackIndex(undefined)).toBe(true);
    expectVolume(body, 3875);
    const restored = body.shape.value;
    doc.history.redo();
    expect(tool.parent).toBeUndefined();
    expect(body.featureItems()[1].error).toBe("Boolean tool not found");
    expect(body.shape.value).toBe(restored);
    expect(body.featuresJson).toBe(features);
    doc.history.undo();
    expectVolume(body, 3875);
});

test("an external profile source edit during rollback reaches the body through undo and redo", () => {
    const circle = factory.circle(Plane.XY.normal, XYZ.zero, 3).value;
    const source = new EditableShapeNode({ document: doc, name: "circle", shape: circle });
    doc.modelManager.addNode(source);
    doc.visual.context.getVisual = (node) =>
        ({ worldTransform: () => (node === source ? source.transform : Matrix4.identity()) }) as INodeVisual;
    const ref = captureExternalRef(-100, source.id, Plane.XY, circle, undefined, "profile");
    expect(ref).not.toBeUndefined();
    const profile = sketch({ entities: [], constraints: [], externalRefs: [ref!] });
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "extrude", type: "extrude", sketchId: profile.id, depth: 5 }],
    });
    doc.modelManager.addNode(body);
    expectVolume(body, 45 * Math.PI);
    const originalRef = profile.data.externalRefs![0].edge;
    body.setRollbackIndex(0);
    Transaction.execute(doc, "resize external circle", () => {
        source.shape = Result.ok(factory.circle(Plane.XY.normal, XYZ.zero, 4).value);
    });
    expect(body.setRollbackIndex(undefined)).toBe(true);
    expectVolume(body, 80 * Math.PI);
    expect(profile.data.externalRefs![0].snapshot[2]).toBeCloseTo(4, 6);
    doc.history.undo();
    expectVolume(body, 45 * Math.PI);
    expect(profile.data.externalRefs![0].snapshot[2]).toBeCloseTo(3, 6);
    expect(profile.data.externalRefs![0].edge).toEqual(originalRef);
    doc.history.redo();
    expectVolume(body, 80 * Math.PI);
    expect(profile.data.externalRefs![0].edge).toEqual({ ...originalRef, radius: 4 });
    expect(profile.warningCount).toBe(0);
});

test("a variable-expression dimension edit can be undone inside a sketch session and redone after closure", () => {
    doc.variables.setItems([{ id: "radius", name: "r", type: "length", expression: "3" }]);
    const profile = sketch({
        entities: [{ id: 1, type: "circle", params: [0, 0, 3] }],
        constraints: [
            { id: 2, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: "r" },
        ],
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "extrude", type: "extrude", sketchId: profile.id, depth: "r" }],
    });
    doc.modelManager.addNode(body);
    expectVolume(body, 27 * Math.PI);
    const editor = SketchEditor.enter(profile);
    expect(body.rollbackIndex).toBe(0);
    editor.solver.setDatumSource(2, "r * 2");
    editor.solver.solve(true);
    editor.commit();
    expect(profile.data.constraints[0].datum).toBe("r * 2");
    expect(profile.data.entities[0].params[2]).toBeCloseTo(6, 6);
    doc.history.undo();
    expect(editor.solver.toData().constraints[0].datum).toBe("r");
    expect(profile.data.entities[0].params[2]).toBeCloseTo(3, 6);
    editor.exit();
    expectVolume(body, 27 * Math.PI);
    doc.history.redo();
    expectVolume(body, 108 * Math.PI);
    Transaction.execute(doc, "change shared variable", () => {
        doc.variables.setItems([{ id: "radius", name: "r", type: "length", expression: "4" }]);
    });
    expectVolume(body, 256 * Math.PI);
    doc.history.undo();
    expectVolume(body, 108 * Math.PI);
    doc.history.redo();
    expectVolume(body, 256 * Math.PI);
});
