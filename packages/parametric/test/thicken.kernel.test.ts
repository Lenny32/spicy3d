// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, Plane, ShapeTypes, Transaction, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory } from "@spicy3d/wasm";
import { captureEdgeRef } from "../src/features/edgeRef";
import { captureExtentFaceRef } from "../src/features/extrudeExtent";
import type { FeatureData, ThickenFeatureData } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";

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

const planeAt = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

/** A 20 x 20 square centered on the sketch origin. */
const square: SketchData = {
    entities: [
        { id: 1, type: "line", params: [-10, -10, 10, -10] },
        { id: 2, type: "line", params: [10, -10, 10, 10] },
        { id: 3, type: "line", params: [10, 10, -10, 10] },
        { id: 4, type: "line", params: [-10, 10, -10, -10] },
    ],
    constraints: [],
};

const circle = (radius: number): SketchData => ({
    entities: [{ id: 1, type: "circle", params: [0, 0, radius] }],
    constraints: [],
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function setWallThickness(doc: TestDocument, expression: string) {
    Transaction.execute(doc, "edit variables", () => {
        doc.variables.setItems([{ id: "v1", name: "wall_t", expression, type: "length" }]);
    });
}

/** A parametric 20 x 20 x 10 box on XY (extruded from z = 0 to 10). */
function boxBody(doc: TestDocument): ParametricBodyNode {
    const sketch = new SketchNode({ document: doc, plane: planeAt(0), data: square });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "e1", type: "extrude", sketchId: sketch.id, depth: 10 }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

/** An open smooth loft: a tube of radius 10 from z = 0 to 20. */
function tubeBody(doc: TestDocument): ParametricBodyNode {
    const sketches = [0, 20].map((z) => {
        const sketch = new SketchNode({ document: doc, plane: planeAt(z), data: circle(10) });
        doc.modelManager.addNode(sketch);
        return sketch;
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "l1",
                type: "loft",
                sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                solid: false,
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.shapeType).not.toBe(ShapeTypes.solid);
    return body;
}

function faces(body: ParametricBodyNode): IFace[] {
    return body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
}

/** The body's current face whose outward normal is +z, as the thicken command captures it. */
function topFaceRef(body: ParametricBodyNode) {
    const all = faces(body);
    const index = all.findIndex((face) => face.surface().isPlanar() && face.normal(0, 0)[1].z > 1 - 1e-6);
    expect(index).toBeGreaterThanOrEqual(0);
    const id = body.faceIdAt(index);
    return captureExtentFaceRef(all[index], id, body.faceIdIsShared(id));
}

function thicken(
    body: ParametricBodyNode,
    fields: Partial<ThickenFeatureData> & { thickness: number | string },
) {
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "t1", type: "thicken", ...fields } as FeatureData,
    ]);
}

function errorOf(body: ParametricBodyNode, featureId: string): string | undefined {
    return body.featureItems().find((item) => item.id === featureId)?.error;
}

/** Tracked ids of the faces lying on the box's outer planes x = ±10, y = ±10 and z = 0. */
function outerFaceIds(body: ParametricBodyNode): string[] {
    const ids: string[] = [];
    for (const [index, face] of faces(body).entries()) {
        if (!face.surface().isPlanar()) continue;
        const [point, normal] = face.normal(0, 0);
        const onOuterSide =
            (Math.abs(normal.x) > 1 - 1e-6 && Math.abs(Math.abs(point.x) - 10) < 1e-6) ||
            (Math.abs(normal.y) > 1 - 1e-6 && Math.abs(Math.abs(point.y) - 10) < 1e-6) ||
            (normal.z < -1 + 1e-6 && Math.abs(point.z) < 1e-6);
        if (onOuterSide) ids.push(body.faceIdAt(index) ?? "");
    }
    return ids.sort();
}

