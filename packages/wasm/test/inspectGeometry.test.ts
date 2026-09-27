// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDisposable,
    type IEdge,
    type IFace,
    Line,
    Matrix4,
    Plane,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import {
    classifyMinimumRadius,
    edgeEndpointContinuity,
    evaluateSurfaceCurvature,
    sampleEdgeCurvature,
    signedDraftAngle,
} from "../../app/src/analysis/geometry";
import { OccCylindricalSurface } from "../src/surface";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    for (const value of owned.reverse()) value.dispose();
    owned = [];
});

describe("inspection analytic fixtures through the actual OCCT kernel", () => {
    test("line curvature is zero and samples include both trimmed endpoints", () => {
        const line = keep(unwrapOk(factory.line(new XYZ(2, 3, 4), new XYZ(12, 3, 4))));
        const samples = unwrapOk(sampleEdgeCurvature(line, 5));
        expect(samples).toHaveLength(5);
        expect(samples[0].point.distanceTo(new XYZ(2, 3, 4))).toBeLessThan(1e-8);
        expect(samples[4].point.distanceTo(new XYZ(12, 3, 4))).toBeLessThan(1e-8);
        for (const sample of samples) {
            expect(sample.status).toBe("ok");
            expect(sample.curvature).toBeCloseTo(0, 10);
        }
    });

    test("a reversed, translated and scaled quarter circle retains the expected curvature and trim", () => {
        const circle = keep(unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 5)));
        const quarter = circle.trim(0, Math.PI / 2);
        expect(quarter).not.toBeUndefined();
        if (!quarter) throw new Error("Expected quarter-circle trim");
        keep(quarter);
        const transformed = keep(quarter.transformed(Matrix4.fromScale(2, 2, 2))) as IEdge;
        transformed.reserve();
        const shifted = keep(transformed.transformedMul(Matrix4.fromTranslation(20, 30, 40))) as IEdge;
        const samples = unwrapOk(sampleEdgeCurvature(shifted, 9));
        for (const sample of samples) {
            expect(sample.curvature).toBeCloseTo(0.1, 8);
            expect(sample.point.z).toBeCloseTo(40, 8);
            expect(sample.point.x).toBeGreaterThanOrEqual(20 - 1e-8);
            expect(sample.point.y).toBeGreaterThanOrEqual(30 - 1e-8);
        }
        expect(samples[0].point.distanceTo(samples[8].point)).toBeCloseTo(Math.sqrt(200), 8);
    });

    test("quadratic Bezier curvature varies analytically along its parameter interval", () => {
        const edge = keep(unwrapOk(factory.bezier([new XYZ(-1, 1, 0), new XYZ(0, -1, 0), new XYZ(1, 1, 0)])));
        const samples = unwrapOk(sampleEdgeCurvature(edge, 3));
        expect(samples[0].curvature).toBeCloseTo(2 / 5 ** 1.5, 8);
        expect(samples[1].curvature).toBeCloseTo(2, 8);
        expect(samples[2].curvature).toBeCloseTo(samples[0].curvature, 8);
    });

    test("endpoint diagnostics distinguish a gap, corner, and straight continuation", () => {
        const a = keep(unwrapOk(factory.line(XYZ.zero, XYZ.unitX)));
        const gap = keep(unwrapOk(factory.line(new XYZ(2, 0, 0), new XYZ(3, 0, 0))));
        const corner = keep(unwrapOk(factory.line(XYZ.unitX, new XYZ(1, 1, 0))));
        const continuation = keep(unwrapOk(factory.line(XYZ.unitX, new XYZ(2, 0, 0))));
        expect(unwrapOk(edgeEndpointContinuity(a, gap))).toBe("gap");
        expect(unwrapOk(edgeEndpointContinuity(a, corner))).toBe("position");
        expect(unwrapOk(edgeEndpointContinuity(a, continuation))).toBe("curvature");
    });

    test("plane curvature is zero and a point outside the face is rejected", () => {
        const face = keep(unwrapOk(factory.rect(Plane.XY, 10, 20)));
        const sample = unwrapOk(evaluateSurfaceCurvature(face, 2, 3));
        expect(sample.kMin).toBeCloseTo(0, 10);
        expect(sample.kMax).toBeCloseTo(0, 10);
        expect(sample.gaussian).toBeCloseTo(0, 10);
        expect(evaluateSurfaceCurvature(face, 200, 300).isOk).toBe(false);
    });

    test("outward sphere is convex, with reciprocal-radius principal and squared Gaussian curvature", () => {
        const sphere = keep(unwrapOk(factory.sphere(XYZ.zero, 5)));
        const faces = sphere.findSubShapes(ShapeTypes.face).map((face) => keep(face) as IFace);
        expect(faces).toHaveLength(1);
        const sample = unwrapOk(evaluateSurfaceCurvature(faces[0], 1, 0));
        expect(sample.kMin).toBeCloseTo(0.2, 8);
        expect(sample.kMax).toBeCloseTo(0.2, 8);
        expect(sample.gaussian).toBeCloseTo(0.04, 8);
        expect(unwrapOk(classifyMinimumRadius(sample, 10))).toBe("pass");
        faces[0].reserve();
        const inward = unwrapOk(evaluateSurfaceCurvature(faces[0], 1, 0));
        expect(inward.kMin).toBeCloseTo(-0.2, 8);
        expect(unwrapOk(classifyMinimumRadius(inward, 10))).toBe("violation");
        expect(unwrapOk(classifyMinimumRadius(inward, 5))).toBe("pass");
        expect(unwrapOk(classifyMinimumRadius(inward, 4))).toBe("pass");
    });

    test("cylinder has one zero principal curvature and zero Gaussian curvature", () => {
        const cylinder = keep(unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 5, 20)));
        const faces = cylinder.findSubShapes(ShapeTypes.face).map((face) => keep(face) as IFace);
        const curved = faces.find((face) => {
            const surface = face.surface();
            try {
                return surface instanceof OccCylindricalSurface;
            } finally {
                surface.dispose();
            }
        });
        expect(curved).not.toBeUndefined();
        if (!curved) throw new Error("Expected cylindrical face");
        const sample = unwrapOk(evaluateSurfaceCurvature(curved, 1, 10));
        expect(sample.kMin).toBeCloseTo(0, 8);
        expect(sample.kMax).toBeCloseTo(0.2, 8);
        expect(sample.gaussian).toBeCloseTo(0, 8);
    });

    test.each([0, 1, 4097, NaN, 2.5])("invalid comb sample count %s fails explicitly", (count) => {
        const edge = keep(unwrapOk(factory.line(XYZ.zero, XYZ.unitX)));
        expect(sampleEdgeCurvature(edge, count).isOk).toBe(false);
    });
});

