// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ } from "@spicy3d/core";
import type { ShapeFactory } from "../src/factory";
import { createBox, createTestFactory, firstFace, unwrapOk } from "./helpers";
import "./setup";

// `boundingBox()` is the exact kernel box (BRepBndLib::AddOptimal), not the display mesh's
// min/max: no inset from mesh chords on curved geometry, no pole hull on splines.
let factory: ShapeFactory;

beforeEach(() => {
    factory = createTestFactory();
});

describe("OccShape.boundingBox", () => {
    test("a Bezier edge is boxed by the curve, not by its control polygon", () => {
        // The middle pole sits at y = 20; the curve peaks at y = 10 (t = 0.5).
        const edge = unwrapOk(factory.bezier([XYZ.zero, new XYZ(5, 20, 0), new XYZ(10, 0, 0)]));
        const box = edge.boundingBox();
        expect(box.min.x).toBeCloseTo(0, 6);
        expect(box.max.x).toBeCloseTo(10, 6);
        expect(box.min.y).toBeCloseTo(0, 6);
        expect(box.max.y).toBeCloseTo(10, 6);
    });

    test("a cylinder is boxed to its full radius", () => {
        const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 5));
        const box = cylinder.boundingBox();
        expect(box.min.z).toBeCloseTo(0, 6);
        expect(box.max.z).toBeCloseTo(5, 6);
        for (const value of [box.min.x, box.min.y]) expect(value).toBeCloseTo(-10, 6);
        for (const value of [box.max.x, box.max.y]) expect(value).toBeCloseTo(10, 6);
    });

    test("a planar face is boxed exactly, without the shape tolerance", () => {
        const face = firstFace(createBox(factory));
        const box = face.boundingBox();
        const extents = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].sort(
            (a, b) => a - b,
        );
        expect(extents[0]).toBeCloseTo(0, 9);
    });
});
