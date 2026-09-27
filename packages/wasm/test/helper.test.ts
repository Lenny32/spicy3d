// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Line, Matrix4, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import {
    convertFromContinuity,
    convertFromMatrix,
    convertToContinuity,
    convertToMatrix,
    fromAx23,
    fromPln,
    getActualShape,
    getCurveType,
    getJoinType,
    getOrientation,
    getShapeEnum,
    getShapeType,
    getSurfaceType,
    toAx1,
    toAx3,
    toDir,
    toPln,
    toPnt,
    toVec,
    toXYZ,
} from "../src/helper";
import { rawBox } from "./helpers";
import "./setup";

// ============================================================================
// Coordinate conversions
// ============================================================================

describe("helper — coordinate conversions", () => {
    test("toPnt and toXYZ roundtrip", () => {
        const pnt = toPnt({ x: 1, y: 2, z: 3 });
        const xyz = toXYZ(pnt);
        expect(xyz.x).toBe(1);
        expect(xyz.y).toBe(2);
        expect(xyz.z).toBe(3);
    });

    test("toDir and toXYZ roundtrip", () => {
        const dir = toDir({ x: 0, y: 0, z: 1 });
        const xyz = toXYZ(dir);
        expect(xyz.x).toBe(0);
        expect(xyz.y).toBe(0);
        expect(xyz.z).toBe(1);
    });

    test("toVec and toXYZ roundtrip", () => {
        const vec = toVec({ x: 3, y: 4, z: 0 });
        const xyz = toXYZ(vec);
        expect(xyz.x).toBe(3);
        expect(xyz.y).toBe(4);
        expect(xyz.z).toBe(0);
    });

    test("toXYZ handles XYZ input to toPnt roundtrip", () => {
        const xyz = new XYZ({ x: 5, y: 6, z: 7 });
        const pnt = toPnt(xyz);
        const back = toXYZ(pnt);
        expect(back.x).toBe(5);
        expect(back.y).toBe(6);
        expect(back.z).toBe(7);
    });
});

// ============================================================================
// Plane / Axis conversions
// ============================================================================

describe("helper — plane/axis conversions", () => {
    test("toAx3 and fromAx23 roundtrip", () => {
        const plane = new Plane({
            origin: new XYZ({ x: 1, y: 2, z: 3 }),
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
        });
        const ax3 = toAx3(plane);
        const back = fromAx23(ax3);
        expect(back.origin.x).toBeCloseTo(1);
        expect(back.origin.y).toBeCloseTo(2);
        expect(back.origin.z).toBeCloseTo(3);
        expect(back.normal.z).toBeCloseTo(1);
        expect(back.xvec.x).toBeCloseTo(1);
    });

    test("toPln and fromPln roundtrip", () => {
        const plane = new Plane({
            origin: new XYZ({ x: 5, y: 0, z: 0 }),
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
        });
        const pln = toPln(plane);
        const back = fromPln(pln);
        expect(back.origin.x).toBeCloseTo(5);
        expect(back.normal.z).toBeCloseTo(1);
        expect(back.xvec.x).toBeCloseTo(1);
    });

    test("toAx1 from Line preserves location", () => {
        const line = new Line({ point: new XYZ({ x: 1, y: 2, z: 3 }), direction: XYZ.unitX });
        const ax1 = toAx1(line);
        const loc = toXYZ(ax1.location());
        expect(loc.x).toBeCloseTo(1);
        expect(loc.y).toBeCloseTo(2);
        expect(loc.z).toBeCloseTo(3);
    });
});

// ============================================================================
// Matrix conversions
// ============================================================================

describe("helper — matrix conversions", () => {
    test("identity matrix roundtrip", () => {
        const matrix = Matrix4.identity();
        const trsf = convertFromMatrix(matrix);
        const back = convertToMatrix(trsf);
        const point = back.ofPoint(XYZ.zero);
        expect(point.x).toBeCloseTo(0);
        expect(point.y).toBeCloseTo(0);
        expect(point.z).toBeCloseTo(0);
    });

    test("translation matrix roundtrip", () => {
        const matrix = Matrix4.fromTranslation(10, 20, 30);
        const trsf = convertFromMatrix(matrix);
        const back = convertToMatrix(trsf);
        const translated = back.ofPoint(XYZ.zero);
        expect(translated.x).toBeCloseTo(10);
        expect(translated.y).toBeCloseTo(20);
        expect(translated.z).toBeCloseTo(30);
    });

    test("scaling matrix preserves axes", () => {
        const matrix = Matrix4.fromScale(2, 2, 2);
        const trsf = convertFromMatrix(matrix);
        const back = convertToMatrix(trsf);
        const scaled = back.ofPoint(XYZ.unitX);
        expect(scaled.x).toBeCloseTo(2);
        expect(scaled.y).toBeCloseTo(0);
        expect(scaled.z).toBeCloseTo(0);
    });
});

// ============================================================================
// Shape type conversions
// ============================================================================

