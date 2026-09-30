// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@spicy3d/core";
import {
    type BSplinePoint,
    bsplinePointAt,
    bsplinePoints,
    closestBSplineParameter,
    evaluateBSpline,
    interpolateBSpline,
} from "../../src/sketch/bsplineGeometry";
import {
    ConstraintKind,
    entityPointCount,
    originRef,
    type SketchData,
    type SketchPointRef,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const points: BSplinePoint[] = [
    [0, 0],
    [10, 1],
    [12, 9],
    [3, 12],
    [-4, 6],
];

function withSolver(run: (solver: SketchSolver) => void, data?: SketchData): void {
    const solver = new SketchSolver(Plane.XY, data);
    try {
        run(solver);
    } finally {
        solver.dispose();
    }
}

function add(solver: SketchSolver, fit: BSplinePoint[] = points, periodic = false): number {
    const created = solver.addBSpline(fit, { periodic });
    expect(created.isOk).toBe(true);
    return created.value;
}

/** Distance from a point to the entity's real curve (the interpolant of its current params). */
function offCurve(solver: SketchSolver, id: number, point: [number, number]): number {
    const entity = solver.entity(id)!;
    const curve = interpolateBSpline(bsplinePoints(entity.params), {
        parametrization: entity.parametrization,
        periodic: entity.periodic,
    }).value;
    const foot = bsplinePointAt(curve, closestBSplineParameter(curve, point));
    return Math.hypot(foot[0] - point[0], foot[1] - point[1]);
}

const ref = (entityId: number, pointIndex: number): SketchPointRef => ({ entityId, pointIndex });

/** Largest distance of the fit points `indices` of entity `id` from `expected` (by index). */
function fitDrift(solver: SketchSolver, id: number, indices: number[], expected: BSplinePoint[]): number {
    return Math.max(
        ...indices.map((i) => {
            const [u, v] = solver.pointOf(ref(id, i));
            return Math.hypot(u - expected[i][0], v - expected[i][1]);
        }),
    );
}

function expectFitPointsAt(
    solver: SketchSolver,
    id: number,
    indices: number[],
    expected: BSplinePoint[],
): void {
    expect(fitDrift(solver, id, indices, expected)).toBeLessThan(1e-6);
}

/** Angle mismatch (|sin|) between a line and the curve's tangent at fit point `index`. */
function tangentMismatch(solver: SketchSolver, id: number, line: number, index: number): number {
    const entity = solver.entity(id)!;
    const curve = interpolateBSpline(bsplinePoints(entity.params)).value;
    const tangent = evaluateBSpline(curve, curve.parameters[index])[1];
    const [a, b] = [solver.pointOf(ref(line, 0)), solver.pointOf(ref(line, 1))];
    const direction = [b[0] - a[0], b[1] - a[1]];
    const cross = tangent[0] * direction[1] - tangent[1] * direction[0];
    return Math.abs(cross) / Math.hypot(...tangent) / Math.hypot(...direction);
}

/** The fit points of entity `id`, in order. */
function fitPoints(solver: SketchSolver, id: number): BSplinePoint[] {
    return bsplinePoints(solver.entity(id)!.params);
}

/** Largest distance of each fit point of entity `id` from `from` (by index). */
function fitMoves(solver: SketchSolver, id: number, from: BSplinePoint[]): number[] {
    return fitPoints(solver, id).map(([u, v], i) => Math.hypot(u - from[i][0], v - from[i][1]));
}

/**
 * The single end tangent of the review measurements: fit 0 fixed at the origin, tangent there to a
 * fixed horizontal line. Returns the curve and line ids.
 */
function addEndTangent(solver: SketchSolver): { id: number; line: number } {
    const id = add(solver);
    const line = solver.addLine(0, 0, -10, 0);
    solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(id, 0)], datums: [0, 0] });
    solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 0)], datums: [0, 0] });
    solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 1)], datums: [-10, 0] });
    solver.addConstraint({
        kind: ConstraintKind.TangentLineBSpline,
        refs: [ref(line, 0), ref(line, 1), ref(id, 0)],
    });
    return { id, line };
}

/** A fixed point on the curve between fit points 1 and 2; returns it. */
function addFixedPointOnCurve(solver: SketchSolver, id: number): BSplinePoint {
    const curve = interpolateBSpline(points).value;
    const [u, v] = bsplinePointAt(curve, 0.5 * (curve.parameters[1] + curve.parameters[2]));
    const point = solver.addPoint(u, v);
    solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(point, 0)], datums: [u, v] });
    solver.addConstraint({ kind: ConstraintKind.PointOnBSpline, refs: [ref(point, 0), ref(id, 0)] });
    return [u, v];
}