describe("draft angle conventions", () => {
    test.each([
        [XYZ.unitX, 0],
        [XYZ.unitZ, 90],
        [new XYZ(0, 0, -1), -90],
        [new XYZ(Math.sqrt(3), 0, 1), 30],
    ] as const)("normal %s has expected angle %s and reverses with pull", (normal, angle) => {
        expect(unwrapOk(signedDraftAngle(normal, XYZ.unitZ))).toBeCloseTo(angle, 8);
        expect(unwrapOk(signedDraftAngle(normal, new XYZ(0, 0, -1)))).toBeCloseTo(-angle, 8);
    });
    test.each([
        XYZ.zero,
        { x: NaN, y: 0, z: 1 },
        { x: Infinity, y: 0, z: 1 },
    ])("invalid normal is unknown: %s", (normal) => {
        expect(signedDraftAngle(normal, XYZ.unitZ).isOk).toBe(false);
    });
});

test("trimmed planar annulus excludes the hole from curvature evaluation", () => {
    const outerEdge = keep(unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 10)));
    const innerEdge = keep(unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 3)));
    const outer = keep(unwrapOk(factory.wire([outerEdge])));
    const inner = keep(unwrapOk(factory.wire([innerEdge])));
    inner.reserve();
    const face = keep(unwrapOk(factory.face([outer, inner])));
    expect(face.area()).toBeCloseTo(Math.PI * 91, 5);
    const surface = keep(face.surface());
    const within = surface.parameter(new XYZ(5, 0, 0), 1e-6);
    const hole = surface.parameter(XYZ.zero, 1e-6);
    expect(within).not.toBeUndefined();
    expect(hole).not.toBeUndefined();
    if (!within || !hole) throw new Error("Expected planar UV parameters");
    const valid = evaluateSurfaceCurvature(face, within.u, within.v);
    expect(valid.isOk).toBe(true);
    expect(valid.value.gaussian).toBeCloseTo(0, 10);
    const excluded = evaluateSurfaceCurvature(face, hole.u, hole.v);
    expect(excluded.isOk).toBe(false);
    expect(excluded.error).toContain("trimmed face");
});

