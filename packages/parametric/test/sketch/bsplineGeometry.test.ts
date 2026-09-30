// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import fc from "fast-check";
import {
    type BSplineCurve2d,
    type BSplineParametrization,
    type BSplinePoint,
    bsplineBezierSegments,
    bsplineDistance,
    bsplineFitParams,
    bsplineParameters,
    bsplinePointAt,
    bsplineSpans,
    closestBSplineParameter,
    evaluateBSpline,
    interpolateBSpline,
    sampleBSpline,
} from "../../src/sketch/bsplineGeometry";

const PARAMETRIZATIONS: BSplineParametrization[] = ["chord", "centripetal", "uniform"];

/** An open polyline walk: consecutive points 0.5..20 apart, never closing on itself. */
const openPoints = fc
    .array(
        fc.tuple(
            fc.double({ min: 0.5, max: 20, noNaN: true }),
            fc.double({ min: -2.5, max: 2.5, noNaN: true }),
        ),
        {
            minLength: 1,
            maxLength: 11,
        },
    )
    .map((steps) => {
        const points: BSplinePoint[] = [[0, 0]];
        let heading = 0;
        for (const [length, turn] of steps) {
            heading += turn;
            const [x, y] = points[points.length - 1];
            points.push([x + length * Math.cos(heading), y + length * Math.sin(heading)]);
        }
        return points;
    })
    .filter(
        (points) => Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) > 1e-3,
    );

/** A star-shaped closed outline: increasing angles, radii 5..40. */
const closedPoints = fc
    .array(
        fc.tuple(fc.double({ min: 0.05, max: 1, noNaN: true }), fc.double({ min: 5, max: 40, noNaN: true })),
        {
            minLength: 3,
            maxLength: 12,
        },
    )
    .map((steps) => {
        const total = steps.reduce((sum, [step]) => sum + step, 0);
        let angle = 0;
        return steps.map(([step, radius]) => {
            const point: BSplinePoint = [radius * Math.cos(angle), radius * Math.sin(angle)];
            angle += (step / total) * Math.PI * 2;
            return point;
        });
    });

function curveOf(points: BSplinePoint[], parametrization: BSplineParametrization, periodic = false) {
    const curve = interpolateBSpline(points, { parametrization, periodic });
    expect(curve.isOk).toBe(true);
    return curve.value;
}

