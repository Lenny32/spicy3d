// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();

test("from-face volume uses projected planar area for an oblique extrusion axis", () => {
    const profile = unwrapOk(factory.rect(Plane.XY, 4, 4));
    const start = unwrapOk(
        factory.rect(
            new Plane({
                origin: new XYZ({ x: -20, y: -20, z: 10 }),
                normal: XYZ.unitZ,
                xvec: XYZ.unitX,
            }),
            50,
            50,
        ),
    );
    try {
        const direction = new XYZ({ x: 1, y: 0, z: 1 }).normalize()!;
        const result = factory.prismFromTracked(profile, direction, start, 0, { kind: "distance", depth: 5 });
        expect(result.isOk).toBe(true);
        try {
            expect(Math.abs(result.value.shape.volume())).toBeCloseTo((16 * 5) / Math.sqrt(2), 4);
            expect(result.value.capFaces?.length).toBe(1);
        } finally {
            result.value.shape.dispose();
        }
    } finally {
        profile.dispose();
        start.dispose();
    }
});

test("from-face rejects a curved profile with an explicit planar-profile error", () => {
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const start = unwrapOk(factory.rect(Plane.XY, 20, 20));
    try {
        const curved = (cylinder.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => !face.surface().isPlanar(),
        );
        expect(curved).not.toBeUndefined();
        if (curved === undefined) throw new Error("Expected cylinder side face");
        const result = factory.prismFromTracked(curved, XYZ.unitX, start, 0, { kind: "distance", depth: 5 });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("requires a planar profile face");
    } finally {
        cylinder.dispose();
        start.dispose();
    }
});
