// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, Result, ucsLocalToWorld, ucsWorldToLocal, XYZ } from "../src";
import { evaluateConstruction } from "../src/construction/evaluate";
import type {
    ConstructionDefinition,
    ConstructionGeometry,
    ConstructionRef,
    IConstructionResolver,
} from "../src/construction/types";

const xyz = (x = 0, y = 0, z = 0) => new XYZ({ x, y, z });
const point = (x = 0, y = 0, z = 0): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "point", point: xyz(x, y, z) },
});
const axis = (origin = XYZ.zero, direction = XYZ.unitX): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "axis", origin, direction },
});
const plane = (value = Plane.XY): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "plane", plane: value },
});
const resolver: IConstructionResolver = {
    resolve(ref) {
        return ref.kind === "fixed" ? Result.ok(ref.geometry) : Result.err("Missing construction source");
    },
};

function evaluate<K extends ConstructionGeometry["kind"]>(definition: ConstructionDefinition, kind: K) {
    const result = evaluateConstruction(definition, resolver);
    expect(result.isOk, result.isOk ? undefined : String(result.error)).toBe(true);
    const geometry = result.unchecked()!;
    expect(geometry.kind).toBe(kind);
    return geometry as Extract<ConstructionGeometry, { kind: K }>;
}

function expectXYZ(actual: XYZ, expected: XYZ) {
    expect(actual.x).toBeCloseTo(expected.x, 7);
    expect(actual.y).toBeCloseTo(expected.y, 7);
    expect(actual.z).toBeCloseTo(expected.z, 7);
}

function rejects(definition: ConstructionDefinition) {
    const result = evaluateConstruction(definition, resolver);
    expect(result.isOk).toBe(false);
    expect(String(result.error).length).toBeGreaterThan(0);
}

describe("construction planes", () => {
    test.each([-12, 0, 23])("offset %s preserves the source normal", (distance) => {
        const result = evaluate({ kind: "plane-offset", source: plane(), distance }, "plane");
        expectXYZ(result.plane.origin, xyz(0, 0, distance));
        expectXYZ(result.plane.normal, XYZ.unitZ);
    });

    test("To Object offset projects onto the source normal", () => {
        const result = evaluate(
            { kind: "plane-offset", source: plane(), distance: 0, toPoint: point(8, 9, 17) },
            "plane",
        );
        expectXYZ(result.plane.origin, xyz(0, 0, 17));
    });

    test("parallel midplanes are halfway even for opposing source normals", () => {
        const opposite = new Plane({ origin: xyz(0, 0, 10), normal: XYZ.unitNZ, xvec: XYZ.unitX });
        const result = evaluate({ kind: "plane-midplane", first: plane(), second: plane(opposite) }, "plane");
        expect(result.plane.origin.z).toBeCloseTo(5);
        expect(Math.abs(result.plane.normal.dot(XYZ.unitZ))).toBeCloseTo(1);
    });

    test.each([0, 1] as const)("intersecting midplane solution %s is an angle bisector", (solution) => {
        const result = evaluate(
            { kind: "plane-midplane", first: plane(), second: plane(Plane.YZ), solution },
            "plane",
        );
        expect(Math.abs(result.plane.normal.dot(XYZ.unitZ))).toBeCloseTo(Math.SQRT1_2);
        expect(Math.abs(result.plane.normal.dot(XYZ.unitX))).toBeCloseTo(Math.SQRT1_2);
        expect(result.plane.normal.dot(result.plane.origin)).toBeCloseTo(0);
    });

    test("angle plane rotates the stored baseline about its axis then applies normal offset", () => {
        const result = evaluate(
            { kind: "plane-angle", axis: axis(), baseline: plane(), angle: 30, offset: 4 },
            "plane",
        );
        expect(result.plane.normal.dot(XYZ.unitZ)).toBeCloseTo(Math.cos(Math.PI / 6));
        expect(result.plane.normal.dot(XYZ.unitX)).toBeCloseTo(0);
        expect(result.plane.origin.dot(result.plane.normal)).toBeCloseTo(4);
    });

    test.each([
        [axis(), axis(xyz(0, 2, 0), XYZ.unitX)],
        [axis(), axis(XYZ.zero, XYZ.unitY)],
    ])("two coplanar lines define the plane", (first, second) => {
        const result = evaluate({ kind: "plane-two-edges", first, second }, "plane");
        expect(Math.abs(result.plane.normal.z)).toBeCloseTo(1);
        expect(result.plane.origin.z).toBeCloseTo(0);
    });

    test("three points define a containing plane before its offset", () => {
        const result = evaluate(
            {
                kind: "plane-three-points",
                first: point(2, 0, 3),
                second: point(5, 0, 3),
                third: point(2, 6, 3),
                offset: 2,
            },
            "plane",
        );
        expectXYZ(result.plane.normal, XYZ.unitZ);
        expect(result.plane.origin.z).toBeCloseTo(5);
    });

    test("perpendicular plane uses its orientation reference", () => {
        const result = evaluate(
            {
                kind: "plane-perpendicular",
                source: plane(),
                contact: point(1, 2, 0),
                orientation: axis(XYZ.zero, XYZ.unitX),
            },
            "plane",
        );
        expect(result.plane.normal.dot(XYZ.unitZ)).toBeCloseTo(0);
        expectXYZ(result.plane.origin, xyz(1, 2, 0));
    });
});

