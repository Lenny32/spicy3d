// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureEmbossFaceRef } from "../../src/features/emboss";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { collectEdges } from "../../src/features/profileGeometry";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type SketchData, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import type { SketchTextData } from "../../src/sketch/sketchText";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function newDocument(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

const text = (value: string, extra: Partial<SketchTextData> = {}): SketchTextData => ({
    id: 500,
    value,
    x: 5,
    y: 5,
    height: 10,
    ...extra,
});

function textSketch(doc: TestDocument, data: SketchData, plane = Plane.XY): SketchNode {
    const sketch = new SketchNode({ document: doc, plane, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

const wireCount = (face: IFace) => face.findSubShapes(ShapeTypes.wire).length;

describe("sketch text profiles", () => {
    test("every glyph is an outer profile and its counters are holes", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("Ao")] });
        const profiles = sketchProfiles(sketch);
        expect(profiles.isOk).toBe(true);
        expect(profiles.unchecked()!.outer).toHaveLength(2);
        expect(profiles.unchecked()!.outer.map(wireCount)).toEqual([2, 2]);
    });

    test("a glyph made of separate contours gives one profile per contour", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("i")] });
        expect(sketchProfiles(sketch).unchecked()!.outer).toHaveLength(2);
    });

    test("the height is the cap height", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("H")] });
        const box = sketch.shape.unchecked()!.boundingBox();
        expect(box.min.y).toBeCloseTo(5, 1);
        expect(box.max.y).toBeCloseTo(15, 1);
    });

    test("the angle rotates the text around its start point", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, {
            entities: [],
            constraints: [],
            texts: [text("H", { x: 0, y: 0, angle: 90 })],
        });
        const box = sketch.shape.unchecked()!.boundingBox();
        // Rotated a quarter turn counter-clockwise: the cap height now runs along -x.
        expect(box.min.x).toBeCloseTo(-10, 1);
        expect(box.max.x).toBeLessThan(0.1);
    });

    test("text edges and entity edges map back to their ids", () => {
        const doc = newDocument();
        const data: SketchData = {
            entities: [{ id: 1, type: "circle", params: [-20, 0, 3] }],
            constraints: [],
            texts: [text("ab")],
        };
        const sketch = textSketch(doc, data);
        const ids = shapeEntityIds(data);
        expect(ids).toHaveLength(collectEdges(sketch.shape.unchecked()!).length);
        expect(ids[0]).toBe(1);
        expect(new Set(ids.slice(1))).toEqual(new Set([500]));
    });

    test("characters the font lacks are skipped as spaces", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("A中A")] });
        expect(sketchProfiles(sketch).unchecked()!.outer).toHaveLength(2);
    });
});

describe("text through the solver", () => {
    test("texts survive a load/toData round trip untouched", () => {
        const texts = [text("Hi", { angle: 30 })];
        const solver = new SketchSolver(Plane.XY, { entities: [], constraints: [], texts });
        expect(solver.toData().texts).toEqual(texts);
    });

    test("new texts take ids no entity holds, and can be edited and removed", () => {
        const solver = new SketchSolver(Plane.XY, {
            entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
            constraints: [],
        });
        const id = solver.addText({ value: "A", x: 0, y: 0, height: 5 });
        const line = solver.addLine(0, 1, 10, 1);
        expect(new Set([1, id, line]).size).toBe(3);
        expect(solver.updateText(id, { value: "B" })).toBe(true);
        expect(solver.textsData()).toEqual([{ id, value: "B", x: 0, y: 0, height: 5 }]);
        expect(solver.removeText(id)).toBe(true);
        expect(solver.toData().texts).toBeUndefined();
    });
});

describe("text in features", () => {
    test("a text extrudes into letters", () => {
        const doc = newDocument();
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("O")] });
        const outer = sketchProfiles(sketch).unchecked()!.outer;
        const area = outer.reduce((sum, face) => sum + face.area(), 0);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "e", type: "extrude", sketchId: sketch.id, depth: 2 }],
        });
        doc.modelManager.addNode(body);
        expect(body.featureItems().map((x) => x.error)).toEqual([undefined]);
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(area * 2, 3);
    });

    test("a text embosses onto a body face", () => {
        const doc = newDocument();
        const base = textSketch(doc, {
            entities: [
                { id: 1, type: "line", params: [0, 0, 60, 0] },
                { id: 2, type: "line", params: [60, 0, 60, 20] },
                { id: 3, type: "line", params: [60, 20, 0, 20] },
                { id: 4, type: "line", params: [0, 20, 0, 0] },
            ],
            constraints: [],
        });
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "base", type: "extrude", sketchId: base.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        const plane = new Plane({
            origin: new XYZ({ x: 0, y: 0, z: 15 }),
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
        });
        const sketch = textSketch(doc, { entities: [], constraints: [], texts: [text("Spicy")] }, plane);
        const area = sketchProfiles(sketch)
            .unchecked()!
            .outer.reduce((sum, face) => sum + face.area(), 0);
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const topIndex = faces.findIndex((face) => Math.abs(face.boundingBox().min.z - 10) < 1e-6);
        const id = body.faceIdAt(topIndex);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "emboss",
                type: "emboss",
                sketchId: sketch.id,
                faces: [captureEmbossFaceRef(faces[topIndex], id, body.faceIdIsShared(id))],
                depth: 1,
            },
        ]);
        expect(body.featureItems().map((x) => x.error)).toEqual([undefined, undefined]);
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(60 * 20 * 10 + area, 2);
    });
});
