// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Matrix4, Plane, ShapeTypes, type VisualShapeData, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { buildEmbossFeature } from "../src/commands/embossCommand";
import { captureEmbossFaceRef } from "../src/features/emboss";
import type { EmbossFeatureData, FeatureData } from "../src/features/feature";
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

function newDocument(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function addSketch(doc: TestDocument, plane: Plane, data: SketchData): SketchNode {
    const sketch = new SketchNode({ document: doc, plane, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

/** A body extruded from `data` on `plane` by `depth`. */
function addBody(doc: TestDocument, plane: Plane, data: SketchData, depth: number): ParametricBodyNode {
    const sketch = addSketch(doc, plane, data);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "base", type: "extrude", sketchId: sketch.id, depth }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

function facesOf(body: ParametricBodyNode): IFace[] {
    return body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
}

/** The emboss feature on the faces `pick` selects, captured as the command captures them. */
function emboss(
    body: ParametricBodyNode,
    sketch: SketchNode,
    pick: (face: IFace) => boolean,
    depth: number,
    deboss = false,
): EmbossFeatureData {
    const faces = facesOf(body);
    const refs = faces.flatMap((face, index) => {
        if (!pick(face)) return [];
        const id = body.faceIdAt(index);
        return [captureEmbossFaceRef(face, id, body.faceIdIsShared(id))];
    });
    expect(refs.length).toBeGreaterThan(0);
    const feature: EmbossFeatureData = {
        id: "emboss",
        type: "emboss",
        sketchId: sketch.id,
        faces: refs,
        depth,
        ...(deboss ? { deboss: true } : {}),
    };
    body.setFeaturesEmitShapeChanged([...body.features, feature] as FeatureData[]);
    return feature;
}

function errors(body: ParametricBodyNode): (string | undefined)[] {
    return body.featureItems().map((x) => x.error);
}

const volume = (body: ParametricBodyNode) => body.shape.unchecked()!.volume();

const isTop = (z: number) => (face: IFace) => {
    const box = face.boundingBox();
    return Math.abs(box.min.z - z) < 1e-6 && Math.abs(box.max.z - z) < 1e-6;
};

const above = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

describe("emboss on a planar face", () => {
    test("raises the profile region by the depth", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 2);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 + 10 * 10 * 2, 3);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(22, 6);
    });

    test("deboss recesses it instead", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 2, true);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 - 10 * 10 * 2, 3);
        expect(body.featureItems()[1].display).toBe("command.feature.deboss");
    });

    test("a face turned away from the sketch is left alone", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, (face) => isTop(20)(face) || isTop(0)(face), 2);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 + 10 * 10 * 2, 3);
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(0, 6);
    });

    test.each([
        ["with its normal out of the body", XYZ.unitZ],
        ["with its normal into the body", XYZ.unitZ.multiply(-1)],
    ])("works with the sketch drawn on the face itself, %s", (_name, normal) => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const plane = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 20 }), normal, xvec: XYZ.unitX });
        // (u, v) = (x, ±y): the square covers x, |y| ∈ [10, 20] either way.
        const sketch = addSketch(doc, plane, normal.z > 0 ? rect(10, 10, 20, 20) : rect(10, -20, 20, -10));
        emboss(body, sketch, isTop(20), 2);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 + 10 * 10 * 2, 3);
    });

    test("the depth is a feature parameter and follows edits", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 2);
        body.setFeatureParameter("emboss", "depth", 5);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 + 10 * 10 * 5, 3);
    });

    test("follows the body when an upstream feature changes", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 2);
        body.setFeatureParameter("base", "depth", 25);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 25 + 10 * 10 * 2, 3);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(27, 6);
    });

    test("a profile off the selected face is an error, not a silent no-op", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(100, 100, 110, 110));
        emboss(body, sketch, isTop(20), 2);
        expect(errors(body)[1]).toBe("Emboss profiles do not project onto the selected faces");
    });

    test("a non-positive depth is refused", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 0);
        expect(errors(body)[1]).toBe("Emboss depth must be positive");
    });
});

describe("emboss on a curved face", () => {
    /** Cylinder r=15 along z (0..40), sketch plane y=30 facing +y. */
    function cylinderWithSketch(doc: TestDocument) {
        const body = addBody(
            doc,
            Plane.XY,
            { entities: [{ id: 1, type: "circle", params: [0, 0, 15] }], constraints: [] },
            40,
        );
        const plane = new Plane({
            origin: new XYZ({ x: 0, y: 30, z: 0 }),
            normal: XYZ.unitY,
            xvec: XYZ.unitX,
        });
        // Sketch (u, v) = (x, -z) on this plane (y = normal × x... v = n × u = y × x = -z).
        const sketch = addSketch(doc, plane, rect(-5, -25, 5, -15));
        const side = (face: IFace) => !face.surface().isPlanar();
        return { body, sketch, side };
    }

    test("wraps the relief onto the near side only", () => {
        const doc = newDocument();
        const { body, sketch, side } = cylinderWithSketch(doc);
        const base = volume(body);
        emboss(body, sketch, side, 1);
        expect(errors(body)).toEqual([undefined, undefined]);
        const box = body.shape.unchecked()!.boundingBox();
        expect(box.max.y).toBeCloseTo(16, 1);
        expect(box.min.y).toBeCloseTo(-15, 1);
        // Patch area ≈ 10 wide (arc) × 10 high; relief between the inner and the outer area.
        const added = volume(body) - base;
        expect(added).toBeGreaterThan(100);
        expect(added).toBeLessThan(110);
    });

    test("deboss follows the curvature inwards", () => {
        const doc = newDocument();
        const { body, sketch, side } = cylinderWithSketch(doc);
        const base = volume(body);
        emboss(body, sketch, side, 1, true);
        expect(errors(body)).toEqual([undefined, undefined]);
        const removed = base - volume(body);
        expect(removed).toBeGreaterThan(90);
        expect(removed).toBeLessThan(105);
    });
});

describe("the emboss command's feature", () => {
    test("captures the picked faces with their tracked ids and embosses the whole sketch", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        const faces = facesOf(body);
        const top = faces.findIndex(isTop(20));
        const picked = [
            { shape: faces[top], owner: { node: body }, transform: Matrix4.identity(), indexes: [top] },
        ] as unknown as VisualShapeData[];
        const feature = buildEmbossFeature(sketch, [], body, picked, 3, true);
        expect(feature).toMatchObject({ type: "emboss", sketchId: sketch.id, depth: 3, deboss: true });
        expect(feature.profiles).toBeUndefined();
        expect(feature.faces).toHaveLength(1);
        expect(feature.faces[0].id).toBe(body.faceIdAt(top));
        body.setFeaturesEmitShapeChanged([...body.features, feature]);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(40 * 40 * 20 - 10 * 10 * 3, 3);
    });
});