/** Drags `dragged` by (6, 5) mm in `frames` frames; returns the largest cursor lag of a frame. */
function dragBy(solver: SketchSolver, dragged: SketchPointRef, frames = 30): number {
    const [x0, y0] = solver.pointOf(dragged);
    solver.beginDrag([dragged]);
    const lags: number[] = [];
    for (let frame = 1; frame <= frames; frame++) {
        const [x, y] = [x0 + (6 * frame) / frames, y0 + (5 * frame) / frames];
        expect(solver.dragTo(dragged, x, y).result).toMatch(/^Ok/);
        const [px, py] = solver.pointOf(dragged);
        lags.push(Math.hypot(px - x, py - y));
    }
    return Math.max(...lags);
}

describe("bspline entity", () => {
    test("every fit point is a solver point; the curve adds no degree of freedom", () => {
        withSolver((solver) => {
            const id = add(solver);
            const entity = solver.entity(id)!;
            expect(entity).toEqual({ id, type: "bspline", params: points.flat(), parametrization: "chord" });
            expect(entityPointCount("bspline", entity.params)).toBe(5);
            expect(solver.dofs()).toBe(10);
            expect(solver.pointOf(ref(id, 3))).toEqual([3, 12]);
            expect(solver.entityPoints(id)).toEqual([
                [0, 0],
                [-4, 6],
            ]);
        });
    });

    test("a periodic bspline stores its flag, has no ends, and drops a repeated first point", () => {
        withSolver((solver) => {
            const id = add(solver, [...points, points[0]], true);
            const entity = solver.entity(id)!;
            expect(entity.periodic).toBe(true);
            expect(entity.params).toEqual(points.flat());
            expect(solver.entityPoints(id)).toEqual([]);
            expect(solver.dofs()).toBe(10);
        });
    });

    test.each([
        [[[0, 0]] as BSplinePoint[], false],
        [
            [
                [0, 0],
                [5, 5],
                [0, 0],
            ] as BSplinePoint[],
            false,
        ],
        [
            [
                [0, 0],
                [5, 5],
            ] as BSplinePoint[],
            true,
        ],
    ])("refuses %j (periodic %s) without allocating anything", (fit, periodic) => {
        withSolver((solver) => {
            expect(solver.addBSpline(fit, { periodic }).isOk).toBe(false);
            expect(solver.entities()).toEqual([]);
            expect(solver.dofs()).toBe(0);
        });
    });

    test("dragging one fit point moves it alone — the other fit points stay where they are", () => {
        withSolver((solver) => {
            const id = add(solver);
            const dragged = ref(id, 2);
            solver.beginDrag([dragged]);
            for (const [u, v] of [
                [13, 10],
                [15, 12],
                [18, 11],
            ]) {
                solver.dragTo(dragged, u, v);
            }
            solver.endDrag();
            const params = solver.entity(id)!.params;
            expect(params.slice(4, 6)).toEqual([18, 11]);
            const others = [0, 1, 3, 4].flatMap((i) => params.slice(2 * i, 2 * i + 2));
            const expected = [0, 1, 3, 4].flatMap((i) => points[i]);
            others.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 9));
        });
    });

    test("constraints on fit points solve like any points' (coincidence, alignment, distance)", () => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(-4, 6, -10, 20);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(id, 0), originRef()] });
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(id, 4), ref(line, 0)] });
            solver.addConstraint({ kind: ConstraintKind.HorizontalAlign, refs: [ref(id, 1), ref(id, 0)] });
            solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(id, 0), ref(id, 1)],
                datum: 20,
            });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const [x1, y1] = solver.pointOf(ref(id, 1));
            expect(y1).toBeCloseTo(0, 9);
            expect(Math.abs(x1)).toBeCloseTo(20, 9);
            const end = solver.pointOf(ref(id, 4));
            const lineStart = solver.pointOf(ref(line, 0));
            expect(end[0]).toBeCloseTo(lineStart[0], 9);
            expect(end[1]).toBeCloseTo(lineStart[1], 9);
            // 10 fit coordinates + 4 line coordinates − 2 (origin) − 2 (joint) − 1 (align) − 1 (distance)
            expect(solver.dofs()).toBe(8);
            // the fit points no constraint names stay where they were
            expectFitPointsAt(solver, id, [2, 3], points);
        });
    });

    test("a constraint pulling an end moves that end alone — the free fit points stay put", () => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(0, 0, -10, 0);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(id, 0), ref(line, 0)] });
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 1)], datums: [-10, 0] });
            solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(line, 0), ref(line, 1)],
                datum: 30,
            });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const [u, v] = solver.pointOf(ref(id, 0));
            expect(Math.hypot(u + 10, v)).toBeCloseTo(30, 9);
            expect(Math.hypot(u, v)).toBeGreaterThan(19);
            expectFitPointsAt(solver, id, [1, 2, 3, 4], points);
        });
    });

    test.each([
        ["three 3 mm frames", 3],
        ["forty 0.27 mm frames", 40],
    ])("dragging a fit point with an end tangent (%s) moves only the dragged point and the tangent end", (_, frames) => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(-4, 6, -10, 8);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(line, 0), ref(id, 4)] });
            solver.addConstraint({
                kind: ConstraintKind.TangentLineBSpline,
                refs: [ref(line, 0), ref(line, 1), ref(id, 4)],
            });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const before = [0, 1, 2, 3, 4].map((i) => solver.pointOf(ref(id, i)));
            const dragged = ref(id, 3);
            const drop: BSplinePoint = [before[3][0] + 6.3, before[3][1] + 5.4];
            solver.beginDrag([dragged]);
            for (let frame = 1; frame <= frames; frame++) {
                const t = frame / frames;
                solver.dragTo(dragged, before[3][0] + 6.3 * t, before[3][1] + 5.4 * t);
            }
            expect(solver.endDrag().result).toMatch(/^Ok/);
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expectFitPointsAt(solver, id, [0, 1, 2], before);
            expectFitPointsAt(solver, id, [3], [...before.slice(0, 3), drop]);
            expect(tangentMismatch(solver, id, line, 4)).toBeLessThan(1e-7);
        });
    });

    test("a redundant constraint elsewhere keeps the free fit points pinned when an end is pulled", () => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(0, 0, -10, 0);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(id, 0), ref(line, 0)] });
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 1)], datums: [-10, 0] });
            solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(line, 0), ref(line, 1)],
                datum: 30,
            });
            // the same equation twice: a redundant pair
            solver.addConstraint({ kind: ConstraintKind.Horizontal, refs: [ref(line, 0), ref(line, 1)] });
            solver.addConstraint({
                kind: ConstraintKind.HorizontalAlign,
                refs: [ref(line, 0), ref(line, 1)],
            });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(solver.pointOf(ref(id, 0))[0]).toBeCloseTo(20, 9);
            expectFitPointsAt(solver, id, [1, 2, 3, 4], points);
        });
    });

    test("a constrained drag with the cursor off the constraint locus leaves the unnamed fit points alone", () => {
        withSolver((solver) => {
            const id = add(solver);
            const circle = solver.addCircle(12, 9, 2);
            const center = ref(circle, 0);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [center, ref(id, 2)] });
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(id, 0)], datums: [0, 0] });
            solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: [ref(id, 0), center], datum: 20 });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const before = [0, 1, 2, 3, 4].map((i) => solver.pointOf(ref(id, i)));
            const start = Math.atan2(before[2][1], before[2][0]);
            solver.beginDrag([center]);
            for (let frame = 1; frame <= 40; frame++) {
                const angle = start + (0.8 * frame) / 40;
                solver.dragTo(center, 19.5 * Math.cos(angle), 19.5 * Math.sin(angle));
                expect(fitDrift(solver, id, [1, 3, 4], before)).toBeLessThan(1e-6);
            }
            expect(solver.endDrag().result).toMatch(/^Ok/);
            expectFitPointsAt(solver, id, [1, 3, 4], before);
            const [u, v] = solver.pointOf(center);
            expect(Math.hypot(u, v)).toBeCloseTo(20, 6);
        });
    });

    test.each([
        ["an unnamed fit point", false],
        ["a fit point joined to a free point", true],
    ])("a drag of %s under a fixed point on the curve follows the cursor exactly", (_, joined) => {
        withSolver((solver) => {
            const id = add(solver);
            const fixed = addFixedPointOnCurve(solver, id);
            const dragged = ref(id, 3);
            if (joined) {
                // a coincidence names the dragged fit point: the cursor is still on the locus
                const point = solver.addPoint(...points[3]);
                solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(point, 0), dragged] });
            }
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const [x0, y0] = solver.pointOf(dragged);
            expect(dragBy(solver, dragged)).toBeLessThan(1e-6);
            const last = fitPoints(solver, id);
            expect(solver.endDrag().result).toMatch(/^Ok/);
            // the release re-knots the curve (chord-length knots follow the moved point): the released
            // point stays at the cursor, the fixed point takes a small reshape of its neighbours
            const [ex, ey] = solver.pointOf(dragged);
            expect(Math.hypot(ex - (x0 + 6), ey - (y0 + 5))).toBeLessThan(1e-6);
            expect(Math.max(...fitMoves(solver, id, last))).toBeLessThan(0.01);
            expect(offCurve(solver, id, fixed)).toBeLessThan(1e-6);
        });
    });

    test("one fine solve meets end tangents to two fixed lines on the real (re-knotted) curve", () => {
        withSolver((solver) => {
            const id = add(solver);
            const first = solver.addLine(0, 0, -10, 0);
            const last = solver.addLine(-4, 6, -14, 6);
            for (const [line, [x1, y1, x2, y2], end] of [
                [first, [0, 0, -10, 0], 0],
                [last, [-4, 6, -14, 6], 4],
            ] as const) {
                solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 0)], datums: [x1, y1] });
                solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 1)], datums: [x2, y2] });
                solver.addConstraint({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [ref(line, 0), ref(id, end)],
                });
                solver.addConstraint({
                    kind: ConstraintKind.TangentLineBSpline,
                    refs: [ref(line, 0), ref(line, 1), ref(id, end)],
                });
            }
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(tangentMismatch(solver, id, first, 0)).toBeLessThan(1e-7);
            expect(tangentMismatch(solver, id, last, 4)).toBeLessThan(1e-7);
            // each tangent turns the leg next to its end: the middle fit point stays, the moved ones
            // stay within the reshape (measured 6.9 and 4.1 mm; the plain walk moved them 13.7 / 6.5 / 1.8)
            const moves = fitMoves(solver, id, points);
            expect(moves[2]).toBeLessThan(1e-6);
            expect(Math.max(...moves)).toBeLessThan(8);
        });
    });

    test("a fresh end tangent reshapes the curve next to its end only, as little as a single point would", () => {
        withSolver((solver) => {
            const { id, line } = addEndTangent(solver);
            expect(solver.solve(true).result).toBe("OkUnderconstrained");
            expect(tangentMismatch(solver, id, line, 0)).toBeLessThan(1e-7);
            const moves = fitMoves(solver, id, points);
            // moving fit 1 alone by 3.7 mm meets the tangent (grid search): stay within twice that
            // (measured 5.8 mm; the plain walk moved fits 1 / 2 / 3 by 16.1 / 8.9 / 1.0 mm)
            expect(moves[1]).toBeLessThan(7.4);
            expect(Math.max(...moves.slice(2))).toBeLessThan(1e-6);
        });
    });

    test.each([
        1, 2, 3, 4,
    ])("under an end tangent, dropping dragged fit %i leaves it at the cursor and the curve where it was", (index) => {
        withSolver((solver) => {
            const { id, line } = addEndTangent(solver);
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const dragged = ref(id, index);
            const [x0, y0] = solver.pointOf(dragged);
            expect(dragBy(solver, dragged)).toBeLessThan(1e-6);
            const last = fitPoints(solver, id);
            expect(solver.endDrag().result).toMatch(/^Ok/);
            const [ex, ey] = solver.pointOf(dragged);
            expect(Math.hypot(ex - (x0 + 6), ey - (y0 + 5))).toBeLessThan(0.1);
            // the frames re-knot as they go: the release only settles the last frame's knots
            expect(Math.max(...fitMoves(solver, id, last))).toBeLessThan(1);
            expect(tangentMismatch(solver, id, line, 0)).toBeLessThan(1e-7);
        });
    });

    test("dragging a fit point out and back under an end tangent brings the curve back", () => {
        withSolver((solver) => {
            const { id } = addEndTangent(solver);
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const start = fitPoints(solver, id);
            const dragged = ref(id, 3);
            for (let round = 0; round < 3; round++) {
                solver.beginDrag([dragged]);
                for (const frame of [...Array(31).keys(), ...[...Array(30).keys()].reverse()]) {
                    solver.dragTo(dragged, start[3][0] + (6 * frame) / 30, start[3][1] + (5 * frame) / 30);
                }
                expect(solver.endDrag().result).toMatch(/^Ok/);
            }
            expect(Math.max(...fitMoves(solver, id, start))).toBeLessThan(1e-3);
        });
    });

    test("an end tangent joined to a free line solves the same whatever was solved before on the page", () => {
        // four drags under a fixed point on the curve first, each in a solver of its own: PlaneGCS
        // orders its unknowns by address, so the heap they leave behind changes the iteration path
        // (see the note on `pinLevels`); a solve that stays well-conditioned does not depend on it
        for (let run = 0; run < 4; run++) {
            withSolver((solver) => {
                const id = add(solver);
                addFixedPointOnCurve(solver, id);
                expect(solver.solve(true).result).toMatch(/^Ok/);
                dragBy(solver, ref(id, 3));
                solver.endDrag();
            });
        }
        const solved: BSplinePoint[][] = [];
        for (let run = 0; run < 2; run++) {
            withSolver((solver) => {
                const { id, line } = addEndTangent(solver);
                const free = solver.addLine(3, 12, 8, 16);
                solver.addConstraint({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [ref(free, 0), ref(id, 3)],
                });
                expect(solver.solve(true).result).toBe("OkUnderconstrained");
                expect(tangentMismatch(solver, id, line, 0)).toBeLessThan(1e-7);
                // the joined fit point moves with the reshape, but nowhere near the plain walk's
                // hundreds of millions of mm
                expect(Math.max(...fitMoves(solver, id, points))).toBeLessThan(7.4);
                solved.push(fitPoints(solver, id));
            });
        }
        solved[1].forEach(([u, v], i) => {
            expect(u).toBeCloseTo(solved[0][i][0], 9);
            expect(v).toBeCloseTo(solved[0][i][1], 9);
        });
    });

    test("a curve that must reshape to reach a fixed point on it still solves (its fit points move then)", () => {
        withSolver((solver) => {
            const id = add(solver);
            const point = solver.addPoint(8, 9);
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(point, 0)], datums: [8, 9] });
            solver.addConstraint({ kind: ConstraintKind.PointOnBSpline, refs: [ref(point, 0), ref(id, 0)] });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(offCurve(solver, id, [8, 9])).toBeLessThan(1e-6);
            expect(fitDrift(solver, id, [0, 1, 2, 3, 4], points)).toBeGreaterThan(1e-3);
            // 10 fit coordinates + 2 point coordinates − 2 (fix) − 1 (on the curve)
            expect(solver.dofs()).toBe(9);
        });
    });

    test("a point on the bspline stays on the real curve when a fit point is dragged", () => {
        withSolver((solver) => {
            const id = add(solver);
            const curve = interpolateBSpline(points).value;
            const [u, v] = bsplinePointAt(curve, 0.4 * curve.parameters[1] + 0.6 * curve.parameters[2]);
            const point = solver.addPoint(u, v);
            solver.addConstraint({ kind: ConstraintKind.PointOnBSpline, refs: [ref(point, 0), ref(id, 0)] });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            // the point slides along the curve: one degree of freedom less than a free point
            expect(solver.dofs()).toBe(11);
            const dragged = ref(id, 2);
            solver.beginDrag([dragged]);
            solver.dragTo(dragged, 16, 13);
            solver.endDrag();
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(offCurve(solver, id, solver.pointOf(ref(point, 0)))).toBeLessThan(1e-6);
        });
    });

    test("a line tangent at an end runs along the curve's end tangent", () => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(-4, 6, -10, 8);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(line, 0), ref(id, 4)] });
            solver.addConstraint({
                kind: ConstraintKind.TangentLineBSpline,
                refs: [ref(line, 0), ref(line, 1), ref(id, 4)],
            });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const entity = solver.entity(id)!;
            const curve = interpolateBSpline(bsplinePoints(entity.params)).value;
            const tangent = evaluateBSpline(curve, curve.parameters[4])[1];
            const [a, b] = [solver.pointOf(ref(line, 0)), solver.pointOf(ref(line, 1))];
            const direction = [b[0] - a[0], b[1] - a[1]];
            const cross = tangent[0] * direction[1] - tangent[1] * direction[0];
            expect(Math.abs(cross) / Math.hypot(...tangent) / Math.hypot(...direction)).toBeLessThan(1e-7);
        });
    });

    test("a pinned solve that collapses a tangent line is dropped: the plain solve bends the curve instead", () => {
        withSolver((solver) => {
            const id = add(solver);
            const line = solver.addLine(-4, 6, -14, 6);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(line, 0), ref(id, 4)] });
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(line, 1)], datums: [-14, 6] });
            solver.addConstraint({
                kind: ConstraintKind.HorizontalAlign,
                refs: [ref(line, 0), ref(line, 1)],
            });
            solver.addConstraint({
                kind: ConstraintKind.TangentLineBSpline,
                refs: [ref(line, 0), ref(line, 1), ref(id, 4)],
            });
            expect(solver.solve(true).result).toBe("OkUnderconstrained");
            // 10 fit coordinates + 4 line coordinates − 2 (fix) − 2 (joint) − 1 (align) − 1 (tangent)
            expect(solver.dofs()).toBe(8);
            expect(tangentMismatch(solver, id, line, 4)).toBeLessThan(1e-6);
            const [a, b] = [solver.pointOf(ref(line, 0)), solver.pointOf(ref(line, 1))];
            expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(5);
            expect(b).toEqual([-14, 6]);
            expect(a[1]).toBeCloseTo(6, 9);
        });
    });

    test("an end tangent on a periodic bspline or at an interior point is refused", () => {
        withSolver((solver) => {
            const open = add(solver);
            const closed = add(
                solver,
                points.map(([u, v]) => [u + 40, v]),
                true,
            );
            const line = solver.addLine(0, 0, -5, 5);
            expect(() =>
                solver.addConstraint({
                    kind: ConstraintKind.TangentLineBSpline,
                    refs: [ref(line, 0), ref(line, 1), ref(open, 2)],
                }),
            ).toThrow("no end");
            expect(() =>
                solver.addConstraint({
                    kind: ConstraintKind.TangentLineBSpline,
                    refs: [ref(line, 0), ref(line, 1), ref(closed, 0)],
                }),
            ).toThrow("periodic");
        });
    });

    test("data round-trips through reset; removal takes its constraints and leaves no degree of freedom", () => {
        withSolver((solver) => {
            const id = add(solver, points, true);
            const point = solver.addPoint(1, 1);
            solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(id, 0)], datums: [0, 0] });
            const curve = interpolateBSpline(points, { periodic: true }).value;
            const [u, v] = bsplinePointAt(curve, 3);
            solver.setPointPosition(ref(point, 0), u, v);
            solver.addConstraint({ kind: ConstraintKind.PointOnBSpline, refs: [ref(point, 0), ref(id, 0)] });
            expect(solver.solve(true).result).toMatch(/^Ok/);
            const saved = JSON.parse(JSON.stringify(solver.toData())) as SketchData;
            expect(saved.entities[0]).toEqual({
                id,
                type: "bspline",
                params: solver.entity(id)!.params,
                parametrization: "chord",
                periodic: true,
            });
            solver.reset(saved);
            expect(solver.toData()).toEqual(saved);
            expect(solver.dofs()).toBe(8 + 1);
            expect(solver.removeEntity(id)).toHaveLength(2);
            expect(solver.entities().map((e) => e.type)).toEqual(["point"]);
            expect(solver.solve(true).dofs).toBe(2);
        });
    });

    test("a stored bspline whose points no longer interpolate still loads; its fit points still solve", () => {
        const data: SketchData = {
            entities: [{ id: 1, type: "bspline", params: [0, 0, 0, 0, 5, 5], parametrization: "chord" }],
            constraints: [],
        };
        withSolver((solver) => {
            expect(solver.entity(1)?.params).toEqual([0, 0, 0, 0, 5, 5]);
            expect(solver.dofs()).toBe(6);
            expect(() =>
                solver.addConstraint({ kind: ConstraintKind.PointOnBSpline, refs: [originRef(), ref(1, 0)] }),
            ).toThrow("does not interpolate");
        }, data);
    });

    test("stored data without a parametrization loads as chord length and saves back as it was", () => {
        const data: SketchData = {
            entities: [{ id: 1, type: "bspline", params: points.flat() }],
            constraints: [],
        };
        withSolver((solver) => {
            expect(solver.toData()).toEqual(data);
            expect(solver.dofs()).toBe(10);
        }, structuredClone(data));
    });

    test("parametrization is kept per entity", () => {
        withSolver((solver) => {
            const created = solver.addBSpline(points, { parametrization: "centripetal" });
            expect(created.isOk).toBe(true);
            expect(solver.entity(created.value)?.parametrization).toBe("centripetal");
        });
    });
});
