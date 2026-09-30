// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { OccShapeConverter } from "../src/converter";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });
function inputs() {
    const factory = createTestFactory();
    const cylinder = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const faces = cylinder.findSubShapes(ShapeTypes.face) as IFace[];
    const support = faces.find((face) => !face.surface().isPlanar());
    expect(support).not.toBeUndefined();
    if (!support) throw new Error("Cylinder has no curved support face");
    const path = unwrapOk(factory.wire([unwrapOk(factory.arc(XYZ.unitZ, p(0, 0, 5), p(10, 0, 5), 90))]));
    const corners = [p(9, 0, 4), p(11, 0, 4), p(11, 0, 6), p(9, 0, 6)];
    const section = unwrapOk(
        factory.wire(corners.map((start, index) => unwrapOk(factory.line(start, corners[(index + 1) % 4])))),
    );
    return { factory, cylinder, support, path, section };
}
describe("support-normal face sweep (real native kernel)", () => {
    test("deep-copy face and edge maps name every original through native history", () => {
        const { factory, cylinder } = inputs();
        const converter = new OccShapeConverter();
        const before = converter.convertToBrep(cylinder).value;
        const copied = unwrapOk(factory.copyTracked(cylinder));
        expect(copied.shape.isSame(cylinder)).toBe(false);
        expect(copied.shape.volume()).toBeCloseTo(cylinder.volume(), 5);
        const faces = cylinder.findSubShapes(ShapeTypes.face);
        const edges = cylinder.findSubShapes(ShapeTypes.edge);
        expect([...copied.faceMap].sort()).toEqual(faces.map((_, index) => index));
        expect([...copied.edgeMap].sort()).toEqual(edges.map((_, index) => index));
        expect(copied.faceAncestors).toHaveLength(2 * faces.length);
        expect(copied.edgeAncestors).toHaveLength(2 * edges.length);
        expect(converter.convertToBrep(cylinder).value).toBe(before);
        copied.shape.dispose();
    });
    test.each([
        "join",
        "cut",
    ] as const)("a curved-wall %s uses a real Darboux frame and valid boolean history", (operation) => {
        const { factory, cylinder, support, path, section } = inputs();
        const converter = new OccShapeConverter();
        const before = [cylinder, support, path, section].map(
            (shape) => converter.convertToBrep(shape).value,
        );
        const result = factory.faceSweepTracked(section, path, support, false);
        expect(result.isOk).toBe(true);
        expect(
            [cylinder, support, path, section].map((shape) => converter.convertToBrep(shape).value),
        ).toEqual(before);
        const swept = result.value;
        expect(swept.shape.checkShape()).toBe(true);
        expect(swept.shape.volume()).toBeCloseTo(20 * Math.PI, 3);
        expect(swept.pipeHistory?.faceEdges.length).toBeGreaterThan(0);
        const combined =
            operation === "join"
                ? factory.booleanFuseTracked([cylinder], [swept.shape])
                : factory.booleanCutTracked([cylinder], [swept.shape]);
        expect(combined.isOk).toBe(true);
        expect(combined.value.shape.checkShape()).toBe(true);
        expect(
            Math.abs(combined.value.shape.volume() - (2000 + (operation === "join" ? 10.5 : -9.5)) * Math.PI),
        ).toBeLessThan(1e-3);
        expect(combined.value.faceAncestors?.length).toBeGreaterThan(0);
        expect(cylinder.volume()).toBeCloseTo(2000 * Math.PI, 5);
        expect(path.findSubShapes(ShapeTypes.edge)).toHaveLength(1);
    });
    test("a path on the infinite surface but beyond the trimmed wall is rejected", () => {
        const { factory, support } = inputs();
        const path = unwrapOk(factory.wire([unwrapOk(factory.line(p(10, 0, 19), p(10, 0, 25)))]));
        const section = unwrapOk(factory.circle(XYZ.unitZ, p(10, 0, 19), 1));
        const wire = unwrapOk(factory.wire([section]));
        const result = factory.faceSweepTracked(wire, path, support, false);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/whole path edge.*trimmed support/);
    });
    test("a geometrically nearby path cannot be projected silently onto the support", () => {
        const { factory, support } = inputs();
        const path = unwrapOk(factory.wire([unwrapOk(factory.line(p(10.2, 0, 2), p(10.2, 0, 10)))]));
        const section = unwrapOk(factory.wire([unwrapOk(factory.circle(XYZ.unitZ, p(10.2, 0, 2), 1))]));
        const result = factory.faceSweepTracked(section, path, support, false);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/inconsistent|trimmed support/);
    });
    test("an incorrectly authored section plane is rejected rather than rotated into place", () => {
        const { factory, path, support } = inputs();
        const section = unwrapOk(factory.wire([unwrapOk(factory.circle(Plane.XY.normal, p(10, 0, 5), 1))]));
        const result = factory.faceSweepTracked(section, path, support, false);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/perpendicular to its tangent/);
    });
    test("crossing a trimmed face hole fails full-span support coverage", () => {
        const factory = createTestFactory();
        const wire = (half: number) => {
            const corners = [p(-half, -half, 0), p(half, -half, 0), p(half, half, 0), p(-half, half, 0)];
            return unwrapOk(
                factory.wire(
                    corners.map((start, index) => unwrapOk(factory.line(start, corners[(index + 1) % 4]))),
                ),
            );
        };
        const face = unwrapOk(factory.face([wire(5), wire(1)]));
        expect(face.findSubShapes(ShapeTypes.wire)).toHaveLength(2);
        const path = unwrapOk(factory.wire([unwrapOk(factory.line(p(-3, 0, 0), p(3, 0, 0)))]));
        const section = unwrapOk(factory.wire([unwrapOk(factory.circle(XYZ.unitX, p(-3, 0, 0), 0.2))]));
        const result = factory.faceSweepTracked(section, path, face, false);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/whole path edge.*trimmed support/);
    });
});
