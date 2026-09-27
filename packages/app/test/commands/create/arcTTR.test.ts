// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterAll, beforeAll, describe, expect, test } from "@rstest/core";
import { type ICircle, type ICurve, type ILine, type IShape, ShapeTypes, XYZ } from "@spicy3d/core";
import { ArcNode } from "../../../src/bodys/arc";
import { ArcTTR } from "../../../src/commands/create/arcTTR";
import {
    basisCurveOf,
    computeTangentTangentRadiusArc,
    isTangentRadiusCurve,
    tangentCurvesPlane,
} from "../../../src/commands/create/arcUtils";
import {
    ensureGlobalStubApp,
    pointStepResult,
    seedStepDatas,
    shapeStepResult,
    wireCommand,
} from "../commandTestUtils";

function mockLine(point: XYZ, direction: XYZ): ILine {
    return {
        curveType: "line",
        direction,
        firstParameter: () => 0,
        value: () => point,
        nearestFromPoint: (p: XYZ) => {
            const d = direction.normalize()!;
            const projected = point.add(d.multiply(p.sub(point).dot(d)));
            return { point: projected, parameter: 0, distance: p.distanceTo(projected) };
        },
    } as unknown as ILine;
}

function mockCircle(center: XYZ, radius: number): ICircle {
    return {
        curveType: "circle",
        center,
        radius,
        axis: XYZ.unitZ,
    } as unknown as ICircle;
}

const X_AXIS = mockLine(XYZ.zero, XYZ.unitX);
const Y_AXIS = mockLine(XYZ.zero, XYZ.unitY);
/** Vertical line x = 10 in the XY plane. */
const LINE_X10 = mockLine(new XYZ({ x: 10, y: 0, z: 0 }), XYZ.unitY);

