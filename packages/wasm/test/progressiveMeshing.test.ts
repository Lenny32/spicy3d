// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ } from "@spicy3d/core";
import type { OccSolid } from "../src/shape";
import { createSphere, createTestFactory } from "./helpers";
import "./setup";

test("coarse display tessellation remains separate from the canonical fine mesh", () => {
    const sphere = createSphere(createTestFactory(), XYZ.zero, 10) as OccSolid;
    const coarse = sphere.createCoarseDisplayMesh(0.05);
    expect(coarse).not.toBeUndefined();
    try {
        const coarseTriangles = coarse!.faces!.index.length;
        expect(coarseTriangles).toBeGreaterThan(0);
        expect(Reflect.get(sphere, "_mesh")).toBeUndefined();
        const fine = sphere.mesh;
        // The fixed angular tolerance can dominate both linear tolerances on analytic surfaces.
        expect(fine.faces!.index.length).toBeGreaterThanOrEqual(coarseTriangles);
        expect(fine.faces!.range.length).toBe(coarse!.faces!.range.length);
        coarse!.dispose();
        expect(sphere.mesh).toBe(fine);
        expect(fine.faces!.range[0].shape.geometryBoundingBox().max.z).toBeCloseTo(10, 5);
        expect(sphere.createCoarseDisplayMesh(0.05)).toBeUndefined();
    } finally {
        coarse?.dispose();
        sphere.dispose();
    }
});