function gap(a: readonly number[], b: readonly number[]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Derivatives of a Bezier segment at its start (`end` false) or end, over a span of length h. */
function bezierEndDerivatives(segment: BSplinePoint[], h: number, end: boolean): BSplinePoint[] {
    const p = segment.length - 1;
    const b = end ? [...segment].reverse() : segment;
    const sign = end ? -1 : 1;
    const d1: BSplinePoint = [0, 1].map((a) => (sign * p * (b[1][a] - b[0][a])) / h) as BSplinePoint;
    const d2: BSplinePoint =
        p < 2
            ? [0, 0]
            : ([0, 1].map(
                  (a) => (p * (p - 1) * (b[2][a] - 2 * b[1][a] + b[0][a])) / (h * h),
              ) as BSplinePoint);
    return [b[0], d1, d2];
}

/** Enclosed area of a closed polyline (shoelace). */
function polygonArea(points: BSplinePoint[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
}

describe("interpolation", () => {
    test.each(
        PARAMETRIZATIONS,
    )("an open curve (%s) passes through every fit point, ends on the first and last", (parametrization) => {
        fc.assert(
            fc.property(openPoints, (points) => {
                const curve = curveOf(points, parametrization);
                expect(curve.poles).toHaveLength(points.length);
                expect(curve.degree).toBe(Math.min(3, points.length - 1));
                for (const [i, point] of points.entries()) {
                    expect(gap(bsplinePointAt(curve, curve.parameters[i]), point)).toBeLessThan(1e-9);
                }
                expect(gap(curve.poles[0], points[0])).toBeLessThan(1e-9);
                expect(gap(curve.poles.at(-1)!, points.at(-1)!)).toBeLessThan(1e-9);
            }),
        );
    });

    test.each(
        PARAMETRIZATIONS,
    )("a periodic curve (%s) passes through every fit point and closes with C2 (C1 at degree 2)", (parametrization) => {
        fc.assert(
            fc.property(closedPoints, (points) => {
                const curve = curveOf(points, parametrization, true);
                expect(curve.periodic).toBe(true);
                expect(curve.poles).toHaveLength(points.length);
                expect(curve.knots).toHaveLength(points.length + 1);
                for (const [i, point] of points.entries()) {
                    expect(gap(bsplinePointAt(curve, curve.parameters[i]), point)).toBeLessThan(1e-9);
                }
                const segments = bsplineBezierSegments(curve);
                const spans = bsplineSpans(curve);
                // every joint, the seam (last segment → first) included, is C(degree − 1): C2 from four
                // points on, C1 for the three-point parabola
                for (let i = 0; i < segments.length; i++) {
                    const next = (i + 1) % segments.length;
                    const left = bezierEndDerivatives(segments[i], spans[i][1] - spans[i][0], true);
                    const right = bezierEndDerivatives(
                        segments[next],
                        spans[next][1] - spans[next][0],
                        false,
                    );
                    const scale = Math.max(1, ...left.flat().map(Math.abs));
                    for (let k = 0; k < curve.degree; k++)
                        expect(gap(left[k], right[k]) / scale).toBeLessThan(1e-7);
                }
            }),
        );
    });

    test("an open cubic is C2 at its interior knots", () => {
        const curve = curveOf(
            [
                [0, 0],
                [3, 7],
                [10, 8],
                [14, 2],
                [20, 0],
                [26, 5],
            ],
            "chord",
        );
        const segments = bsplineBezierSegments(curve);
        const spans = bsplineSpans(curve);
        expect(segments).toHaveLength(3);
        for (let i = 0; i + 1 < segments.length; i++) {
            const left = bezierEndDerivatives(segments[i], spans[i][1] - spans[i][0], true);
            const right = bezierEndDerivatives(segments[i + 1], spans[i + 1][1] - spans[i + 1][0], false);
            for (let k = 0; k < 3; k++) expect(gap(left[k], right[k])).toBeLessThan(1e-8);
        }
    });

    test("two points are a straight segment, three a parabola arc", () => {
        const line = curveOf(
            [
                [0, 0],
                [10, 5],
            ],
            "chord",
        );
        expect(line.degree).toBe(1);
        expect(gap(bsplinePointAt(line, line.parameters[1] / 2), [5, 2.5])).toBeLessThan(1e-12);
        const arc = curveOf(
            [
                [0, 0],
                [5, 5],
                [10, 0],
            ],
            "chord",
        );
        expect(arc.degree).toBe(2);
        expect(bsplineBezierSegments(arc)).toHaveLength(1);
    });

    test("the Bezier segments reproduce the curve", () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    openPoints.map((p) => [p, false] as const),
                    closedPoints.map((p) => [p, true] as const),
                ),
                ([points, periodic]) => {
                    const curve = curveOf([...points], "chord", periodic);
                    const segments = bsplineBezierSegments(curve);
                    for (const [i, [a, b]] of bsplineSpans(curve).entries()) {
                        const segment = segments[i];
                        for (const s of [0.25, 0.5, 0.8]) {
                            // de Casteljau at s
                            let level = segment.map((p) => [...p] as BSplinePoint);
                            while (level.length > 1) {
                                level = level
                                    .slice(1)
                                    .map((p, j) => [
                                        (1 - s) * level[j][0] + s * p[0],
                                        (1 - s) * level[j][1] + s * p[1],
                                    ]);
                            }
                            expect(gap(level[0], bsplinePointAt(curve, a + s * (b - a)))).toBeLessThan(1e-8);
                        }
                    }
                },
            ),
        );
    });
});

