// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
import { Plane } from "@spicy3d/core";
import { bsplinePointAt, entityBSpline } from "../../src/sketch/bsplineGeometry";
import { controlBSplineCurve, defineControlBSpline } from "../../src/sketch/controlBSplineGeometry";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";
const poles: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
];
const control = { degree: 2, knots: [0, 1], multiplicities: [3, 3], weights: [1, Math.SQRT1_2, 1] };
test("rational quadratic represents a quarter circle rather than interpolating its middle pole", () => {
    const shape = controlBSplineCurve(poles.flat(), control);
    expect(shape.isOk).toBe(true);
    const mid = bsplinePointAt(shape.value, 0.5);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 12);
});
test("control poles are free solver points, preserve weights, and edits retain identity", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const result = solver.addBSpline(poles, { control });
        expect(result.isOk).toBe(true);
        const id = result.value;
        const outcome = solver.solve(true);
        expect(outcome.result.startsWith("Ok")).toBe(true);
        expect(outcome.dofs).toBe(6);
        expect(solver.toData().entities[0]).toEqual({ id, type: "bspline", params: poles.flat(), control });
        const edited = solver.setControlBSpline(id, { weights: [1, 1, 1] });
        expect(edited.isOk).toBe(true);
        const entity = solver.entity(id)!;
        expect(entity.id).toBe(id);
        expect(bsplinePointAt(entityBSpline(entity.params, entity), 0.5)).toEqual([0.75, 0.75]);
        const before = solver.toData();
        expect(solver.setControlBSpline(id, { weights: [1, -1, 1] }).isOk).toBe(false);
        expect(solver.toData()).toEqual(before);
    } finally {
        solver.dispose();
    }
});
test("PointOnBSpline acts on the rational curve and never pins free poles", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const added = solver.addBSpline(poles, { control });
        expect(added.isOk).toBe(true);
        const point = solver.addPoint(Math.SQRT1_2, Math.SQRT1_2);
        solver.addConstraint({
            kind: ConstraintKind.Block,
            refs: [{ entityId: added.value, pointIndex: 0 }],
        });
        solver.addConstraint({
            kind: ConstraintKind.PointOnBSpline,
            refs: [
                { entityId: point, pointIndex: 0 },
                { entityId: added.value, pointIndex: 0 },
            ],
        });
        const outcome = solver.solve(true);
        expect(outcome.result.startsWith("Ok")).toBe(true);
        const xy = solver.pointOf({ entityId: point, pointIndex: 0 });
        expect(Math.hypot(...xy)).toBeCloseTo(1, 8);
        expect(outcome.dofs).toBe(1);
    } finally {
        solver.dispose();
    }
});
test("periodic poles solve without fit interpolation equations", () => {
    const ps: [number, number][] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ];
    const definition = defineControlBSpline(ps, { periodic: true });
    expect(definition.isOk).toBe(true);
    const solver = new SketchSolver(Plane.XY);
    try {
        const added = solver.addBSpline(ps, { periodic: true, control: definition.value });
        expect(added.isOk).toBe(true);
        const result = solver.solve(true);
        expect(result.result.startsWith("Ok")).toBe(true);
        expect(result.dofs).toBe(8);
        expect(solver.toData().entities[0].params).toEqual(ps.flat());
    } finally {
        solver.dispose();
    }
});
test.each([
    { degree: 2, knots: [0, 1], multiplicities: [2, 3] },
    { degree: 2, knots: [1, 0], multiplicities: [3, 3] },
    { degree: 2, knots: [0, 1], multiplicities: [3, 3], weights: [1, 0, 1] },
    { degree: Infinity },
])("invalid layout is rejected explicitly: %j", (settings) => {
    const result = defineControlBSpline(poles, settings);
    expect(result.isOk).toBe(false);
    expect(result.error.length).toBeGreaterThan(5);
});

test("degree edit generates clamped knots and retains rational weights", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const result = solver.addBSpline(poles, { control });
        expect(result.isOk).toBe(true);
        const edited = solver.setControlBSpline(result.value, { degree: 1 });
        expect(edited.isOk).toBe(true);
        expect(solver.entity(result.value)?.control).toEqual({
            degree: 1,
            knots: [0, 1, 2],
            multiplicities: [2, 1, 2],
            weights: control.weights,
        });
    } finally {
        solver.dispose();
    }
});
