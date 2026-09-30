// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Extrude extents (issue #59) against the real kernel: to object (a face of the same body, of
 * another body, a curved face) and through all, with join and cut, on one body and through an
 * extrude's other targets (`extrudeTarget`); a face that goes away fails the feature with a
 * clear error; undo, save/load and ids across a resize.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IEdge,
    type IFace,
    type IVertex,
    Matrix4,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { applyExtrudeToTargets } from "../src/commands/extrudeCommand";
import { captureEdgeRef } from "../src/features/edgeRef";
import { captureExtentFaceRef } from "../src/features/extrudeExtent";
import type { ExtrudeExtent, ExtrudeFeatureData } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { captureFaceRef, sketchPlaneOfFace } from "../src/sketch/planeRef";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src/commands";
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

const planeAtZ = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

function newDocument() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    return doc;
}

type Doc = ReturnType<typeof newDocument>;

const volume = (body: ParametricBodyNode) => {
    expect(body.shape.isOk).toBe(true);
    return Math.abs(body.shape.value.volume());
};

/** A 20×20 block of height `height` from z = `z0`, as body `id`. */
function block(doc: Doc, id: string, height: number, x0 = 0, z0 = 0) {
    const sketch = new SketchNode({ document: doc, plane: planeAtZ(z0), data: rect(x0, 0, x0 + 20, 20) });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        id,
        features: [{ id: `${id}-base`, type: "extrude", sketchId: sketch.id, depth: height }],
    });
    doc.modelManager.addNode(body);
    expect(volume(body)).toBeCloseTo(400 * height, 3);
    return body;
}

/** Index of the face of `body` whose outward normal at its origin is `normal` (planar faces). */
function faceIndex(body: ParametricBodyNode, test: (face: IFace) => boolean): number {
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex(test);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
}

const facing = (normal: XYZ) => (face: IFace) =>
    face.surface().isPlanar() && face.normal(0, 0)[1].dot(normal) > 1 - 1e-6;

/** The to-object extent of `body`'s face at `index`, as the command captures it. */
function toFace(body: ParametricBodyNode, index: number): ExtrudeExtent {
    const face = (body.shape.value.findSubShapes(ShapeTypes.face) as IFace[])[index];
    const id = body.faceIdAt(index);
    expect(id).not.toBeUndefined();
    return {
        type: "toObject",
        nodeId: body.id,
        face: captureExtentFaceRef(face, id, body.faceIdIsShared(id)),
    };
}

/** A sketch on `body`'s top face that follows it, with a 5×5 square at (7.5…12.5). */
function topSketch(doc: Doc, body: ParametricBodyNode, data: SketchData = rect(7.5, 7.5, 12.5, 12.5)) {
    const index = faceIndex(body, facing(XYZ.unitZ));
    const top = (body.shape.value.findSubShapes(ShapeTypes.face) as IFace[])[index];
    const plane = sketchPlaneOfFace(top);
    const sketch = new SketchNode({
        document: doc,
        plane,
        planeRef: { ...captureFaceRef(body.id, top), faceId: body.faceIdAt(index) },
        data,
    });
    doc.modelManager.addNode(sketch);
    return sketch;
}

function append(body: ParametricBodyNode, feature: ExtrudeFeatureData) {
    Transaction.execute(body.document, "add feature", () => {
        body.setFeaturesEmitShapeChanged([...body.features, feature]);
    });
}

const errors = (body: ParametricBodyNode) => body.featureItems().map((x) => x.error);