describe("parametrization", () => {
    test("chord steps are the point distances, centripetal their square roots, uniform ones", () => {
        const points: BSplinePoint[] = [
            [0, 0],
            [3, 4],
            [3, 13],
        ];
        expect(bsplineParameters(points, "chord")).toEqual([0, 5, 14]);
        expect(bsplineParameters(points, "centripetal")).toEqual([0, Math.sqrt(5), Math.sqrt(5) + 3]);
        expect(bsplineParameters(points, "uniform")).toEqual([0, 1, 2]);
        // periodic: one more step, back to the first point
        expect(bsplineParameters(points, "chord", true)).toEqual([0, 5, 14, 14 + Math.hypot(3, 13)]);
    });

    test("chord length follows an unevenly sampled outline better than uniform", () => {
        // an ellipse sampled densely on one flank and sparsely on the other — the kind of outline
        // where a uniform parametrization overshoots next to the long spans and flattens the short ones
        const [a, b] = [30, 15];
        const angles = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1.2, 2.2, 3.1, 4.3, 5.4];
        const points = angles.map((t) => [a * Math.cos(t), b * Math.sin(t)] as BSplinePoint);
        const exact = Math.PI * a * b;
        const error = (parametrization: BSplineParametrization) =>
            Math.abs(polygonArea(sampleBSpline(curveOf(points, parametrization, true), 64)) - exact) / exact;
        expect(error("chord")).toBeLessThan(error("uniform"));
        expect(error("centripetal")).toBeLessThan(error("uniform"));
        expect(error("chord")).toBeLessThan(0.02);
    });
});

describe("validation", () => {
    test.each([
        [[], false, "at least two"],
        [[[0, 0]], false, "at least two"],
        [
            [
                [0, 0],
                [1, 1],
            ],
            true,
            "at least three",
        ],
        [
            [
                [0, 0],
                [0, 0],
                [1, 1],
            ],
            false,
            "distinct",
        ],
        [
            [
                [0, 0],
                [Number.NaN, 1],
            ],
            false,
            "finite",
        ],
        [
            [
                [0, 0],
                [5, 5],
                [10, 0],
                [0, 0],
            ],
            false,
            "periodic: true",
        ],
    ] as [BSplinePoint[], boolean, string][])("refuses %j (periodic %s)", (points, periodic, message) => {
        const params = bsplineFitParams(points, periodic);
        expect(params.isOk).toBe(false);
        expect(params.error).toContain(message);
    });

    test("a periodic curve given with its first point repeated drops the repetition", () => {
        const params = bsplineFitParams(
            [
                [0, 0],
                [5, 5],
                [10, 0],
                [0, 0],
            ],
            true,
        );
        expect(params.value).toEqual([0, 0, 5, 5, 10, 0]);
    });
});

describe("queries", () => {
    const curve: BSplineCurve2d = interpolateBSpline(
        [
            [0, 0],
            [10, 10],
            [20, 0],
            [30, 10],
        ],
        {},
    ).value;

    test("the closest parameter lands on the foot of the perpendicular", () => {
        const u = 0.37 * curve.parameters[3];
        const [point, tangent] = evaluateBSpline(curve, u);
        const normal: BSplinePoint = [-tangent[1], tangent[0]];
        const length = Math.hypot(...normal);
        const probe: BSplinePoint = [
            point[0] + (normal[0] / length) * 0.5,
            point[1] + (normal[1] / length) * 0.5,
        ];
        expect(Math.abs(closestBSplineParameter(curve, probe) - u)).toBeLessThan(1e-6);
        expect(bsplineDistance(curve, probe)).toBeCloseTo(0.5, 6);
    });

    test("samples include every fit point and both ends", () => {
        const samples = sampleBSpline(curve);
        expect(samples[0]).toEqual([0, 0]);
        for (const fit of [
            [10, 10],
            [20, 0],
        ]) {
            expect(Math.min(...samples.map((s) => gap(s, fit)))).toBeLessThan(1e-9);
        }
        expect(gap(samples.at(-1)!, [30, 10])).toBeLessThan(1e-9);
    });

    test("a periodic polyline ends where it starts", () => {
        const loop = interpolateBSpline(
            [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
            ],
            { periodic: true },
        ).value;
        const samples = sampleBSpline(loop);
        expect(samples.at(-1)).toEqual(samples[0]);
    });
});
