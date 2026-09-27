// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@spicy3d/core";
import type { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { entityDistance, sketchEntityMesh } from "../../src/sketch/editor/sketchEventHandler";
import {
    axisLineRefs,
    ConstraintKind,
    entityPointCount,
    originRef,
    SKETCH_X_AXIS_ID,
    shapeEntityIds,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import {
    type SplinePoint,
    sampleSpline,
    splineParams,
    splinePoints,
    splineSegments,
} from "../../src/sketch/splineGeometry";
import "./setup";

const points: SplinePoint[] = [
    [0, 0],
    [4, 6],
    [9, 3],
    [12, 0],
];

test("interpolates every picked point with continuous cubic joins", () => {
    const params = splineParams(points);
    expect(params.isOk).toBe(true);
    expect(splinePoints(params.value)).toEqual(points);
    const samples = sampleSpline(params.value);
    for (const point of points) expect(samples).toContainEqual(point);
    const segments = splineSegments(params.value);
    expect(segments).toHaveLength(3);
    for (let i = 1; i < segments.length; i++) {
        const previous = segments[i - 1];
        const next = segments[i];
        expect(previous[3]).toEqual(next[0]);
        for (const axis of [0, 1]) {
            expect(previous[3][axis] - previous[2][axis]).toBeCloseTo(next[1][axis] - next[0][axis]);
        }
    }
});

test.each(
    (
        [
            [],
            [[0, 0]],
            [
                [0, 0],
                [0, 0],
            ],
            [
                [0, 0],
                [2, 3],
                [0, 0],
            ],
            [
                [0, 0],
                [Number.NaN, 2],
            ],
        ] as SplinePoint[][]
    ).map((input) => ({ input })),
)("rejects invalid spline points $input without allocating an entity", ({ input }) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        expect(solver.addSpline(input).isOk).toBe(false);
        expect(solver.entities()).toEqual([]);
        expect(solver.dofs()).toBe(0);
    } finally {
        solver.dispose();
    }
});

test("only endpoints have degrees of freedom; dragging recomputes the curve and keeps interior points", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const created = solver.addSpline(points);
        expect(created.isOk).toBe(true);
        const id = created.value;
        expect(entityPointCount("spline")).toBe(2);
        expect(solver.dofs()).toBe(4);
        const before = sampleSpline(solver.entity(id)!.params);
        const end = { entityId: id, pointIndex: 1 };
        solver.beginDrag([end]);
        solver.dragTo(end, 15, 2);
        solver.endDrag();
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.pointOf(end)[0]).toBeCloseTo(15);
        expect(solver.pointOf(end)[1]).toBeCloseTo(2);
        expect(solver.entity(id)!.params.slice(4)).toEqual(points.slice(1, -1).flat());
        expect(sampleSpline(solver.entity(id)!.params)).not.toEqual(before);
        expect(solver.entityPoints(id)).toEqual([
            [0, 0],
            [15, 2],
        ]);
    } finally {
        solver.dispose();
    }
});

test("endpoint coincidence, distance and chord angle survive serialization and reset", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const created = solver.addSpline(points);
        expect(created.isOk).toBe(true);
        const id = created.value;
        const start = { entityId: id, pointIndex: 0 };
        const end = { entityId: id, pointIndex: 1 };
        solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start, originRef()] });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 15 });
        solver.setPointPosition(end, 10, 10);
        solver.addConstraint({
            kind: ConstraintKind.Angle,
            refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
            datum: Math.PI / 4,
        });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.dofs()).toBe(0);
        expect(solver.pointOf(start)[0]).toBeCloseTo(0);
        expect(solver.pointOf(start)[1]).toBeCloseTo(0);
        expect(solver.pointOf(end)[0]).toBeCloseTo(15 / Math.sqrt(2));
        expect(solver.pointOf(end)[1]).toBeCloseTo(15 / Math.sqrt(2));
        const saved = JSON.parse(JSON.stringify(solver.toData()));
        solver.reset(saved);
        expect(solver.entity(id)!.params.slice(4)).toEqual(points.slice(1, -1).flat());
        expect(solver.toData().constraints).toHaveLength(3);
        expect(solver.pointOf(end)[0]).toBeCloseTo(15 / Math.sqrt(2));
        expect(shapeEntityIds(saved)).toEqual([id, id, id]);
        expect(solver.removeEntity(id)).toHaveLength(3);
        expect(solver.entities()).toEqual([]);
        expect(solver.solve(true).dofs).toBe(0);
    } finally {
        solver.dispose();
    }
});

test("mesh and picking follow the spline, including every interpolation point", () => {
    const params = splineParams(points);
    expect(params.isOk).toBe(true);
    const entity = { id: 1, type: "spline" as const, params: params.value };
    const editor = { node: { plane: Plane.XY } } as SketchEditor;
    const mesh = sketchEntityMesh(editor, entity);
    expect(mesh.position).toHaveLength(3 * 32 * 6);
    expect(Array.from(mesh.position).every(Number.isFinite)).toBe(true);
    for (const point of points) expect(entityDistance(point, entity)).toBeCloseTo(0);
    expect(entityDistance([100, 100], entity)).toBeGreaterThan(100);
});