describe("to object: a face of the same body", () => {
    test("a cut from a top-face sketch down to the bottom face stays through when the block grows", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        const bottom = toFace(body, faceIndex(body, facing(XYZ.unitZ.multiply(-1))));
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "cut",
            extent: bottom,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(4000 - 25 * 10, 3);
        const holeFaceIds = body.featureFaces("hole").map((index) => body.faceIdAt(index));
        expect(holeFaceIds.length).toBeGreaterThan(0);

        Transaction.execute(doc, "resize", () => body.setFeatureParameter("cube-base", "depth", 25));

        expect(errors(body)).toEqual([undefined, undefined]);
        // Through again: 20×20×25 minus the 5×5 hole over the whole height.
        expect(volume(body)).toBeCloseTo(400 * 25 - 25 * 25, 3);
        // The hole's faces keep their ids across the resize (profile-relative channels).
        expect(body.featureFaces("hole").map((index) => body.faceIdAt(index))).toEqual(holeFaceIds);
    });

    test("a stored offset stops the cut short of the face", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        const bottom = toFace(body, faceIndex(body, facing(XYZ.unitZ.multiply(-1))));
        append(body, {
            id: "pocket",
            type: "extrude",
            sketchId: sketch.id,
            depth: -1,
            operation: "cut",
            extent: { ...bottom, offset: -4 } as ExtrudeExtent,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(4000 - 25 * 6, 3);
    });

    test("undo and redo bring the extent back with the feature", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        const bottom = toFace(body, faceIndex(body, facing(XYZ.unitZ.multiply(-1))));
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "cut",
            extent: bottom,
        });
        expect(volume(body)).toBeCloseTo(3750, 3);

        doc.history.undo();
        expect(body.features).toHaveLength(1);
        expect(volume(body)).toBeCloseTo(4000, 3);

        doc.history.redo();
        expect((body.features[1] as ExtrudeFeatureData).extent?.type).toBe("toObject");
        expect(volume(body)).toBeCloseTo(3750, 3);
    });

    test("saved and loaded, the extent rebuilds the same body", async () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        const bottom = toFace(body, faceIndex(body, facing(XYZ.unitZ.multiply(-1))));
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "cut",
            extent: bottom,
        });
        expect(volume(body)).toBeCloseTo(3750, 3);
        const saved = structuredClone(doc.modelManager.serialize());

        const loaded = newDocument();
        await loaded.modelManager.deserialize(saved);

        const copy = loaded.modelManager.findNode((n) => n.id === "cube") as ParametricBodyNode;
        expect(copy).toBeInstanceOf(ParametricBodyNode);
        expect(volume(copy)).toBeCloseTo(3750, 3);
        expect(errors(copy)).toEqual([undefined, undefined]);
        expect(loaded.modelManager.serialize()).toEqual(saved);
    });
});

