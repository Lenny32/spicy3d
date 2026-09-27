// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
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

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

const TOP_PLANE = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 20 }), normal: XYZ.unitZ, xvec: XYZ.unitX });

function setup() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function addSketch(doc: TestDocument, id: string, plane: Plane, data: SketchData) {
    const sketch = new SketchNode({ document: doc, id, plane, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

function profileOf(sketch: SketchNode): IFace {
    const profiles = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(profiles).toHaveLength(1);
    return profiles[0].shape as unknown as IFace;
}

/** A 40×40×20 block with a 10×10×10 boss joined on its top face. */
function blockWithBoss(doc: TestDocument, bossSuppressed = false): ParametricBodyNode {
    const base = addSketch(doc, "sk1", Plane.XY, rect(-20, -20, 20, 20));
    const boss = addSketch(doc, "sk2", TOP_PLANE, rect(-5, -5, 5, 5));
    const body = new ParametricBodyNode({
        document: doc,
        id: "b1",
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: base.id,
                depth: 20,
                profiles: [captureProfileRef(profileOf(base))],
            },
            {
                id: "e2",
                type: "extrude",
                sketchId: boss.id,
                depth: 10,
                operation: "fuse",
                suppressed: bossSuppressed,
                profiles: [captureProfileRef(profileOf(boss))],
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

function faceCount(body: ParametricBodyNode): number {
    const shape = body.shape;
    expect(shape.isOk).toBe(true);
    return shape.value.findSubShapes(ShapeTypes.face).length;
}

describe("ParametricBodyNode.featureFaces", () => {
    test("each feature owns the faces it created in the final shape", () => {
        const body = blockWithBoss(setup());

        const block = body.featureFaces("e1");
        const boss = body.featureFaces("e2");

        // The block keeps its six faces (the top one now around the boss), the boss adds five.
        expect(block).toHaveLength(6);
        expect(boss).toHaveLength(5);
        expect(block.filter((x) => boss.includes(x))).toEqual([]);
        expect(new Set([...block, ...boss]).size).toBe(faceCount(body));
    });

    test("a suppressed or unknown feature owns no face", () => {
        const body = blockWithBoss(setup(), true);

        expect(body.featureFaces("e2")).toEqual([]);
        expect(body.featureFaces("missing")).toEqual([]);
        expect(body.featureFaces("e1")).toHaveLength(faceCount(body));
    });

    test("nothing is traced while a session rolls the chain back", () => {
        const body = blockWithBoss(setup());

        expect(body.setRollbackIndex(1)).toBe(true);

        expect(body.featureFaces("e1")).toEqual([]);
    });
});