describe("computeTangentTangentRadiusArc", () => {
    test("should solve two offset lines and pick the solution nearest to the reference points", () => {
        const result = computeTangentTangentRadiusArc(
            X_AXIS,
            new XYZ({ x: 5, y: 0, z: 0 }),
            LINE_X10,
            new XYZ({ x: 10, y: 5, z: 0 }),
            3,
        );
        expect(result).not.toBeUndefined();
        expect(result!.center.isEqualTo(new XYZ({ x: 7, y: 3, z: 0 }), 1e-6)).toBe(true);
        expect(result!.start.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(result!.end.isEqualTo(new XYZ({ x: 10, y: 3, z: 0 }), 1e-6)).toBe(true);
        expect(result!.normal.isParallelTo(XYZ.unitZ)).toBe(true);
        expect(Math.abs(result!.angle - 90)).toBeLessThan(0.001);
    });

    test("should disambiguate the four solutions of two crossing lines by reference points", () => {
        const result = computeTangentTangentRadiusArc(
            X_AXIS,
            new XYZ({ x: 5, y: 0, z: 0 }),
            Y_AXIS,
            new XYZ({ x: 0, y: 5, z: 0 }),
            3,
        );
        expect(result).not.toBeUndefined();
        expect(result!.center.isEqualTo(new XYZ({ x: 3, y: 3, z: 0 }), 1e-6)).toBe(true);
    });

    test("should solve a line and a circle with external tangency", () => {
        const line = mockLine(new XYZ({ x: 0, y: 8, z: 0 }), XYZ.unitX);
        const circle = mockCircle(XYZ.zero, 5);
        const result = computeTangentTangentRadiusArc(
            line,
            new XYZ({ x: 0, y: 8, z: 0 }),
            circle,
            new XYZ({ x: 5, y: 0, z: 0 }),
            3,
        );
        expect(result).not.toBeUndefined();
        expect(Math.abs(result!.center.x - Math.sqrt(39))).toBeLessThan(0.001);
        expect(Math.abs(result!.center.y - 5)).toBeLessThan(0.001);
        // external tangency: |center - circleCenter| = circleRadius + arcRadius
        expect(Math.abs(result!.center.distanceTo(circle.center) - 8)).toBeLessThan(0.001);
        expect(Math.abs(result!.start.y - 8)).toBeLessThan(0.001);
    });

    test("should solve two circles", () => {
        const c1 = mockCircle(XYZ.zero, 5);
        const c2 = mockCircle(new XYZ({ x: 12, y: 0, z: 0 }), 3);
        const result = computeTangentTangentRadiusArc(
            c1,
            new XYZ({ x: 5, y: 3, z: 0 }),
            c2,
            new XYZ({ x: 9, y: 3, z: 0 }),
            2,
        );
        expect(result).not.toBeUndefined();
        expect(result!.center.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(result!.start.isEqualTo(new XYZ({ x: 5, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(Math.abs(Math.abs(result!.angle) - 180)).toBeLessThan(0.001);
    });

    test("should return undefined when the radius is too small to bridge two circles", () => {
        const c1 = mockCircle(XYZ.zero, 5);
        const c2 = mockCircle(new XYZ({ x: 12, y: 0, z: 0 }), 3);
        const result = computeTangentTangentRadiusArc(c1, XYZ.unitX, c2, XYZ.unitX, 0.5);
        expect(result).toBeUndefined();
    });

    test("should return undefined for non-coplanar lines", () => {
        const lifted = mockLine(new XYZ({ x: 0, y: 0, z: 5 }), XYZ.unitY);
        const result = computeTangentTangentRadiusArc(X_AXIS, XYZ.unitX, lifted, XYZ.unitY, 3);
        expect(result).toBeUndefined();
    });

    test("should return undefined for unsupported curve types", () => {
        const ellipse = { curveType: "ellipse", axis: XYZ.unitZ, center: XYZ.zero } as unknown as ICurve;
        const result = computeTangentTangentRadiusArc(ellipse, XYZ.unitX, X_AXIS, XYZ.unitX, 3);
        expect(result).toBeUndefined();
    });

    test("should return undefined for a near-zero radius", () => {
        const result = computeTangentTangentRadiusArc(X_AXIS, XYZ.unitX, Y_AXIS, XYZ.unitY, 1e-9);
        expect(result).toBeUndefined();
    });
});

describe("basisCurveOf / isTangentRadiusCurve", () => {
    test("should unwrap trimmed curves to their basis curve", () => {
        const trimmed = { basisCurve: X_AXIS } as unknown as ICurve;
        expect(basisCurveOf(trimmed)).toBe(X_AXIS);
    });

    test("should accept lines and circles, reject other curves", () => {
        expect(isTangentRadiusCurve(X_AXIS)).toBe(true);
        expect(isTangentRadiusCurve(mockCircle(XYZ.zero, 5))).toBe(true);
        expect(isTangentRadiusCurve({ basisCurve: X_AXIS } as unknown as ICurve)).toBe(true);
        const ellipse = { curveType: "ellipse", axis: XYZ.unitZ } as unknown as ICurve;
        expect(isTangentRadiusCurve(ellipse)).toBe(false);
    });
});

describe("tangentCurvesPlane", () => {
    test("should return the common plane of two coplanar lines", () => {
        const plane = tangentCurvesPlane(X_AXIS, LINE_X10, XYZ.zero, XYZ.unitX);
        expect(plane).not.toBeUndefined();
        expect(plane!.normal.isParallelTo(XYZ.unitZ)).toBe(true);
    });

    test("should return undefined for non-coplanar curves", () => {
        const lifted = mockLine(new XYZ({ x: 0, y: 0, z: 5 }), XYZ.unitY);
        expect(tangentCurvesPlane(X_AXIS, lifted, XYZ.zero, XYZ.unitX)).toBeUndefined();
    });
});

describe("ArcTTR command", () => {
    let restoreApp: () => void;
    beforeAll(() => {
        restoreApp = ensureGlobalStubApp();
    });
    afterAll(() => restoreApp());

    function edgeEntry(curve: ICurve, point: XYZ) {
        return {
            shape: {
                shapeType: ShapeTypes.edge,
                curve: { basisCurve: curve },
            } as Partial<IShape>,
            point,
        };
    }

    function ttrCommand(): ArcTTR {
        const cmd = new ArcTTR();
        wireCommand(cmd);
        seedStepDatas(cmd, [
            shapeStepResult([
                edgeEntry(X_AXIS, new XYZ({ x: 5, y: 0, z: 0 })),
                edgeEntry(LINE_X10, new XYZ({ x: 10, y: 5, z: 0 })),
            ]),
            pointStepResult({ point: new XYZ({ x: 7.5, y: 5.5, z: 0 }) }),
        ]);
        // Normally invoked by the LengthAtPlaneStep; initializes the tangent data.
        (cmd as any).getRadiusData();
        return cmd;
    }

    test("should have command metadata and two steps", () => {
        const data = (ArcTTR as any).prototype.data;
        expect(data.key).toBe("create.arcTTR");
        const cmd = new ArcTTR();
        expect((cmd as any).getSteps().length).toBe(2);
    });

    test("geometryNode should build an ArcNode tangent to both picked edges", () => {
        const cmd = ttrCommand();
        const node = (cmd as any).geometryNode();
        expect(node).toBeInstanceOf(ArcNode);
        expect(node.center.isEqualTo(new XYZ({ x: 7, y: 3, z: 0 }), 1e-6)).toBe(true);
        expect(node.start.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(Math.abs(node.angle - 90)).toBeLessThan(0.001);
    });

    test("getRadiusData should anchor midway between the pick points and expose the common plane", () => {
        const cmd = ttrCommand();
        const data = (cmd as any).getRadiusData();
        expect(data.point().isEqualTo(new XYZ({ x: 7.5, y: 2.5, z: 0 }), 1e-6)).toBe(true);
        expect(data.plane(undefined).normal.isParallelTo(XYZ.unitZ)).toBe(true);
    });

    test("validator should accept a solvable radius and reject unsolvable ones", () => {
        const cmd = ttrCommand();
        const data = (cmd as any).getRadiusData();
        expect(data.validator(new XYZ({ x: 7.5, y: 5.5, z: 0 }))).toBe(true);
        // radius 0 at the anchor
        expect(data.validator(new XYZ({ x: 7.5, y: 2.5, z: 0 }))).toBe(false);
    });

    test("preview should show the anchor, center, tangent points and the arc", () => {
        const cmd = ttrCommand();
        const data = (cmd as any).getRadiusData();
        expect(data.preview(undefined)).toHaveLength(1);
        // anchor + center + two tangent points + arc mesh
        expect(data.preview(new XYZ({ x: 7.5, y: 5.5, z: 0 }))).toHaveLength(5);
    });
});