describe("to object: another body's face", () => {
    test("a join up to a plate above follows the plate when it moves", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const plate = block(doc, "plate", 5, 0, 30);
        const sketch = topSketch(doc, body);
        append(body, {
            id: "post",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "fuse",
            extent: toFace(plate, faceIndex(plate, facing(XYZ.unitZ.multiply(-1)))),
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        // The post fills z 10…30.
        expect(volume(body)).toBeCloseTo(4000 + 25 * 20, 3);

        Transaction.execute(doc, "move plate", () =>
            plate.setFeatureParameter("plate-base", "startOffset", 10),
        );

        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(4000 + 25 * 30, 3);
    });

    test("a curved face ends the extrude on the surface", () => {
        const doc = newDocument();
        // A cylinder of radius 5 along y, axis at x = 10, z = 20: sketched on the ZX plane
        // (normal +y), extruded 20 along y.
        const zx = new Plane({ origin: XYZ.zero, normal: XYZ.unitY.multiply(-1), xvec: XYZ.unitX });
        const circle = new SketchNode({
            document: doc,
            plane: zx,
            data: { entities: [{ id: 1, type: "circle", params: [10, 20, 5] }], constraints: [] },
        });
        doc.modelManager.addNode(circle);
        const cylinder = new ParametricBodyNode({
            document: doc,
            id: "cylinder",
            features: [{ id: "cylinder-base", type: "extrude", sketchId: circle.id, depth: -20 }],
        });
        doc.modelManager.addNode(cylinder);
        expect(volume(cylinder)).toBeCloseTo(Math.PI * 25 * 20, 2);
        const curved = faceIndex(cylinder, (face) => !face.surface().isPlanar());

        const square = new SketchNode({ document: doc, plane: Plane.XY, data: rect(8, 8, 12, 12) });
        doc.modelManager.addNode(square);
        const post = new ParametricBodyNode({
            document: doc,
            id: "post",
            features: [
                {
                    id: "post-base",
                    type: "extrude",
                    sketchId: square.id,
                    depth: 0,
                    extent: toFace(cylinder, curved),
                },
            ],
        });
        doc.modelManager.addNode(post);

        expect(errors(post)).toEqual([undefined]);
        // The top follows the cylinder's underside: z from 15 (under the axis) to 20 - √21 at |x - 10| = 2.
        const v = volume(post);
        expect(v).toBeGreaterThan(16 * 15);
        expect(v).toBeLessThan(16 * (20 - Math.sqrt(21)));
        const faces = post.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        expect(faces.some((face) => !face.surface().isPlanar())).toBe(true);
    });
});

describe("through all", () => {
    test("a cut goes through the body whatever its height", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: -1,
            operation: "cut",
            extent: { type: "throughAll" },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(4000 - 25 * 10, 3);

        Transaction.execute(doc, "resize", () => body.setFeatureParameter("cube-base", "depth", 40));

        expect(volume(body)).toBeCloseTo(400 * 40 - 25 * 40, 3);
    });

    test("the direction reverses by itself when nothing lies ahead", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = topSketch(doc, body);
        // depth ≥ 0 points up, out of the block: the cut goes down instead.
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "cut",
            extent: { type: "throughAll" },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(3750, 3);
    });

    test("a join ends flush with the far side of the body", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = new SketchNode({
            document: doc,
            plane: planeAtZ(15),
            data: rect(7.5, 7.5, 12.5, 12.5),
        });
        doc.modelManager.addNode(sketch);
        append(body, {
            id: "post",
            type: "extrude",
            sketchId: sketch.id,
            depth: -1,
            operation: "fuse",
            extent: { type: "throughAll" },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        // From z = 15 down to the bottom: only z 10…15 is new material.
        expect(volume(body)).toBeCloseTo(4000 + 25 * 5, 3);
        const box = body.shape.value.boundingBox()!;
        expect(box.min.z).toBeCloseTo(0, 6);
    });

    test("a new body has nothing to go through: a clear feature error", () => {
        const doc = newDocument();
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(0, 0, 5, 5) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "lone",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 5,
                    extent: { type: "throughAll" },
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(false);
        expect(errors(body)).toEqual(["Through all needs a body to go through (join, cut or intersect)"]);
    });

    test("symmetric: through the body both ways from a mid plane", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = new SketchNode({
            document: doc,
            plane: planeAtZ(5),
            data: rect(7.5, 7.5, 12.5, 12.5),
        });
        doc.modelManager.addNode(sketch);
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 1,
            symmetric: true,
            operation: "cut",
            extent: { type: "throughAll" },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(3750, 3);
    });
});

describe("two-sided", () => {
    test("each side has its own extent: a face on one side, a distance on the other", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = new SketchNode({
            document: doc,
            plane: planeAtZ(5),
            data: rect(7.5, 7.5, 12.5, 12.5),
        });
        doc.modelManager.addNode(sketch);
        const top = toFace(body, faceIndex(body, facing(XYZ.unitZ)));
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 2,
            symmetric: true,
            operation: "cut",
            extent: top,
            secondExtent: { type: "distance" },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        // Up to the top (z 5…10) and 2 down (z 3…5).
        expect(volume(body)).toBeCloseTo(4000 - 25 * 7, 3);
    });

    test("a symmetric extrude with a single to-object extent is refused", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const sketch = new SketchNode({
            document: doc,
            plane: planeAtZ(5),
            data: rect(7.5, 7.5, 12.5, 12.5),
        });
        doc.modelManager.addNode(sketch);
        const top = toFace(body, faceIndex(body, facing(XYZ.unitZ)));
        append(body, {
            id: "hole",
            type: "extrude",
            sketchId: sketch.id,
            depth: 2,
            symmetric: true,
            operation: "cut",
            extent: top,
        });
        expect(errors(body)[1]).toBe(
            "A symmetric extrude cannot end on a face: give the second side its own extent",
        );
    });
});