describe("construction axes and points", () => {
    test("two point axis has unit direction and infinite mathematical extent", () => {
        const result = evaluate(
            { kind: "axis-two-points", first: point(1, 2, 3), second: point(1, 2, 5) },
            "axis",
        );
        expectXYZ(result.origin, xyz(1, 2, 3));
        expectXYZ(result.direction, XYZ.unitZ);
    });

    test("axis through two planes lies on both planes", () => {
        const result = evaluate(
            {
                kind: "axis-two-planes",
                first: plane(Plane.XY.translateTo(xyz(0, 0, 3))),
                second: plane(Plane.YZ.translateTo(xyz(7, 0, 0))),
            },
            "axis",
        );
        expect(result.origin.x).toBeCloseTo(7);
        expect(result.origin.z).toBeCloseTo(3);
        expect(Math.abs(result.direction.y)).toBeCloseTo(1);
    });

    test("normal axis passes through the selected point", () => {
        const result = evaluate({ kind: "axis-normal", source: plane(), contact: point(3, 4, 0) }, "axis");
        expectXYZ(result.origin, xyz(3, 4, 0));
        expectXYZ(result.direction, XYZ.unitZ);
    });

    test("point at vertex retains the resolved position", () => {
        expectXYZ(evaluate({ kind: "point-vertex", vertex: point(3, 4, 5) }, "point").point, xyz(3, 4, 5));
    });

    test("line intersection uses extensions", () => {
        const result = evaluate(
            { kind: "point-two-edges", first: axis(), second: axis(xyz(100, 3, 0), XYZ.unitY) },
            "point",
        );
        expectXYZ(result.point, xyz(100, 0, 0));
    });

    test("three plane point solves the simultaneous plane equations", () => {
        const result = evaluate(
            {
                kind: "point-three-planes",
                first: plane(Plane.XY.translateTo(xyz(0, 0, 3))),
                second: plane(Plane.YZ.translateTo(xyz(1, 0, 0))),
                third: plane(Plane.ZX.translateTo(xyz(0, 2, 0))),
            },
            "point",
        );
        expectXYZ(result.point, xyz(1, 2, 3));
    });

    test("line plane intersection extends the line in either direction", () => {
        const result = evaluate(
            { kind: "point-edge-plane", edge: axis(xyz(3, 4, 50), XYZ.unitZ), plane: plane() },
            "point",
        );
        expectXYZ(result.point, xyz(3, 4, 0));
    });

    test("path axis accepts signed geometric distances", () => {
        const result = evaluate(
            {
                kind: "point-along-path",
                path: axis(xyz(3, 4, 5), XYZ.unitY),
                position: { kind: "distance", value: -20 },
            },
            "point",
        );
        expectXYZ(result.point, xyz(3, -16, 5));
    });
});