test("equal curvature magnitudes on opposite sides of a shared tangent are not G2 continuous", () => {
    const leftCircle = keep(unwrapOk(factory.circle(XYZ.unitZ, new XYZ(-5, 0, 0), 5)));
    const rightCircle = keep(unwrapOk(factory.circle(XYZ.unitZ, new XYZ(5, 0, 0), 5)));
    const left = leftCircle.trim(0, Math.PI / 2);
    const right = rightCircle.trim(Math.PI / 2, Math.PI);
    expect(left).not.toBeUndefined();
    expect(right).not.toBeUndefined();
    if (!left || !right) throw new Error("Expected quarter-circle trims");
    keep(left);
    keep(right);
    expect(unwrapOk(edgeEndpointContinuity(left, right))).toBe("tangent");
});

test("native forward ray query chooses the forward sphere hit when another hit is behind", () => {
    const sphere = keep(unwrapOk(factory.sphere(XYZ.zero, 5)));
    const face = keep(sphere.findSubShapes(ShapeTypes.face)[0]) as IFace;
    expect(face.inspectionRayHit).toBeTypeOf("function");
    const hit = face.inspectionRayHit?.(XYZ.zero, XYZ.unitX, 1e-6, 100);
    expect(hit?.isOk).toBe(true);
    expect(hit?.value).not.toBeUndefined();
    if (!hit?.isOk || !hit.value) throw new Error("Expected sphere exit intersection");
    expect(hit.value.distanceTo(new XYZ(5, 0, 0))).toBeLessThan(1e-7);
    const miss = face.inspectionRayHit?.(new XYZ(10, 0, 0), XYZ.unitX, 1e-6, 100);
    expect(miss?.isOk).toBe(true);
    expect(miss?.value).toBeUndefined();
    expect(face.inspectionRayHit?.(XYZ.zero, XYZ.zero, 1e-6, 100).isOk).toBe(false);
});

test("native UV bounds use the finite trimmed face domain", () => {
    const face = keep(unwrapOk(factory.rect(Plane.XY, 10, 20)));
    expect(face.inspectionUVBounds).toBeTypeOf("function");
    const bounds = face.inspectionUVBounds?.();
    expect(bounds?.isOk).toBe(true);
    if (!bounds?.isOk) throw new Error("Expected native face bounds");
    expect(bounds.value.u2 - bounds.value.u1).toBeCloseTo(10, 8);
    expect(bounds.value.v2 - bounds.value.v1).toBeCloseTo(20, 8);
});