describe("an extrude acting on several bodies", () => {
    /** Two blocks side by side and a slot sketch on their tops spanning both (x 10…40). */
    function twoBlocks() {
        const doc = newDocument();
        const left = block(doc, "left", 10);
        const right = block(doc, "right", 10, 30);
        const sketch = new SketchNode({ document: doc, plane: planeAtZ(10), data: rect(10, 5, 40, 15) });
        doc.modelManager.addNode(sketch);
        return { doc, left, right, sketch };
    }

    test("through all cuts every target through its own height", () => {
        const { doc, left, right, sketch } = twoBlocks();
        Transaction.execute(doc, "slot", () =>
            applyExtrudeToTargets(
                {
                    id: "slot",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: -1,
                    operation: "cut",
                    extent: { type: "throughAll" },
                },
                [left, right],
            ),
        );
        expect(errors(left)).toEqual([undefined, undefined]);
        expect(errors(right)).toEqual([undefined, undefined]);
        expect(volume(left)).toBeCloseTo(4000 - 1000, 3);
        expect(volume(right)).toBeCloseTo(4000 - 1000, 3);

        // The other target grows: the cut still goes all the way through it.
        Transaction.execute(doc, "grow", () => right.setFeatureParameter("right-base", "startOffset", -20));
        expect(volume(right)).toBeCloseTo(4000 - 1000, 3);
        const box = right.shape.value.boundingBox()!;
        expect(box.min.z).toBeCloseTo(-20, 6);
    });

    test("up to a face of the other target: both bodies are cut down to it, and follow it", () => {
        const { doc, left, right, sketch } = twoBlocks();
        const bottom = toFace(right, faceIndex(right, facing(XYZ.unitZ.multiply(-1))));
        Transaction.execute(doc, "slot", () =>
            applyExtrudeToTargets(
                {
                    id: "slot",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: -1,
                    operation: "cut",
                    extent: bottom,
                },
                [left, right],
            ),
        );
        expect(errors(left)).toEqual([undefined, undefined]);
        expect(errors(right)).toEqual([undefined, undefined]);
        expect(volume(left)).toBeCloseTo(3000, 3);
        expect(volume(right)).toBeCloseTo(3000, 3);

        // The right block moves up by 5: its bottom (z 5) now stops the cut in both.
        Transaction.execute(doc, "raise", () => right.setFeatureParameter("right-base", "startOffset", 5));
        expect(errors(left)).toEqual([undefined, undefined]);
        expect(errors(right)).toEqual([undefined, undefined]);
        expect(volume(left)).toBeCloseTo(4000 - 500, 3);
        // The right block spans z 5…15: cut from the sketch (z 10) down to its bottom (z 5).
        expect(volume(right)).toBeCloseTo(4000 - 500, 3);
    });
});

describe("a target face that goes away fails the feature", () => {
    test("the face's body is deleted, and undo brings it back", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const plate = block(doc, "plate", 5, 0, 30);
        const sketch = topSketch(doc, body);
        append(body, {
            id: "post",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "fuse",
            extent: toFace(plate, faceIndex(plate, facing(XYZ.unitZ.multiply(-1)))),
        });
        expect(volume(body)).toBeCloseTo(4500, 3);

        Transaction.execute(doc, "delete plate", () => plate.parent!.remove(plate));
        expect(errors(body)).toEqual([undefined, "Extent face's body not found"]);

        doc.history.undo();
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(4500, 3);
    });

    test("the face is consumed by a later feature of its body", () => {
        const doc = newDocument();
        const body = block(doc, "cube", 10);
        const plate = block(doc, "plate", 5, 0, 30);
        const sketch = topSketch(doc, body);
        append(body, {
            id: "post",
            type: "extrude",
            sketchId: sketch.id,
            depth: 0,
            operation: "fuse",
            extent: toFace(plate, faceIndex(plate, facing(XYZ.unitZ.multiply(-1)))),
        });
        expect(volume(body)).toBeCloseTo(4500, 3);

        // A cut taking the plate's whole lower millimetre away: its bottom face is gone.
        const under = new SketchNode({ document: doc, plane: planeAtZ(30), data: rect(-5, -5, 25, 25) });
        doc.modelManager.addNode(under);
        append(plate, { id: "shave", type: "extrude", sketchId: under.id, depth: 1, operation: "cut" });
        expect(volume(plate)).toBeCloseTo(400 * 4, 3);

        expect(errors(body)[1]).toBe("Extent face: Face not found after rebuild");
    });
});