describe("thicken feature (real kernel)", () => {
    test("shells a solid open at its top face, inward", () => {
        const body = boxBody(newDoc());
        thicken(body, { thickness: -2, openFaces: [topFaceRef(body)] });

        expect(errorOf(body, "t1")).toBeUndefined();
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);
        // Five walls kept, five offset walls, one rim around the opening.
        expect(faces(body)).toHaveLength(11);
    });

    test("a positive thickness grows the walls outward", () => {
        const body = boxBody(newDoc());
        thicken(body, { thickness: 2, joinType: "intersection", openFaces: [topFaceRef(body)] });

        expect(errorOf(body, "t1")).toBeUndefined();
        // Sharp (intersection) corners: a 24 x 24 x 12 block around the 20 x 20 x 10 cavity.
        expect(body.shape.value.volume()).toBeCloseTo(24 * 24 * 12 - 4000, 3);
    });

    test("without open faces, a solid is hollowed with a closed void", () => {
        const inward = boxBody(newDoc());
        thicken(inward, { thickness: -2 });
        expect(errorOf(inward, "t1")).toBeUndefined();
        expect(inward.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 6, 3);
        // Six outer faces and the six faces of the void.
        expect(faces(inward)).toHaveLength(12);
        expect(inward.shape.value.checkShape()).toBe(true);

        const outward = boxBody(newDoc());
        thicken(outward, { thickness: 2, joinType: "intersection" });
        expect(errorOf(outward, "t1")).toBeUndefined();
        expect(outward.shape.value.volume()).toBeCloseTo(24 * 24 * 14 - 4000, 3);
        expect(outward.shape.value.checkShape()).toBe(true);
    });

    test.each([
        [2, Math.PI * (12 * 12 - 10 * 10) * 20],
        [-2, Math.PI * (10 * 10 - 8 * 8) * 20],
    ])("thickens an open lofted skin by %d into a solid wall", (thickness, volume) => {
        const body = tubeBody(newDoc());
        thicken(body, { thickness });

        expect(errorOf(body, "t1")).toBeUndefined();
        expect(body.shape.value.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        // Right side out: an outward offset comes back from the kernel inside out.
        expect(body.shape.value.volume()).toBeCloseTo(volume, 1);
        expect(body.shape.value.checkShape()).toBe(true);
    });

    test("an expression thickness re-evaluates when the variable changes", () => {
        const doc = newDoc();
        setWallThickness(doc, "2");
        const body = boxBody(doc);
        thicken(body, { thickness: "-wall_t", openFaces: [topFaceRef(body)] });
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);

        setWallThickness(doc, "3");

        expect(errorOf(body, "t1")).toBeUndefined();
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 14 * 14 * 7, 3);
    });

    test("faces the thicken leaves in place keep their ids, new ones are feature-scoped", () => {
        const body = boxBody(newDoc());
        const before = outerFaceIds(body);
        expect(before).toHaveLength(5);
        thicken(body, { thickness: -2, openFaces: [topFaceRef(body)] });

        expect(outerFaceIds(body)).toEqual(before);
        const ids = faces(body).map((_, index) => body.faceIdAt(index) ?? "");
        const created = ids.filter((id) => !before.includes(id));
        expect(created).toHaveLength(6);
        expect(created.every((id) => id.startsWith("t1:"))).toBe(true);
    });

    test("a fillet after the thicken survives a thickness edit", () => {
        const body = boxBody(newDoc());
        thicken(body, { thickness: -2, openFaces: [topFaceRef(body)] });
        // An outer vertical edge at (10, 10): untouched by the inward shell.
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => {
            const [start, end] = edge.ends();
            return [start, end].every((p) => Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y - 10) < 1e-6);
        });
        expect(index).toBeGreaterThanOrEqual(0);
        const edgeId = body.edgeIdAt(index);
        expect(edgeId).not.toBeUndefined();
        expect(edgeId!.startsWith("t1:")).toBe(false);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "f1",
                type: "fillet",
                radius: 1,
                edges: [captureEdgeRef(edges[index], edgeId, body.edgeIdIsShared(edgeId))],
            },
        ]);
        expect(errorOf(body, "f1")).toBeUndefined();
        const filleted = body.shape.value.volume();

        body.setFeatureParameter("t1", "thickness", -3);

        expect(errorOf(body, "t1")).toBeUndefined();
        expect(errorOf(body, "f1")).toBeUndefined();
        // The same corner rounded, on a thicker wall: the fillet removes the same volume.
        const unrounded = 4000 - 14 * 14 * 7;
        expect(body.shape.value.volume()).toBeCloseTo(unrounded - (4000 - 16 * 16 * 8 - filleted), 3);
    });

    test("the open face follows its id when the box grows", () => {
        const doc = newDoc();
        setWallThickness(doc, "10");
        const sketch = new SketchNode({ document: doc, plane: planeAt(0), data: square });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "e1", type: "extrude", sketchId: sketch.id, depth: "wall_t" }],
        });
        doc.modelManager.addNode(body);
        thicken(body, { thickness: -2, openFaces: [topFaceRef(body)] });
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);

        setWallThickness(doc, "20");

        expect(errorOf(body, "t1")).toBeUndefined();
        expect(body.shape.value.volume()).toBeCloseTo(8000 - 16 * 16 * 18, 3);
        const feature = body.features.find((x) => x.id === "t1") as ThickenFeatureData;
        // Re-anchored on the moved top face.
        expect(feature.openFaces?.[0].center?.z).toBeCloseTo(20, 6);
    });

    describe("errors", () => {
        test("needs a preceding feature", () => {
            const doc = newDoc();
            const body = new ParametricBodyNode({
                document: doc,
                features: [{ id: "t1", type: "thicken", thickness: 2 }],
            });
            doc.modelManager.addNode(body);

            expect(body.shape.isOk).toBe(false);
            expect(errorOf(body, "t1")).toBe("Thicken requires a preceding feature");
        });

        test.each([
            [0, "The thickness must not be zero"],
            ["wall_t - wall_t", "The thickness must not be zero"],
        ])("a thickness of %s is refused", (thickness, message) => {
            const doc = newDoc();
            setWallThickness(doc, "2");
            const body = boxBody(doc);
            thicken(body, { thickness, openFaces: [topFaceRef(body)] });

            expect(errorOf(body, "t1")).toBe(message);
        });

        test("an expression naming no variable fails the feature", () => {
            const body = boxBody(newDoc());
            thicken(body, { thickness: "missing_t" });

            expect(errorOf(body, "t1")).not.toBeUndefined();
            expect(errorOf(body, "t1")).toContain("missing_t");
        });

        test("open faces on an open shell are refused", () => {
            const doc = newDoc();
            const box = boxBody(doc);
            const ref = topFaceRef(box);
            const body = tubeBody(doc);
            thicken(body, { thickness: 2, openFaces: [ref] });

            expect(errorOf(body, "t1")).toBe("Only a solid can have open faces");
        });

        test("a wall thicker than the solid fails without breaking the kernel", () => {
            const body = boxBody(newDoc());
            thicken(body, { thickness: -20, openFaces: [topFaceRef(body)] });

            expect(errorOf(body, "t1")).toContain("thick solid");
            // The kernel still answers.
            const box = boxBody(newDoc());
            expect(box.shape.value.volume()).toBeCloseTo(4000, 6);
        });
    });
});

