// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import type { LoftFeatureData } from "../src/features/feature";
import { resolveProfiles, sketchProfiles } from "../src/features/profileBuilder";
import { captureProfileRef } from "../src/features/profileRef";
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

/** A square of side `size` centered on the sketch origin. */
const square = (size: number): SketchData => {
    const h = size / 2;
    return {
        entities: [
            { id: 1, type: "line", params: [-h, -h, h, -h] },
            { id: 2, type: "line", params: [h, -h, h, h] },
            { id: 3, type: "line", params: [h, h, -h, h] },
            { id: 4, type: "line", params: [-h, h, -h, -h] },
        ],
        constraints: [],
    };
};

const circle = (radius: number): SketchData => ({
    entities: [{ id: 1, type: "circle", params: [0, 0, radius] }],
    constraints: [],
});

function setup(sections: { z: number; data: SketchData }[], options: Partial<LoftFeatureData> = {}) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const sketches = sections.map(({ z, data }) => {
        const sketch = new SketchNode({ document: doc, plane: planeAt(z), data });
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
                ...options,
            },
        ],
    });
    doc.modelManager.addNode(body);
    return { doc, sketches, body };
}

function facesOf(body: ParametricBodyNode): IFace[] {
    return body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
}

/** Tracked face ids keyed by the face's outward-normal direction (one per face of a square frustum). */
function idsByNormal(body: ParametricBodyNode): Map<string, string | undefined> {
    return new Map(
        facesOf(body).map((face, index) => {
            const normal = face.normal(0, 0)[1];
            const key = [normal.x, normal.y, normal.z].map((c) => Math.sign(Math.round(c * 10))).join(",");
            return [key, body.faceIdAt(index)];
        }),
    );
}

/** The sketch-scoped seed of `sketch`'s only profile — what a cap on it is named. */
function sectionSeed(sketch: SketchNode): string {
    const profiles = resolveProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    return `sketch:${sketch.id}:${profiles.value[0].seed}`;
}