describe("associative starting faces", () => {
    test("curved caps follow a cylinder radius rebuild and preserve bottom-edge identities", () => {
        const doc = newDocument();
        const circle = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: { entities: [{ id: 1, type: "circle", params: [0, 0, 10] }], constraints: [] },
        });
        doc.modelManager.addNode(circle);
        const cylinder = new ParametricBodyNode({
            document: doc,
            id: "start-cylinder",
            features: [{ id: "cylinder-base", type: "extrude", sketchId: circle.id, depth: 20 }],
        });
        doc.modelManager.addNode(cylinder);
        expect(volume(cylinder)).toBeCloseTo(Math.PI * 100 * 20, 2);
        const index = faceIndex(cylinder, (face) => !face.surface().isPlanar());
        const extent = toFace(cylinder, index);
        expect(extent.type).toBe("toObject");
        if (extent.type !== "toObject") throw new Error("Expected face reference");
        const plane = new Plane({
            origin: new XYZ({ x: 15, y: 0, z: 0 }),
            normal: XYZ.unitX,
            xvec: XYZ.unitY,
        });
        const square = new SketchNode({ document: doc, plane, data: rect(-2, 8, 2, 12) });
        doc.modelManager.addNode(square);
        const boss = new ParametricBodyNode({
            document: doc,
            id: "curved-boss",
            features: [
                {
                    id: "boss",
                    type: "extrude",
                    sketchId: square.id,
                    depth: 5,
                    startFace: { nodeId: cylinder.id, face: extent.face },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(80, 3);
        const curved = (boss.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).filter(
            (face) => !face.surface().isPlanar(),
        );
        // The cylindrical seam splits each exact curved cap into two pieces.
        expect(curved).toHaveLength(4);
        const vertices = boss.shape.value.findSubShapes(ShapeTypes.vertex);
        const xs = vertices.map((vertex) => (vertex as IVertex).point().x);
        expect(Math.min(...xs)).toBeCloseTo(Math.sqrt(96), 4);
        expect(Math.max(...xs)).toBeCloseTo(15, 4);
        const edgeIds = boss.shape.value.findSubShapes(ShapeTypes.edge).map((_, i) => boss.edgeIdAt(i));
        expect(edgeIds.filter((id) => id !== undefined).length).toBeGreaterThan(0);
        Transaction.execute(
            doc,
            "resize cylinder",
            () =>
                (circle.dataJson = JSON.stringify({
                    entities: [{ id: 1, type: "circle", params: [0, 0, 12] }],
                    constraints: [],
                })),
        );
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(80, 3);
        const rebuiltIds = boss.shape.value.findSubShapes(ShapeTypes.edge).map((_, i) => boss.edgeIdAt(i));
        expect(new Set(rebuiltIds)).toEqual(new Set(edgeIds));
        const rebuiltXs = boss.shape.value
            .findSubShapes(ShapeTypes.vertex)
            .map((vertex) => (vertex as IVertex).point().x);
        expect(Math.min(...rebuiltXs)).toBeCloseTo(Math.sqrt(140), 4);
        doc.history.undo();
        expect(volume(boss)).toBeCloseTo(80, 3);
        expect(
            Math.min(
                ...boss.shape.value
                    .findSubShapes(ShapeTypes.vertex)
                    .map((vertex) => (vertex as IVertex).point().x),
            ),
        ).toBeCloseTo(Math.sqrt(96), 4);
        const edges = boss.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const picked = edges.findIndex((edge) => Math.abs(edge.length() - 5) < 1e-6);
        expect(picked).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(edges[picked], boss.edgeIdAt(picked));
        expect(ref.edgeId).not.toBeUndefined();
        append(boss, { id: "round-curved-boss", type: "fillet", radius: 0.2, edges: [ref] } as never);
        expect(boss.shape.isOk).toBe(true);
        circle.setDataEmitShapeChanged({
            entities: [{ id: 1, type: "circle", params: [0, 0, 12] }],
            constraints: [],
        });
        expect(boss.shape.isOk).toBe(true);
        expect(errors(boss)).toEqual([undefined, undefined]);
        expect(
            (boss.features[1] as import("../src/features/feature").FilletFeatureData).edges[0].edgeId,
        ).toBe(ref.edgeId);
    });
});

describe("from-face boundary validation and directions", () => {
    test.each([
        [5, 2, 12, 17],
        [-5, 2, 7, 12],
        [5, -2, 8, 13],
    ] as const)("depth %i and offset %i are measured from the selected surface", (depth, offset, low, high) => {
        const doc = newDocument();
        const target = block(doc, "starting-box", 10);
        const extent = toFace(target, faceIndex(target, facing(XYZ.unitZ)));
        expect(extent.type).toBe("toObject");
        if (extent.type !== "toObject") throw new Error("Expected face");
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
        doc.modelManager.addNode(sketch);
        const boss = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "boss",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth,
                    startOffset: offset,
                    startFace: { nodeId: target.id, face: extent.face },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(125, 4);
        const zs = boss.shape.value
            .findSubShapes(ShapeTypes.vertex)
            .map((vertex) => (vertex as IVertex).point().z);
        expect(Math.min(...zs)).toBeCloseTo(low, 4);
        expect(Math.max(...zs)).toBeCloseTo(high, 4);
    });
    test("a downstream fillet follows a starting face height change using its captured edge", () => {
        const doc = newDocument();
        const target = block(doc, "starting-box", 10);
        const extent = toFace(target, faceIndex(target, facing(XYZ.unitZ)));
        if (extent.type !== "toObject") throw new Error("Expected face");
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
        doc.modelManager.addNode(sketch);
        const boss = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "boss",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 5,
                    startFace: { nodeId: target.id, face: extent.face },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(volume(boss)).toBeCloseTo(125, 4);
        const edges = boss.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const picked = edges.findIndex((edge) => Math.abs(edge.startPoint().z - edge.endPoint().z) > 4.9);
        expect(picked).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(edges[picked], boss.edgeIdAt(picked));
        expect(ref.edgeId).not.toBeUndefined();
        append(boss, { id: "round", type: "fillet", radius: 0.5, edges: [ref] } as never);
        expect(errors(boss)).toEqual([undefined, undefined]);
        const rounded = volume(boss);
        target.setFeaturesEmitShapeChanged([{ ...target.features[0], depth: 14 } as ExtrudeFeatureData]);
        expect(errors(boss)).toEqual([undefined, undefined]);
        expect(volume(boss)).toBeCloseTo(rounded, 4);
        expect((boss.features[1] as any).edges[0].edgeId).toBe(ref.edgeId);
    });
    test.each([
        [30, 30, 35, 35],
        [18, 5, 23, 10],
    ])("a profile with uncovered starting surface %j fails explicitly", (x0, y0, x1, y1) => {
        const doc = newDocument();
        const target = block(doc, "starting-box", 10);
        const extent = toFace(target, faceIndex(target, facing(XYZ.unitZ)));
        if (extent.type !== "toObject") throw new Error("Expected face");
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(x0, y0, x1, y1) });
        doc.modelManager.addNode(sketch);
        const boss = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "boss",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 5,
                    startFace: { nodeId: target.id, face: extent.face },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(boss.shape.isOk).toBe(false);
        expect(errors(boss)[0]).toMatch(/starting and ending faces|intersection|bound/);
    });
});

