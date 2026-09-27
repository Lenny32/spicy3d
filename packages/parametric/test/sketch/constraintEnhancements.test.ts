// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, UNITLESS } from "@spicy3d/core";
import { ConstraintKind, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { centerRef, lineRefs } from "../../src/sketch/solverEntities";
import "./setup";

const solvers: SketchSolver[] = [];
function create() {
    const solver = new SketchSolver(Plane.XY);
    solvers.push(solver);
    return solver;
}
afterEach(() => {
    for (const solver of solvers.splice(0)) solver.dispose();
});
function length(s: SketchSolver, id: number) {
    const [a, b] = lineRefs(id).map((r) => s.pointOf(r));
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
function angle(s: SketchSolver, id: number) {
    const [a, b] = lineRefs(id).map((r) => s.pointOf(r));
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

test("collinear aligns multiple lines and points and survives reload", () => {
    const s = create();
    const a = s.addLine(0, 0, 10, 0);
    const b = s.addLine(3, 2, 14, 1);
    const p = s.addPoint(8, 3);
    s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(a)] });
    s.addConstraint({ kind: ConstraintKind.Collinear, refs: [...lineRefs(a), ...lineRefs(b), centerRef(p)] });
    expect(s.solve(true).result).toMatch(/^Ok/);
    for (const ref of [...lineRefs(b), centerRef(p)]) expect(s.pointOf(ref)[1]).toBeCloseTo(0, 6);
    const data = s.toData();
    s.reset(data);
    expect(s.toData()).toEqual(data);
});

test.each([
    "line",
    "circle",
    "arc",
    "ellipse",
    "point",
    "spline",
] as const)("block locks every %s degree of freedom", (type) => {
    const s = create();
    const id =
        type === "line"
            ? s.addLine(1, 2, 10, 8)
            : type === "circle"
              ? s.addCircle(1, 2, 5)
              : type === "arc"
                ? s.addArc(0, 0, 5, 0, 0, 5)
                : type === "ellipse"
                  ? s.addEllipse(0, 0, 5, 0, 0, 3)
                  : type === "point"
                    ? s.addPoint(1, 2)
                    : s.addSpline([
                          [0, 0],
                          [5, 3],
                          [10, 0],
                      ]).value;
    const before = s.entity(id)!.params;
    const block = s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(id)] });
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(s.dofs()).toBe(0);
    expect(s.diagnose().redundant).toEqual([]);
    s.reset(s.toData());
    expect(s.dofs()).toBe(0);
    expect(s.entity(id)!.params).toEqual(before);
    s.removeConstraint(block);
    expect(s.solve(true).dofs).toBeGreaterThan(0);
});

test("equal angles share a free angle and follow a changed driving angle", () => {
    const s = create();
    const a = s.addLine(0, 0, 10, 0);
    const b = s.addLine(0, 0, 8, 5);
    const c = s.addLine(20, 0, 30, 0);
    const d = s.addLine(20, 0, 27, 6);
    s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(a)] });
    s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(c)] });
    const equal = s.addConstraint({ kind: ConstraintKind.EqualAngle, refs: [a, b, c, d].flatMap(lineRefs) });
    const driving = s.addConstraint({
        kind: ConstraintKind.Angle,
        refs: [a, b].flatMap(lineRefs),
        datum: Math.PI / 4,
    });
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(angle(s, b) - angle(s, a)).toBeCloseTo(angle(s, d) - angle(s, c), 6);
    expect(s.setDatumSource(driving, 60).isOk).toBe(true);
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(angle(s, d) - angle(s, c)).toBeCloseTo(Math.PI / 3, 6);
    s.removeConstraint(equal);
    expect(s.diagnose().conflicting).toEqual([]);
});