describe("construction UCS", () => {
    test("exported local/world conversions round trip an oblique translated frame", () => {
        const frame = evaluate(
            {
                kind: "ucs",
                origin: point(100, -200, 300),
                first: axis(XYZ.zero, xyz(1, 1, 0)),
                second: axis(XYZ.zero, xyz(-1, 1, 1)),
            },
            "ucs",
        );
        const local = xyz(13, -17, 23);
        const world = ucsLocalToWorld(frame, local);
        expectXYZ(ucsWorldToLocal(frame, world), local);
        expectXYZ(ucsLocalToWorld(frame, XYZ.zero), frame.origin);
        expectXYZ(ucsWorldToLocal(frame, frame.origin.add(frame.z.multiply(8))), xyz(0, 0, 8));
    });

    test.each([
        ["X", "Y"],
        ["Y", "Z"],
        ["Z", "X"],
    ] as const)("assigns %s/%s and orthogonalizes to a right handed basis", (firstAxis, secondAxis) => {
        const result = evaluate(
            {
                kind: "ucs",
                origin: point(1, 2, 3),
                first: axis(XYZ.zero, xyz(2, 0, 0)),
                second: axis(XYZ.zero, xyz(1, 3, 0)),
                firstAxis,
                secondAxis,
            },
            "ucs",
        );
        expectXYZ(result.origin, xyz(1, 2, 3));
        expectXYZ(result[firstAxis.toLowerCase() as "x" | "y" | "z"], XYZ.unitX);
        expect(result.x.length()).toBeCloseTo(1);
        expect(result.y.length()).toBeCloseTo(1);
        expect(result.z.length()).toBeCloseTo(1);
        expect(result.x.dot(result.y)).toBeCloseTo(0);
        expectXYZ(result.x.cross(result.y), result.z);
        const local = xyz(8, -5, 13);
        const world = result.origin
            .add(result.x.multiply(local.x))
            .add(result.y.multiply(local.y))
            .add(result.z.multiply(local.z));
        const relative = world.sub(result.origin);
        expectXYZ(xyz(relative.dot(result.x), relative.dot(result.y), relative.dot(result.z)), local);
    });

    test("axis reversal is explicit and preserves handedness", () => {
        const result = evaluate(
            {
                kind: "ucs",
                origin: point(),
                first: axis(),
                second: axis(XYZ.zero, XYZ.unitY),
                reverseFirst: true,
            },
            "ucs",
        );
        expectXYZ(result.x, XYZ.unitNX);
        expectXYZ(result.x.cross(result.y), result.z);
    });
});

describe("construction validation", () => {
    const invalid: ConstructionDefinition[] = [
        { kind: "axis-two-points", first: point(), second: point() },
        { kind: "axis-two-planes", first: plane(), second: plane() },
        { kind: "plane-two-edges", first: axis(), second: axis() },
        { kind: "plane-two-edges", first: axis(), second: axis(xyz(0, 0, 1), XYZ.unitY) },
        { kind: "plane-three-points", first: point(), second: point(1), third: point(2) },
        { kind: "plane-three-points", first: point(), second: point(), third: point(0, 1) },
        { kind: "point-two-edges", first: axis(), second: axis(xyz(0, 1), XYZ.unitX) },
        { kind: "point-two-edges", first: axis(), second: axis() },
        { kind: "point-two-edges", first: axis(), second: axis(xyz(0, 0, 1), XYZ.unitY) },
        { kind: "point-edge-plane", edge: axis(), plane: plane() },
        { kind: "point-edge-plane", edge: axis(xyz(0, 0, 1)), plane: plane() },
        { kind: "point-three-planes", first: plane(), second: plane(), third: plane(Plane.YZ) },
        { kind: "ucs", origin: point(), first: axis(), second: axis() },
        { kind: "ucs", origin: point(), first: axis(XYZ.zero, XYZ.zero), second: axis(XYZ.zero, XYZ.unitY) },
        { kind: "plane-offset", source: plane(), distance: Number.NaN },
        { kind: "plane-angle", axis: axis(), baseline: plane(), angle: Number.POSITIVE_INFINITY },
        { kind: "plane-angle", axis: axis(xyz(0, 0, 5)), baseline: plane(), angle: 30 },
    ];
    test.each(invalid)("rejects degenerate $kind", (definition) => rejects(definition));

    test("missing resolver sources propagate as errors", () => {
        rejects({ kind: "plane-offset", source: { kind: "datum", nodeId: "deleted" }, distance: 5 });
    });
});