describe("starting-face extents and coordinate spaces", () => {
    test.each([
        "toObject",
        "throughAll",
        "symmetric",
    ] as const)("supports %s after the face start", (mode) => {
        const doc = newDocument();
        const target = block(doc, "boundary-box", 20);
        const start = toFace(target, faceIndex(target, facing(XYZ.unitZ.multiply(-1))));
        if (start.type !== "toObject") throw new Error("Expected starting face");
        const end = toFace(target, faceIndex(target, facing(XYZ.unitZ)));
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
        doc.modelManager.addNode(sketch);
        const feature: ExtrudeFeatureData = {
            id: "from",
            type: "extrude",
            sketchId: sketch.id,
            depth: 5,
            startFace: { nodeId: target.id, face: start.face },
            ...(mode === "toObject"
                ? { extent: end }
                : mode === "throughAll"
                  ? { extent: { type: "throughAll" }, operation: "cut" }
                  : { symmetric: true }),
        };
        const body =
            mode === "throughAll" ? target : new ParametricBodyNode({ document: doc, features: [feature] });
        if (mode === "throughAll") append(body, feature);
        else doc.modelManager.addNode(body);
        expect(errors(body).every((error) => error === undefined)).toBe(true);
        expect(volume(body)).toBeCloseTo(mode === "toObject" ? 500 : mode === "throughAll" ? 7500 : 250, 3);
    });
    test("an externally transformed starting face resolves in the tool host space", () => {
        const doc = newDocument();
        const target = block(doc, "placed-boundary", 10);
        target.transform = Matrix4.fromTranslation(0, 0, 20);
        const index = faceIndex(target, facing(XYZ.unitZ));
        const local = (target.shape.value.findSubShapes(ShapeTypes.face) as IFace[])[index];
        const world = local.transformedMul(target.worldTransform()) as IFace;
        const ref = captureExtentFaceRef(world, target.faceIdAt(index));
        world.dispose();
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
        doc.modelManager.addNode(sketch);
        const boss = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "boss",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 5,
                    startFace: { nodeId: target.id, face: ref },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(125, 4);
        const zs = boss.shape.value
            .findSubShapes(ShapeTypes.vertex)
            .map((vertex) => (vertex as IVertex).point().z);
        expect(Math.min(...zs)).toBeCloseTo(30, 4);
        expect(Math.max(...zs)).toBeCloseTo(35, 4);
    });
});