test("scale preserves length ratio through datum edits, expressions and reload", () => {
    const s = create();
    const a = s.addLine(0, 0, 20, 0);
    const b = s.addLine(0, 10, 10, 10);
    s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(b)] });
    const scale = s.addConstraint({
        kind: ConstraintKind.Scale,
        refs: [a, b].flatMap(lineRefs),
        datum: "2 + 1",
    });
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(length(s, a) / length(s, b)).toBeCloseTo(3, 6);
    expect(s.setDatumSource(scale, 2).isOk).toBe(true);
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(length(s, a) / length(s, b)).toBeCloseTo(2, 6);
    expect(s.setDatumSource(scale, -1).isOk).toBe(false);
    s.reset(s.toData());
    expect(length(s, a) / length(s, b)).toBeCloseTo(2, 6);
});

test("diagnostics map duplicate and conflicting native constraints to persistent IDs", () => {
    const s = create();
    const a = s.addLine(0, 0, 10, 0);
    const first = s.addConstraint({ kind: ConstraintKind.P2PDistance, refs: lineRefs(a), datum: 10 });
    const second = s.addConstraint({ kind: ConstraintKind.P2PDistance, refs: lineRefs(a), datum: 10 });
    s.solve(true);
    const redundant = s.diagnose().redundant;
    expect(redundant.length).toBeGreaterThan(0);
    expect(redundant.every((id) => [first, second].includes(id))).toBe(true);
    s.removeConstraint(second);
    const conflicting = s.addConstraint({ kind: ConstraintKind.P2PDistance, refs: lineRefs(a), datum: 20 });
    s.solve(true);
    const ids = s.diagnose().conflicting;
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => [first, conflicting].includes(id))).toBe(true);
});

test("construction state persists and excludes geometry from profile export mapping", () => {
    const s = create();
    const a = s.addLine(0, 0, 10, 0);
    const b = s.addCircle(0, 0, 5);
    s.setConstruction(a, true);
    s.reset(s.toData());
    expect(s.entity(a)!.construction).toBe(true);
    expect(shapeEntityIds(s.toData())).toEqual([b]);
    s.setConstruction(a, false);
    expect(shapeEntityIds(s.toData())).toEqual([a, b]);
});

test("scale expressions follow document scope changes and trial forks preserve scope", () => {
    const s = create();
    const a = s.addLine(0, 0, 20, 0);
    const b = s.addLine(0, 10, 10, 10);
    s.setScope(new Map([["ratio", { value: 2, unit: UNITLESS }]]));
    s.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(b)] });
    s.addConstraint({ kind: ConstraintKind.Scale, refs: [a, b].flatMap(lineRefs), datum: "ratio" });
    expect(s.solve(true).result).toMatch(/^Ok/);
    s.setScope(new Map([["ratio", { value: 4, unit: UNITLESS }]]));
    expect(s.solve(true).result).toMatch(/^Ok/);
    expect(length(s, a) / length(s, b)).toBeCloseTo(4, 6);
    const trial = s.fork();
    try {
        expect(trial.datumErrors.size).toBe(0);
        expect(length(trial, a) / length(trial, b)).toBeCloseTo(4, 6);
    } finally {
        trial.dispose();
    }
});

test.each([
    ConstraintKind.Collinear,
    ConstraintKind.EqualAngle,
    ConstraintKind.Scale,
    ConstraintKind.Block,
])("diagnostics identify redundant enhanced constraint %s", (kind) => {
    const s = create();
    const a = s.addLine(0, 0, 10, 0);
    const b = s.addLine(20, 0, 30, 0);
    const c = s.addLine(0, 10, 10, 10);
    const d = s.addLine(20, 10, 30, 10);
    const refs =
        kind === ConstraintKind.Block
            ? [centerRef(a)]
            : (kind === ConstraintKind.EqualAngle ? [a, b, c, d] : [a, b]).flatMap(lineRefs);
    const datum = kind === ConstraintKind.Scale ? 1 : undefined;
    const first = s.addConstraint({ kind, refs, datum });
    const second = s.addConstraint({ kind, refs, datum });
    s.solve(true);
    const diagnosis = s.diagnose();
    expect(diagnosis.redundant.some((id) => id === first || id === second)).toBe(true);
});
