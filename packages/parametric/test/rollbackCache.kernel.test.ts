// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import { type ICameraController, type IFace, Plane, ShapeTypes, Transaction, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchEditor } from "../src/sketch/editor/sketchEditor";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

const rectangle = (size: number, x = 0): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x, 0, x + size, 0] },
        { id: 2, type: "line", params: [x + size, 0, x + size, size] },
        { id: 3, type: "line", params: [x + size, size, x, size] },
        { id: 4, type: "line", params: [x, size, x, 0] },
    ],
    constraints: [],
});

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

function sketch(size: number, x = 0): SketchNode {
    const node = new SketchNode({ document: doc, plane: Plane.XY, data: rectangle(size, x) });
    doc.modelManager.addNode(node);
    return node;
}

test("unchanged first/middle/final sketch rollback performs zero booleans; edits and undo rebuild the suffix", () => {
    const base = sketch(20);
    const pocket = sketch(5);
    const raised = sketch(10, 10);
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            { id: "base", type: "extrude", sketchId: base.id, depth: 10 },
            { id: "pocket", type: "extrude", sketchId: pocket.id, depth: 5, operation: "cut" },
            { id: "raised", type: "extrude", sketchId: raised.id, depth: 12, operation: "fuse" },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    const full = body.shape.value;
    const volume = full.volume();
    const fuse = rs.spyOn(factory, "booleanFuseTracked");
    const cut = rs.spyOn(factory, "booleanCutTracked");
    const prism = rs.spyOn(factory, "prismTracked");
    for (const index of [0, 1, 2, 0, 2]) {
        expect(body.setRollbackIndex(index)).toBe(true);
        expect(body.setRollbackIndex(undefined)).toBe(true);
        expect(body.shape.value).toBe(full);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 6);
    }
    const position = doc.history.position();
    for (const node of [base, pocket, raised]) {
        const editor = SketchEditor.enter(node);
        editor.commit();
        editor.exit();
        expect(body.shape.value).toBe(full);
    }
    expect(doc.history.position()).toBe(position);
    expect(fuse).not.toHaveBeenCalled();
    expect(cut).not.toHaveBeenCalled();
    expect(prism).not.toHaveBeenCalled();
    body.setRollbackIndex(1);
    const prefix = body.shape.value;
    Transaction.execute(doc, "edit pocket", () => pocket.setDataEmitShapeChanged(rectangle(6)));
    body.setRollbackIndex(undefined);
    expect(body.timelineStateAt(1)?.shape).toBe(prefix);
    expect(cut).toHaveBeenCalledTimes(1);
    expect(fuse).toHaveBeenCalledTimes(1);
    expect(body.shape.value.volume()).not.toBeCloseTo(volume, 6);
    doc.history.undo();
    expect(body.shape.value.volume()).toBeCloseTo(volume, 6);
    expect(body.timelineStateAt(1)?.shape).toBe(prefix);
    expect(cut.mock.calls.length).toBeGreaterThan(1);
    expect(fuse.mock.calls.length).toBeGreaterThan(1);
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
});

test("a consumed press-pull validates against the retained pre-boolean input across rollback", () => {
    const base = sketch(20);
    const host = new ParametricBodyNode({
        document: doc,
        features: [{ id: "base", type: "extrude", sketchId: base.id, depth: 10 }],
    });
    doc.modelManager.addNode(host);
    expect(host.shape.isOk).toBe(true);
    const faces = host.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => face.normal(0, 0)[1].x > 0.99);
    expect(index).toBeGreaterThanOrEqual(0);
    const tool = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "press",
                type: "extrude",
                depth: 5,
                source: {
                    nodeId: host.id,
                    profiles: [captureProfileRef(faces[index], host.faceIdAt(index), false, true)],
                },
            },
        ],
    });
    doc.modelManager.addNode(tool);
    host.setFeaturesEmitShapeChanged([
        ...host.features,
        { id: "fuse", type: "boolean", operation: "fuse", toolIds: [tool.id] },
    ]);
    expect(tool.parent).toBe(host);
    expect(host.shape.value.volume()).toBeCloseTo(5000, 6);
    const full = host.shape.value;
    const pressed = tool.shape.value;
    const fuse = rs.spyOn(factory, "booleanFuseTracked");
    const prism = rs.spyOn(factory, "prismTracked");
    for (let cycle = 0; cycle < 3; cycle++) {
        host.setRollbackIndex(0);
        tool.setRollbackIndex(0);
        // The consumer refreshes the tool at its pre-boolean timeline position.
        tool.setRollbackIndex(undefined);
        host.setRollbackIndex(undefined);
    }
    expect(host.shape.value).toBe(full);
    expect(tool.shape.value).toBe(pressed);
    expect(fuse).not.toHaveBeenCalled();
    expect(prism).not.toHaveBeenCalled();
    expect(host.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(tool.featureItems().map((item) => item.error)).toEqual([undefined]);
});