test("linked extrusion targets resolve the starting face before their own entry", () => {
    const doc = newDocument();
    const host = block(doc, "host", 10);
    const target = block(doc, "target", 20);
    const ref = toFace(host, faceIndex(host, facing(XYZ.unitZ)));
    if (ref.type !== "toObject") throw new Error("Expected starting face");
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
    doc.modelManager.addNode(sketch);
    Transaction.execute(doc, "linked face-start cut", () =>
        applyExtrudeToTargets(
            {
                id: "slot",
                type: "extrude",
                sketchId: sketch.id,
                depth: -5,
                operation: "cut",
                startFace: { nodeId: host.id, face: ref.face },
            },
            [host, target],
        ),
    );
    expect(volume(host)).toBeCloseTo(3875, 3);
    expect(volume(target)).toBeCloseTo(7875, 3);
    expect(errors(host)).toEqual([undefined, undefined]);
    expect(errors(target)).toEqual([undefined, undefined]);
    host.setFeatureParameter("host-base", "depth", 12);
    expect(volume(host)).toBeCloseTo(4675, 3);
    expect(volume(target)).toBeCloseTo(7875, 3);
    expect(errors(host)).toEqual([undefined, undefined]);
    expect(errors(target)).toEqual([undefined, undefined]);
});

describe("automatic next-face extents", () => {
    test("captures candidates once and retargets after an upstream placement edit", () => {
        const doc = newDocument();
        const near = block(doc, "near-next", 5, 0, 10);
        const far = block(doc, "far-next", 5, 0, 30);
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(5, 5, 10, 10) });
        doc.modelManager.addNode(sketch);
        const candidateIds = [near.id, far.id];
        const boss = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "next-boss",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 1,
                    extent: { type: "next", nodeIds: candidateIds },
                },
            ],
        });
        doc.modelManager.addNode(boss);
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(250, 4);
        block(doc, "later-next", 5, 0, 5);
        expect(volume(boss)).toBeCloseTo(250, 4);
        near.transform = Matrix4.fromTranslation(0, 0, 25);
        expect(errors(boss)).toEqual([undefined]);
        expect(volume(boss)).toBeCloseTo(750, 4);
        expect(boss.features[0]).toMatchObject({ extent: { type: "next", nodeIds: candidateIds } });
    });

    test("same-host next cuts resolve against the state entering the feature", () => {
        const doc = newDocument();
        const body = block(doc, "next-host", 10);
        const sketch = topSketch(doc, body);
        append(body, {
            id: "next-cut",
            type: "extrude",
            sketchId: sketch.id,
            depth: -1,
            operation: "cut",
            extent: { type: "next", nodeIds: [] },
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(3750, 4);
        body.setFeatureParameter("next-host-base", "depth", 20);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(7500, 4);
    });

    test("a missing captured candidate fails explicitly", () => {
        const doc = newDocument();
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(0, 0, 4, 4) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "missing-next",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 1,
                    extent: { type: "next", nodeIds: ["deleted-candidate"] },
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(false);
        expect(errors(body)[0]).toMatch(/next.*deleted-candidate|deleted-candidate.*next/i);
    });
});

