// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, type Result } from "@spicy3d/core";
import {
    curveIntersections,
    extendCurve,
    offsetCurve,
    splitCurve,
    trimCurve,
} from "../../src/sketch/geometryEditing";
import { arcAngles, ConstraintKind, type SketchEntityData } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const line: SketchEntityData = { id: 1, type: "line", params: [0, 0, 10, 0] };
const circle: SketchEntityData = { id: 2, type: "circle", params: [0, 0, 5] };
const arc: SketchEntityData = { id: 3, type: "arc", params: [0, 0, 5, 0, 0, 5] };
const vertical = (x: number, id = 10): SketchEntityData => ({ id, type: "line", params: [x, -10, x, 10] });
function ok<T>(result: Result<T>): T {
    expect(result.isOk).toBe(true);
    return result.value;
}
function near(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((v, i) => {
        expect(v).toBeCloseTo(expected[i], 8);
    });
}

describe("sketch curve intersections", () => {
    test("clips intersections to line segments and arc sweeps", () => {
        expect(curveIntersections(line, vertical(3))).toEqual([[3, 0]]);
        expect(curveIntersections(line, vertical(12))).toEqual([]);
        expect(curveIntersections(line, vertical(12), true)).toEqual([[12, 0]]);
        expect(curveIntersections(arc, vertical(-3))).toEqual([]);
        expect(curveIntersections(arc, vertical(3))).toEqual([[3, 4]]);
    });
    test("deduplicates tangencies and rejects coincident supports", () => {
        expect(curveIntersections(circle, vertical(5))).toEqual([[5, 0]]);
        expect(curveIntersections(circle, { ...circle, id: 4 })).toEqual([]);
        expect(curveIntersections(line, { ...line, id: 4 })).toEqual([]);
    });
    test("intersects two circles and clips circular targets", () => {
        const other: SketchEntityData = { id: 4, type: "circle", params: [6, 0, 5] };
        expect(curveIntersections(circle, other)).toEqual([
            [3, 4],
            [3, -4],
        ]);
        expect(curveIntersections(arc, other)).toEqual([[3, 4]]);
    });
});

describe("trim, split, extend and offset geometry", () => {
    test("trim removes only the interval between cuts, including endpoint hovers", () => {
        const edit = ok(trimCurve(line, [vertical(3), vertical(7, 11)], [5, 0]));
        expect(edit.pieces.map((e) => e.params)).toEqual([
            [0, 0, 3, 0],
            [7, 0, 10, 0],
        ]);
        expect(edit.preview[0].params).toEqual([3, 0, 7, 0]);
        expect(ok(trimCurve(line, [vertical(3)], [10, 0])).pieces[0].params).toEqual([0, 0, 3, 0]);
        expect(ok(trimCurve(line, [], [5, 0])).pieces).toEqual([]);
    });
    test("trim circles across the angular seam and trim arcs", () => {
        const edit = ok(trimCurve(circle, [vertical(3)], [5, 0]));
        near(edit.pieces[0].params, [0, 0, 3, 4, 3, -4]);
        expect(arcAngles(edit.pieces[0].params)[1]).toBeGreaterThan(Math.PI);
        near(ok(trimCurve(arc, [vertical(3)], [4, 3])).pieces[0].params, [0, 0, 3, 4, 0, 5]);
        expect(trimCurve(circle, [vertical(5)], [5, 0]).isOk).toBe(false);
    });
    test("split projects the pick, snaps to intersections, and rejects endpoints", () => {
        const edit = ok(splitCurve(line, [3.1, 0.1], [vertical(3)], 0.5));
        expect(edit.pieces.map((e) => e.params)).toEqual([
            [0, 0, 3, 0],
            [3, 0, 10, 0],
        ]);
        expect(splitCurve(line, [0, 0]).isOk).toBe(false);
        expect(splitCurve(line, [10, 0]).isOk).toBe(false);
        const split = ok(splitCurve(arc, [3, 3]));
        expect(split.pieces).toHaveLength(2);
        expect(arcAngles(split.pieces[0].params)[1]).toBeCloseTo(Math.PI / 4);
        const halves = ok(splitCurve(circle, [0, 5])).pieces;
        expect(halves).toHaveLength(2);
        halves.forEach((e) => {
            expect(arcAngles(e.params)[1]).toBeCloseTo(Math.PI);
        });
    });
    test.each([
        { at: [9, 0], target: vertical(15), expected: [0, 0, 15, 0] },
        { at: [1, 0], target: vertical(-5), expected: [-5, 0, 10, 0] },
    ])("extends the picked line endpoint", ({ at, target, expected }) => {
        near(ok(extendCurve(line, target, at as [number, number])).pieces[0].params, expected);
    });
    test("extend takes the nearest forward hit and respects target bounds", () => {
        const short = { ...line, params: [0, 0, 1, 0] };
        const target: SketchEntityData = { id: 9, type: "circle", params: [5, 0, 2] };
        near(ok(extendCurve(short, target, [1, 0])).pieces[0].params, [0, 0, 3, 0]);
        expect(extendCurve(line, { ...vertical(15), params: [15, 1, 15, 5] }, [10, 0]).isOk).toBe(false);
        expect(extendCurve(line, vertical(5), [10, 0]).isOk).toBe(false);
    });
    test("extends arc start and end without wrapping to a full circle", () => {
        near(ok(extendCurve(arc, vertical(-3), [0, 5])).pieces[0].params, [0, 0, 5, 0, -3, 4]);
        near(ok(extendCurve(arc, vertical(3), [5, 0])).pieces[0].params, [0, 0, 3, -4, 0, 5]);
        expect(extendCurve(arc, vertical(5), [0, 5]).isOk).toBe(false);
    });
    test.each([2, -2])("offsets lines and circular curves by %s", (distance) => {
        expect(ok(offsetCurve(line, distance)).pieces[0].params).toEqual([0, distance, 10, distance]);
        expect(ok(offsetCurve(circle, distance)).pieces[0].params).toEqual([0, 0, 5 + distance]);
        near(ok(offsetCurve(arc, distance)).pieces[0].params, [0, 0, 5 + distance, 0, 0, 5 + distance]);
    });
    test.each([
        0,
        -5,
        -6,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])("rejects collapsed/invalid offset %s", (distance) => {
        expect(offsetCurve(circle, distance).isOk).toBe(false);
    });
});