describe("helper — shape type conversions", () => {
    test("getShapeType identifies solid", () => {
        const box = rawBox();
        expect(getShapeType(box)).toBe(ShapeTypes.solid);
    });

    test("getShapeType identifies edge", () => {
        const box = rawBox();
        const edges = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_EDGE);
        expect(getShapeType(edges[0])).toBe(ShapeTypes.edge);
    });

    test("getShapeType identifies face", () => {
        const box = rawBox();
        const faces = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
        expect(getShapeType(faces[0])).toBe(ShapeTypes.face);
    });

    test("getShapeType identifies wire", () => {
        const box = rawBox();
        const faces = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
        const wire = wasm.Face.outerWire(wasm.TopoDS.face(faces[0]));
        expect(getShapeType(wire)).toBe(ShapeTypes.wire);
    });

    test("getShapeType identifies vertex", () => {
        const box = rawBox();
        const verts = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_VERTEX);
        expect(getShapeType(verts[0])).toBe(ShapeTypes.vertex);
    });

    test.each([
        [ShapeTypes.compound, "TopAbs_COMPOUND"],
        [ShapeTypes.compoundSolid, "TopAbs_COMPSOLID"],
        [ShapeTypes.solid, "TopAbs_SOLID"],
        [ShapeTypes.shell, "TopAbs_SHELL"],
        [ShapeTypes.face, "TopAbs_FACE"],
        [ShapeTypes.wire, "TopAbs_WIRE"],
        [ShapeTypes.edge, "TopAbs_EDGE"],
        [ShapeTypes.vertex, "TopAbs_VERTEX"],
        [ShapeTypes.shape, "TopAbs_SHAPE"],
    ] as const)("getShapeEnum(%s) maps to %s", (shapeType, enumName) => {
        expect(getShapeEnum(shapeType)).toBe(wasm.TopAbs_ShapeEnum[enumName]);
    });

    test("getShapeEnum throws for unknown type", () => {
        expect(() => getShapeEnum(9999 as any)).toThrow("Unknown shape type");
    });

    test("getActualShape downcasts a box to a solid", () => {
        const box = rawBox();
        const actual = getActualShape(box);
        expect(actual.isNull()).toBe(false);
        expect(actual.shapeType()).toBe(wasm.TopAbs_ShapeEnum.TopAbs_SOLID);
    });
});

// ============================================================================
// Orientation
// ============================================================================

describe("helper — orientation", () => {
    test("getOrientation returns forward for new box", () => {
        const box = rawBox();
        expect(getOrientation(box)).toBe("forward");
    });

    test("getOrientation returns reversed after reverse()", () => {
        const box = rawBox();
        box.reverse();
        expect(getOrientation(box)).toBe("reversed");
    });
});

// ============================================================================
// Join type conversion
// ============================================================================

describe("helper — join type conversion", () => {
    test.each([
        ["arc", "GeomAbs_Arc"],
        ["intersection", "GeomAbs_Intersection"],
        ["tangent", "GeomAbs_Tangent"],
    ] as const)("maps join type %s to %s", (joinType, enumName) => {
        expect(getJoinType(joinType)).toBe(wasm.GeomAbs_JoinType[enumName]);
    });

    test("throws for unknown type", () => {
        expect(() => getJoinType("unknown" as any)).toThrow("Unknown join type");
    });
});

// ============================================================================
// Continuity conversions
// ============================================================================

describe("helper — continuity conversions", () => {
    test.each([
        "c0",
        "g1",
        "c1",
        "g2",
        "c2",
        "c3",
        "cn",
    ] as const)("continuity roundtrip: %s", (continuity) => {
        const wasmVal = convertFromContinuity(continuity);
        const back = convertToContinuity(wasmVal);
        expect(back).toBe(continuity);
    });

    test("convertFromContinuity throws for unknown", () => {
        expect(() => convertFromContinuity("unknown" as any)).toThrow();
    });

    test("convertToContinuity throws for unknown", () => {
        expect(() => convertToContinuity(-1 as any)).toThrow();
    });
});

// ============================================================================
// Curve type detection
// ============================================================================

describe("helper — curve type detection", () => {
    test("detects line curve type from box edge", () => {
        const box = rawBox();
        const edges = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_EDGE);
        const trimmedCurve = wasm.Edge.curve(wasm.TopoDS.edge(edges[0]));
        const basisCurve = trimmedCurve.get()?.basisCurve();
        expect(getCurveType(basisCurve?.get()!)).toBe("line");
    });

    test("detects circle curve type from circle edge", () => {
        const circleEdge = wasm.ShapeFactory.circle({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, 5).shape;
        const trimmedCurve = wasm.Edge.curve(wasm.TopoDS.edge(circleEdge));
        const basisCurve = trimmedCurve.get()!.basisCurve();
        expect(getCurveType(basisCurve.get()!)).toBe("circle");
    });
});

// ============================================================================
// Surface type detection
// ============================================================================

describe("helper — surface type detection", () => {
    test("detects plane surface type from box face", () => {
        const box = rawBox();
        const faces = wasm.Shape.findSubShapes(box, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
        const surface = wasm.Face.surface(wasm.TopoDS.face(faces[0]));
        expect(getSurfaceType(surface.get()!)).toBe("plane");
    });

    test("detects cylinder surface type", () => {
        const cyl = wasm.ShapeFactory.cylinder({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, 5, 10).shape;
        const faces = wasm.Shape.findSubShapes(cyl, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
        const surfaceTypes = faces.map((f: any) => {
            try {
                return getSurfaceType(wasm.Face.surface(wasm.TopoDS.face(f)).get()!);
            } catch {
                return null;
            }
        });
        expect(surfaceTypes).toContain("cylinder");
    });
});