test("automatic next curved caps follow cylinder radius and preserve downstream edge references", () => {
    const doc = newDocument();
    const circle = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 10] }], constraints: [] },
    });
    doc.modelManager.addNode(circle);
    const cylinder = new ParametricBodyNode({
        document: doc,
        id: "next-cylinder",
        features: [{ id: "next-cylinder-base", type: "extrude", sketchId: circle.id, depth: 20 }],
    });
    doc.modelManager.addNode(cylinder);
    const square = new SketchNode({
        document: doc,
        plane: new Plane({ origin: new XYZ({ x: 15, y: 0, z: 0 }), normal: XYZ.unitX, xvec: XYZ.unitY }),
        data: rect(-2, 8, 2, 12),
    });
    doc.modelManager.addNode(square);
    const boss = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "next-curved-boss",
                type: "extrude",
                sketchId: square.id,
                depth: -1,
                extent: { type: "next", nodeIds: [cylinder.id] },
            },
        ],
    });
    doc.modelManager.addNode(boss);
    expect(errors(boss)).toEqual([undefined]);
    const expected = (radius: number) =>
        240 - 4 * (2 * Math.sqrt(radius * radius - 4) + radius * radius * Math.asin(2 / radius));
    expect(volume(boss)).toBeCloseTo(expected(10), 3);
    const ids = boss.shape.value.findSubShapes(ShapeTypes.edge).map((_, i) => boss.edgeIdAt(i));
    const edges = boss.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const picked = edges.findIndex((edge) =>
        edge
            .findSubShapes(ShapeTypes.vertex)
            .every((vertex) => Math.abs((vertex as IVertex).point().x - 15) < 1e-6),
    );
    expect(picked).toBeGreaterThanOrEqual(0);
    const ref = captureEdgeRef(edges[picked], boss.edgeIdAt(picked));
    expect(ref.edgeId).not.toBeUndefined();
    circle.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 12] }],
        constraints: [],
    });
    expect(errors(boss)).toEqual([undefined]);
    expect(volume(boss)).toBeCloseTo(expected(12), 3);
    expect(new Set(boss.shape.value.findSubShapes(ShapeTypes.edge).map((_, i) => boss.edgeIdAt(i)))).toEqual(
        new Set(ids),
    );
    append(boss, { id: "next-cap-fillet", type: "fillet", radius: 0.2, edges: [ref] } as never);
    expect(errors(boss)).toEqual([undefined, undefined]);
    circle.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 11] }],
        constraints: [],
    });
    expect(errors(boss)).toEqual([undefined, undefined]);
    expect((boss.features[1] as import("../src/features/feature").FilletFeatureData).edges[0].edgeId).toBe(
        ref.edgeId,
    );
});