describe("solver geometry edits", () => {
    let solver: SketchSolver;
    beforeEach(() => {
        solver = new SketchSolver(Plane.XY);
    });
    afterEach(() => solver.dispose());

    test("splits preserve construction, endpoint fixes and horizontal constraints with fresh IDs", () => {
        const id = solver.addLine(...(line.params as [number, number, number, number]));
        solver.setConstruction(id, true);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: id, pointIndex: 1 }],
            datums: [10, 0],
        });
        solver.addConstraint({
            kind: ConstraintKind.Horizontal,
            refs: [
                { entityId: id, pointIndex: 0 },
                { entityId: id, pointIndex: 1 },
            ],
        });
        const edit = ok(splitCurve(solver.entity(id)!, [4, 0]));
        const applied = ok(solver.applyGeometryEdit(edit));
        expect(applied.entityIds).toHaveLength(2);
        expect(applied.entityIds.every((next) => next > id)).toBe(true);
        expect(solver.entity(id)).toBeUndefined();
        expect(solver.entities().every((e) => e.construction)).toBe(true);
        expect(solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Horizontal)).toHaveLength(
            2,
        );
        const fix = solver.toData().constraints.find((c) => c.kind === ConstraintKind.Fix);
        expect(fix?.refs).toEqual([{ entityId: applied.entityIds[1], pointIndex: 1 }]);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        near(solver.entity(applied.entityIds[1])!.params, [4, 0, 10, 0]);
    });
    test("trimming removes constraints on removed points and leaves no orphan refs", () => {
        const id = solver.addLine(0, 0, 10, 0);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: id, pointIndex: 1 }],
            datums: [10, 0],
        });
        ok(solver.applyGeometryEdit(ok(trimCurve(solver.entity(id)!, [vertical(3)], [8, 0]))));
        expect(solver.toData().constraints).toEqual([]);
        expect(solver.entities()[0].params).toEqual([0, 0, 3, 0]);
    });
    test("circle splits preserve radius and rebuild valid arc structural constraints", () => {
        const id = solver.addCircle(0, 0, 5);
        solver.addConstraint({
            kind: ConstraintKind.Radius,
            refs: [{ entityId: id, pointIndex: 0 }],
            datum: 5,
        });
        ok(solver.applyGeometryEdit(ok(splitCurve(solver.entity(id)!, [5, 0]))));
        expect(solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Radius)).toHaveLength(2);
        expect(solver.toData().constraints.filter((c) => c.kind === ConstraintKind.PointOnArc)).toHaveLength(
            2,
        );
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(
            solver
                .toData()
                .constraints.every((c) => c.refs.every((r) => solver.entity(r.entityId) !== undefined)),
        ).toBe(true);
    });
    test("offset copies remain independent of source constraints; stale proposals do not mutate", () => {
        const id = solver.addLine(0, 0, 10, 0);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: id, pointIndex: 0 }],
            datums: [0, 0],
        });
        const source = solver.entity(id)!;
        const copy = ok(solver.applyGeometryEdit(ok(offsetCurve(source, 2))));
        expect(solver.constraintKindsOn(copy.entityIds[0])).toEqual([]);
        expect(solver.entity(id)).toEqual(source);
        const stale = ok(splitCurve(source, [5, 0]));
        solver.setPointPosition({ entityId: id, pointIndex: 1 }, 20, 0);
        const before = solver.toData();
        expect(solver.applyGeometryEdit(stale).isOk).toBe(false);
        expect(solver.toData()).toEqual(before);
    });
});