describe("loft feature (real kernel)", () => {
    test("lofts two squares into a closed frustum", () => {
        const { body } = setup([
            { z: 0, data: square(20) },
            { z: 10, data: square(10) },
        ]);

        expect(body.shape.isOk).toBe(true);
        const shape = body.shape.value;
        expect(shape.shapeType).toBe(ShapeTypes.solid);
        expect(facesOf(body)).toHaveLength(6);
        // Frustum of a square pyramid: h/3 (A1 + A2 + sqrt(A1 A2)).
        expect(shape.volume()).toBeCloseTo((10 / 3) * (400 + 100 + 200), 3);
    });

    test("an open loft is a shell without caps", () => {
        const { body } = setup(
            [
                { z: 0, data: square(20) },
                { z: 10, data: square(10) },
            ],
            { solid: false },
        );

        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.shapeType).not.toBe(ShapeTypes.solid);
        expect(facesOf(body)).toHaveLength(4);
    });

    test("lofts a square into a circle through three sections", () => {
        const { body } = setup([
            { z: 0, data: square(20) },
            { z: 10, data: square(14) },
            { z: 20, data: circle(5) },
        ]);

        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.shapeType).toBe(ShapeTypes.solid);
        expect(body.shape.value.volume()).toBeGreaterThan(0);
    });

    test("caps take their section's seed and side faces their first section edge's", () => {
        const { sketches, body } = setup([
            { z: 0, data: square(20) },
            { z: 10, data: square(10) },
        ]);

        const ids = idsByNormal(body);
        expect(ids.size).toBe(6);
        expect(ids.get("0,0,-1")).toBe(sectionSeed(sketches[0]));
        expect(ids.get("0,0,1")).toBe(sectionSeed(sketches[1]));
        // Sides: seeded from the first section's entities (lines 1-4), one each.
        const sides = ["0,-1,1", "1,0,1", "0,1,1", "-1,0,1"].map((key) => ids.get(key));
        expect(sides).toEqual([1, 2, 3, 4].map((entity) => `${sectionSeed(sketches[0])}:ent${entity}`));
    });

    test("editing a section re-lofts and keeps every face id on the same face", () => {
        const { sketches, body } = setup([
            { z: 0, data: square(20) },
            { z: 10, data: square(10) },
        ]);
        const before = idsByNormal(body);
        const volume = body.shape.value.volume();

        sketches[1].setDataEmitShapeChanged(square(16));

        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(volume);
        expect(idsByNormal(body)).toEqual(before);
    });

    test.each([false, true])("circle-to-square face ids stay distinct across edits (ruled=%s)", (ruled) => {
        const { sketches, body } = setup(
            [
                { z: 0, data: circle(10) },
                { z: 10, data: square(10) },
            ],
            { ruled },
        );
        const checkIds = () => {
            expect(body.shape.isOk).toBe(true);
            const faces = facesOf(body);
            const ids = faces.map((_, index) => body.faceIdAt(index));
            expect(ids.every((id) => typeof id === "string")).toBe(true);
            expect(new Set(ids).size).toBe(faces.length);
            const caps = faces
                .map((face, index) => ({ face, id: ids[index] }))
                .filter(({ face }) => face.surface().isPlanar());
            expect(caps).toHaveLength(2);
            const bottom = caps.find(({ face }) => face.normal(0, 0)[1].z < 0);
            const top = caps.find(({ face }) => face.normal(0, 0)[1].z > 0);
            expect(bottom?.id).toBe(sectionSeed(sketches[0]));
            expect(top?.id).toBe(sectionSeed(sketches[1]));
            return ids;
        };
        const before = checkIds();

        sketches[0].setDataEmitShapeChanged(circle(12));

        expect(checkIds()).toEqual(before);
    });

    test("a picked profile selects one of several in its sketch", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        const two: SketchData = {
            entities: [
                { id: 1, type: "circle", params: [-20, 0, 5] },
                { id: 2, type: "circle", params: [20, 0, 5] },
            ],
            constraints: [],
        };
        const base = new SketchNode({ document: doc, plane: planeAt(0), data: two });
        const top = new SketchNode({ document: doc, plane: planeAt(10), data: circle(3) });
        doc.modelManager.addNode(base);
        doc.modelManager.addNode(top);
        const right = sketchProfiles(base).value.outer.find((face) => face.boundingBox().min.x > 0)!;
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "l1",
                    type: "loft",
                    sections: [
                        { sketchId: base.id, profile: captureProfileRef(right) },
                        { sketchId: top.id },
                    ],
                },
            ],
        });
        doc.modelManager.addNode(body);

        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.boundingBox().max.x).toBeCloseTo(25, 3);
    });

    test("a loft stored without a section list fails its feature instead of throwing", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        const body = new ParametricBodyNode({
            document: doc,
            featuresJson: JSON.stringify([{ id: "l1", type: "loft" }]),
        });
        doc.modelManager.addNode(body);

        expect(body.shape.isOk).toBe(false);
        expect(body.featureItems()[0].error).toContain("at least two sections");
    });

    test.each([
        ["one section", [{ z: 0, data: square(20) }], "at least two sections"],
        [
            "two sections on one plane",
            [
                { z: 0, data: square(20) },
                { z: 0, data: square(10) },
            ],
            "same plane",
        ],
        [
            "a sketch with two profiles and none picked",
            [
                {
                    z: 0,
                    data: {
                        entities: [
                            { id: 1, type: "circle", params: [-20, 0, 5] },
                            { id: 2, type: "circle", params: [20, 0, 5] },
                        ],
                        constraints: [],
                    } as SketchData,
                },
                { z: 10, data: circle(3) },
            ],
            "single profile",
        ],
        [
            "a section with a hole",
            [
                {
                    z: 0,
                    data: {
                        entities: [
                            { id: 1, type: "circle", params: [0, 0, 10] },
                            { id: 2, type: "circle", params: [0, 0, 5] },
                        ],
                        constraints: [],
                    } as SketchData,
                },
                { z: 10, data: circle(3) },
            ],
            "holes",
        ],
    ])("fails on %s", (_name, sections, message) => {
        const { body } = setup(sections);

        expect(body.shape.isOk).toBe(false);
        expect(body.featureItems()[0].error).toContain(message);
    });
});