test("native section cap of a box lies on the cut plane with the analytic area", () => {
    const box = keep(unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    expect(box.inspectionSectionCaps).toBeTypeOf("function");
    const result = box.inspectionSectionCaps?.(
        new Plane({ origin: new XYZ(0, 0, 15), normal: XYZ.unitZ, xvec: XYZ.unitX }),
    );
    expect(result?.isOk).toBe(true);
    if (!result?.isOk) throw new Error("Expected box cap");
    const cap = keep(result.value);
    const faces = cap.findSubShapes(ShapeTypes.face).map((face) => keep(face) as IFace);
    expect(faces).toHaveLength(1);
    expect(faces.reduce((sum, face) => sum + face.area(), 0)).toBeCloseTo(200, 6);
    const points = cap.mesh.faces?.position;
    expect(points?.length).toBeGreaterThan(6);
    if (!points) throw new Error("Expected cap triangles");
    for (let i = 2; i < points.length; i += 3) expect(points[i]).toBeCloseTo(15, 5);
});

test("hollow-cylinder section cap preserves its cavity and annular area", () => {
    const outer = keep(unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20)));
    const inner = keep(unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 4, 20)));
    const tube = keep(unwrapOk(factory.booleanCut([outer], [inner])));
    const result = tube.inspectionSectionCaps?.(
        new Plane({ origin: new XYZ(0, 0, 10), normal: XYZ.unitZ, xvec: XYZ.unitX }),
    );
    expect(result?.isOk).toBe(true);
    if (!result?.isOk) throw new Error("Expected tube cap");
    const cap = keep(result.value);
    const faces = cap.findSubShapes(ShapeTypes.face).map((face) => keep(face) as IFace);
    expect(faces).toHaveLength(1);
    expect(faces[0].area()).toBeCloseTo(Math.PI * 84, 5);
    expect(faces[0].containsPoint(new XYZ(0, 0, 10), true, 1e-6)).toBe(false);
    expect(faces[0].containsPoint(new XYZ(7, 0, 10), true, 1e-6)).toBe(true);
    const mesh = cap.mesh.faces;
    expect(mesh).not.toBeUndefined();
    if (!mesh) throw new Error("Expected annular cap mesh");
    for (let i = 0; i < mesh.index.length; i += 3) {
        const indices = [mesh.index[i], mesh.index[i + 1], mesh.index[i + 2]];
        const x = indices.reduce((sum, index) => sum + mesh.position[index * 3], 0) / 3;
        const y = indices.reduce((sum, index) => sum + mesh.position[index * 3 + 1], 0) / 3;
        expect(Math.hypot(x, y)).toBeGreaterThan(3.9);
    }
});

test("section cap query rejects open faces", () => {
    const face = keep(unwrapOk(factory.rect(Plane.XY, 10, 20)));
    expect(face.inspectionSectionCaps?.(Plane.XY).isOk).toBe(false);
});

test("torus inner wall is an analytic saddle with negative Gaussian curvature", () => {
    const circle = keep(unwrapOk(factory.circle(XYZ.unitY, new XYZ(5, 0, 0), 2)));
    const torus = keep(
        unwrapOk(factory.revolve(circle, new Line({ point: XYZ.zero, direction: XYZ.unitZ }), 360)),
    );
    const faces = torus.findSubShapes(ShapeTypes.face).map((face) => keep(face) as IFace);
    expect(faces).toHaveLength(1);
    const surface = keep(faces[0].surface());
    const uv = surface.parameter(new XYZ(3, 0, 0), 1e-6);
    expect(uv).not.toBeUndefined();
    if (!uv) throw new Error("Expected inner torus UV");
    const sample = unwrapOk(evaluateSurfaceCurvature(faces[0], uv.u, uv.v));
    expect(sample.gaussian).toBeCloseTo(-1 / 6, 7);
    expect(sample.kMin * sample.kMax).toBeCloseTo(-1 / 6, 7);
    expect(Math.abs(sample.kMin)).toBeGreaterThan(0.3);
    expect(Math.abs(sample.kMax)).toBeGreaterThan(0.3);
});
