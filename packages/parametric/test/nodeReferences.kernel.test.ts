// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findNodeDependents, type IFace, Plane, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const square: SketchData = {
    entities: [
        { id: 1, type: "line", params: [0, 0, 10, 0] },
        { id: 2, type: "line", params: [10, 0, 10, 10] },
        { id: 3, type: "line", params: [10, 10, 0, 10] },
        { id: 4, type: "line", params: [0, 10, 0, 0] },
    ],
    constraints: [],
};

// What the delete command warns about: a body extruding a sketch, a sketch drawn on a body's face.
test("a body depends on the sketch it extrudes, a face sketch on its body", () => {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square });
    doc.modelManager.addNode(sketch);
    const face = sketch.mesh.faces!.range.find((x) => x.shape.shapeType === ShapeTypes.face)!.shape;
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketch.id,
                depth: 5,
                profiles: [captureProfileRef(face as unknown as IFace)],
            },
        ],
    });
    doc.modelManager.addNode(body);
    const onFace = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: { entities: [], constraints: [] },
        planeRef: { nodeId: body.id, normal: { x: 0, y: 0, z: 1 }, offset: 5 },
    });
    doc.modelManager.addNode(onFace);

    expect(body.referencedNodeIds()).toContain(sketch.id);
    expect(onFace.referencedNodeIds()).toEqual([body.id]);
    const root = doc.modelManager.rootNode;
    expect(findNodeDependents(root, [sketch])).toEqual([body]);
    expect(findNodeDependents(root, [body])).toEqual([onFace]);
    expect(findNodeDependents(root, [onFace])).toEqual([]);
});
