// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, Matrix4, Plane, ShapeTypes, type VisualShapeData, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { captureEmbossFaces } from "../src/commands/embossCommand";
import { captureEmbossFaceRef } from "../src/features/emboss";
import type { EmbossFeatureData, FeatureData } from "../src/features/feature";
import { resolveProfiles } from "../src/features/profileBuilder";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
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
    doc.visual = createMockVisualWithDocument(doc);
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
    faces.forEach((face) => {
        face.dispose();
    });
    expect(refs.length).toBeGreaterThan(0);
    const feature: EmbossFeatureData = {
        id: "emboss",
        type: "emboss",
        sketchId: sketch.id,
        faces: refs,
        profiles: resolveProfiles(sketch).value.map(({ face }) => captureProfileRef(face)),
        depth,
        deboss,
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

    test("an oblique sketch clips by a through-prism while measuring depth along the target normal", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const plane = new Plane({
            origin: new XYZ({ x: 0, y: 15, z: 35 }),
            normal: new XYZ({ x: 0, y: 1, z: 1 }).normalize()!,
            xvec: XYZ.unitX,
        });
        const sketch = addSketch(doc, plane, rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 2);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(32000 + 200 * Math.SQRT2, 3);
        expect(body.shape.value.checkShape()).toBe(true);
        doc.dispose();
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
        expect(errors(body)[1]).toBe(
            'emboss step "emboss": Emboss profiles do not project onto the selected faces',
        );
    });

    test("a non-positive depth is refused", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const sketch = addSketch(doc, above(35), rect(10, 10, 20, 20));
        emboss(body, sketch, isTop(20), 0);
        expect(errors(body)[1]).toBe('emboss step "emboss": Emboss depth must be positive');
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
        // Exact annular sector: angle = 2 asin(5/15), height = 10, radii = 15 and 16.
        const added = volume(body) - base;
        expect(added).toBeCloseTo(31 * Math.asin(1 / 3) * 10, 3);
        expect(body.shape.value.checkShape()).toBe(true);
    });

    test.each([
        [false, 0],
        [true, 0],
        [false, 45],
        [true, 45],
    ])("oblique projection is independent of plane origins for deboss=%s, cylinder z=%s", (deboss, z) => {
        for (const [shift, reversed] of [
            [0, false],
            [60, false],
            [60, true],
        ] as const) {
            const doc = newDocument();
            try {
                const body = addBody(
                    doc,
                    above(z),
                    { entities: [{ id: 1, type: "circle", params: [0, 0, 15] }], constraints: [] },
                    40,
                );
                const direction = reversed ? -1 : 1;
                const plane = new Plane({
                    origin: new XYZ({ x: 0, y: 30 - shift, z: 40 + z + shift }),
                    normal: new XYZ({ x: 0, y: direction, z: direction }).normalize()!,
                    xvec: XYZ.unitX,
                });
                const offset = shift * Math.SQRT2;
                const sketch = addSketch(
                    doc,
                    plane,
                    reversed ? rect(-5, -5 - offset, 5, 5 - offset) : rect(-5, -5 + offset, 5, 5 + offset),
                );
                emboss(
                    body,
                    sketch,
                    (face) => {
                        const surface = face.surface();
                        try {
                            return !surface.isPlanar();
                        } finally {
                            surface.dispose();
                        }
                    },
                    1,
                    deboss,
                );
                expect(errors(body)).toEqual([undefined, undefined]);
                expect(body.shape.value.checkShape()).toBe(true);
                expect(volume(body)).toBeCloseTo(
                    9000 * Math.PI + (deboss ? -29 : 31) * Math.asin(1 / 3) * 10 * Math.SQRT2,
                    3,
                );
                expect(body.shape.value.boundingBox().min.y).toBeCloseTo(-15, 5);
            } finally {
                doc.dispose();
            }
        }
    });

    test.each([
        false,
        true,
    ])("projection across the cylinder silhouette stays on the near half for deboss=%s", (deboss) => {
        const doc = newDocument();
        const { body, sketch, side } = cylinderWithSketch(doc);
        sketch.setDataEmitShapeChanged(rect(-20, -25, 20, -15));
        emboss(body, sketch, side, 1, deboss);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(volume(body)).toBeCloseTo(9000 * Math.PI + (((deboss ? -29 : 31) * Math.PI) / 2) * 10, 3);
        expect(body.shape.value.boundingBox().min.y).toBeCloseTo(-15, 5);
        doc.dispose();
    });

    test.each([
        false,
        true,
    ])("a near-side patch crossing the cylinder parameter seam works for deboss=%s", (deboss) => {
        const doc = newDocument();
        const { body, side } = cylinderWithSketch(doc);
        const sketch = addSketch(
            doc,
            new Plane({ origin: new XYZ({ x: 30, y: 0, z: 0 }), normal: XYZ.unitX, xvec: XYZ.unitY }),
            rect(-5, 15, 5, 25),
        );
        emboss(body, sketch, side, 1, deboss);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(9000 * Math.PI + (deboss ? -29 : 31) * Math.asin(1 / 3) * 10, 3);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.boundingBox().min.x).toBeCloseTo(-15, 5);
        doc.dispose();
    });

    test("cylindrical relief preserves profile holes at exact radial depth", () => {
        const doc = newDocument();
        const { body, sketch, side } = cylinderWithSketch(doc);
        const outer = rect(-5, -25, 5, -15),
            hole = rect(-2, -22, 2, -18);
        sketch.setDataEmitShapeChanged({
            entities: [
                ...outer.entities,
                ...hole.entities.map((entity) => ({ ...entity, id: entity.id + 10 })),
            ],
            constraints: [],
        });
        emboss(body, sketch, side, 1);
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(volume(body)).toBeCloseTo(
            9000 * Math.PI + 31 * (Math.asin(1 / 3) * 10 - Math.asin(2 / 15) * 4),
            3,
        );
        expect(body.shape.value.checkShape()).toBe(true);
        doc.dispose();
    });

    test("deboss follows the curvature inwards", () => {
        const doc = newDocument();
        const { body, sketch, side } = cylinderWithSketch(doc);
        const base = volume(body);
        emboss(body, sketch, side, 1, true);
        expect(errors(body)).toEqual([undefined, undefined]);
        const removed = base - volume(body);
        expect(removed).toBeCloseTo(29 * Math.asin(1 / 3) * 10, 3);
        expect(body.shape.value.checkShape()).toBe(true);
    });
});

describe("target capture", () => {
    test("captures local faces with tracked IDs independently of render mesh indexes", () => {
        const doc = newDocument();
        const body = addBody(doc, Plane.XY, rect(0, 0, 40, 40), 20);
        const faces = facesOf(body);
        const top = faces.findIndex(isTop(20));
        expect(top).toBeGreaterThanOrEqual(0);
        // A mesh range carries the topology index; rendering indexes deliberately differ.
        const meshFace = body.mesh.faces!.range.find((range) =>
            isTop(20)(range.shape as unknown as IFace),
        )!.shape;
        const picked = [
            { shape: meshFace, owner: { node: body }, transform: Matrix4.identity(), indexes: [9876] },
        ] as unknown as VisualShapeData[];
        const refs = captureEmbossFaces(body, picked);
        expect(refs).toHaveLength(1);
        expect(refs[0].id).toBe(body.faceIdAt(top));
        expect(refs[0].center?.z).toBeCloseTo(20, 6);
        faces.forEach((face) => {
            face.dispose();
        });
        doc.dispose();
    });
});
