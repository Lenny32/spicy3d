// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CurveUtils, type ICircle, XYZ } from "../src";
import { createMockCurve } from "../test-utils";

describe("CurveUtils", () => {
    describe("isConic", () => {
        test("should return true when curve has axis", () => {
            const conic = createMockCurve({ overrides: { axis: XYZ.unitZ } });
            expect(CurveUtils.isConic(conic)).toBe(true);
        });

        test("should return false when curve has no axis", () => {
            const curve = createMockCurve();
            expect(CurveUtils.isConic(curve)).toBe(false);
        });

        test("should return false when axis is undefined", () => {
            const curve = createMockCurve({ overrides: { axis: undefined } });
            expect(CurveUtils.isConic(curve)).toBe(false);
        });
    });

    describe("isCircle", () => {
        test("should return true when curve has center and radius", () => {
            const circle = createMockCurve({
                overrides: {
                    curveType: "circle",
                    center: XYZ.zero,
                    radius: 5,
                },
            });
            expect(CurveUtils.isCircle(circle)).toBe(true);
        });

        test("should return false when curve has center but no radius", () => {
            const curve = createMockCurve({
                overrides: {
                    center: XYZ.zero,
                    radius: undefined,
                },
            });
            expect(CurveUtils.isCircle(curve)).toBe(false);
        });

        test("should return false when curve has radius but no center", () => {
            const curve = createMockCurve({
                overrides: {
                    radius: 5,
                    center: undefined,
                },
            });
            expect(CurveUtils.isCircle(curve)).toBe(false);
        });

        test("should return false when curve has neither center nor radius", () => {
            const curve = createMockCurve();
            expect(CurveUtils.isCircle(curve)).toBe(false);
        });
    });

    describe("isLine", () => {
        test("should return true when curve has direction", () => {
            const line = createMockCurve({ overrides: { direction: XYZ.unitX } });
            expect(CurveUtils.isLine(line)).toBe(true);
        });

        test("should return false when curve has no direction", () => {
            const curve = createMockCurve();
            expect(CurveUtils.isLine(curve)).toBe(false);
        });

        test("should return false when direction is undefined", () => {
            const curve = createMockCurve({ overrides: { direction: undefined } });
            expect(CurveUtils.isLine(curve)).toBe(false);
        });
    });

    describe("isTrimmed", () => {
        test("should return true when curve has basisCurve", () => {
            const trimmed = createMockCurve({
                overrides: {
                    curveType: "trimmedCurve",
                    basisCurve: createMockCurve(),
                },
            });
            expect(CurveUtils.isTrimmed(trimmed)).toBe(true);
        });

        test("should return false when curve has no basisCurve", () => {
            // shared mock has a default basisCurve, so explicitly clear it
            const curve = createMockCurve({ overrides: { basisCurve: undefined } });
            expect(CurveUtils.isTrimmed(curve)).toBe(false);
        });

        test("should return false when basisCurve is undefined", () => {
            const curve = createMockCurve({ overrides: { basisCurve: undefined } });
            expect(CurveUtils.isTrimmed(curve)).toBe(false);
        });
    });

    describe("tangentPoints", () => {
        function makeCircle(center: XYZ, radius: number, axis: XYZ): ICircle {
            return { center, radius, axis } as unknown as ICircle;
        }

        test("should return two tangent points for point outside circle", () => {
            const circle = makeCircle(XYZ.zero, 1, XYZ.unitZ);
            const point = new XYZ({ x: 2, y: 0, z: 0 });

            const result = CurveUtils.tangentPoints(circle, point);
            expect(result.length).toBe(2);

            for (const tp of result) {
                expect(tp.distanceTo(circle.center)).toBeCloseTo(1, 5);
            }

            expect(result[0].isEqualTo(result[1])).toBe(false);
        });

        test("should return correct tangent points for symmetric case", () => {
            const circle = makeCircle(XYZ.zero, 1, XYZ.unitZ);
            const point = new XYZ({ x: 2, y: 0, z: 0 });

            const result = CurveUtils.tangentPoints(circle, point);
            // alpha = acos(1/2) = π/3, cos(π/3)=0.5, sin(π/3)=√3/2≈0.866
            const yValues = result.map((p) => Math.abs(p.y)).sort();
            expect(yValues[0]).toBeCloseTo(0.866, 2);
            expect(yValues[1]).toBeCloseTo(0.866, 2);
        });

        test("should return empty array when point is inside circle", () => {
            const circle = makeCircle(XYZ.zero, 5, XYZ.unitZ);
            const point = new XYZ({ x: 1, y: 0, z: 0 });
            expect(CurveUtils.tangentPoints(circle, point).length).toBe(0);
        });

        test("should return empty array when point is on the circle", () => {
            const circle = makeCircle(XYZ.zero, 1, XYZ.unitZ);
            const point = new XYZ({ x: 1, y: 0, z: 0 });
            expect(CurveUtils.tangentPoints(circle, point).length).toBe(0);
        });

        test("should return empty array when point is not coplanar with circle", () => {
            const circle = makeCircle(XYZ.zero, 5, XYZ.unitZ);
            const point = new XYZ({ x: 10, y: 0, z: 5 });
            expect(CurveUtils.tangentPoints(circle, point).length).toBe(0);
        });

        test("should work with translated circle center", () => {
            const center = new XYZ({ x: 10, y: 10, z: 0 });
            const circle = makeCircle(center, 2, XYZ.unitZ);
            const point = new XYZ({ x: 15, y: 10, z: 0 });

            const result = CurveUtils.tangentPoints(circle, point);
            expect(result.length).toBe(2);
            for (const tp of result) {
                expect(tp.distanceTo(center)).toBeCloseTo(2, 5);
            }
        });
    });
});