// Extracted sketch geometry from the snapshot attached to issue #126.
const mouseSkirtSections = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "fixtures/mouseSkirt.json"), "utf8"),
) as { z: number; data: SketchData }[];

function mouseSkirt(doc: TestDocument): ParametricBodyNode {
    const sketches = mouseSkirtSections.map(({ z, data }) => {
        const sketch = new SketchNode({ document: doc, plane: planeAt(z), data });
        doc.modelManager.addNode(sketch);
        return sketch;
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "loft",
                type: "loft",
                sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                solid: false,
                ruled: true,
            },
        ],
    });
    doc.modelManager.addNode(body);
    return body;
}

describe("periodic ruled loft thickening (issue #126)", () => {
    test.each([1.9, -1.9])("refuses inconsistent offset edge geometry at thickness %d", (thickness) => {
        const body = mouseSkirt(newDoc());
        expect(body.shape.isOk).toBe(true);
        const skin = body.shape.value;
        expect(skin.checkShape()).toBe(true);
        const converter = new OccShapeConverter();
        const before = converter.convertToBrep(skin);
        expect(before.isOk).toBe(true);

        const result = shapeFactory.makeThickSolidBySimple(skin, thickness);

        expect(result.isOk).toBe(false);
        expect(result.error).toBe(
            "Failed to create thick solid: offset edge curves are inconsistent with their surfaces (exact BRepCheck_Analyzer)",
        );
        // The failed kernel operation must not add p-curves or change tolerances on the loft.
        const after = converter.convertToBrep(skin);
        expect(after.isOk).toBe(true);
        expect(after.value).toBe(before.value);

        thicken(body, { thickness });
        expect(errorOf(body, "t1")).toBe(result.error);
        expect(body.featureItems().find((item) => item.id === "loft")?.error).toBeUndefined();
    });

    test.each([2, -2])("a valid shelled box still supports a trim at thickness %d", (thickness) => {
        const body = boxBody(newDoc());
        thicken(body, { thickness, joinType: "intersection", openFaces: [topFaceRef(body)] });
        expect(errorOf(body, "t1")).toBeUndefined();
        const wall = body.shape.value;
        const plane = new Plane({ origin: new XYZ(0, -20, -10), normal: XYZ.unitZ, xvec: XYZ.unitX });
        const box = shapeFactory.box(plane, 40, 40, 40);
        expect(box.isOk).toBe(true);
        try {
            const cut = shapeFactory.booleanCut([wall], [box.value]);
            expect(cut.isOk).toBe(true);
            try {
                expect(cut.value.checkShape()).toBe(true);
                expect(cut.value.volume()).toBeCloseTo(wall.volume() / 2, 1);
            } finally {
                cut.value.dispose();
            }
        } finally {
            box.value.dispose();
        }
    });
});
