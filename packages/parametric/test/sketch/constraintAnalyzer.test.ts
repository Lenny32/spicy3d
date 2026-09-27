// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@spicy3d/core";
import {
    analyzeConstraints,
    applyDimensions,
    suggestDimensions,
} from "../../src/sketch/editor/constraintAnalyzer";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { centerRef, lineRefs } from "../../src/sketch/solverEntities";
import "./setup";

let solver: SketchSolver;
beforeEach(() => {
    solver = new SketchSolver(Plane.XY);
});
afterEach(() => solver.dispose());

test("review suggests only independent sizes and applies one atomic batch", () => {
    const a = solver.addLine(0, 0, 10, 0);
    const b = solver.addLine(0, 10, 10, 10);
    solver.addCircle(20, 20, 4);
    solver.addConstraint({ kind: ConstraintKind.EqualLength, refs: [a, b].flatMap(lineRefs) });
    const before = solver.toData();
    const dofs = solver.dofs();
    const suggestions = suggestDimensions(solver);
    expect(suggestions).toHaveLength(2);
    expect(solver.toData()).toEqual(before);
    expect(applyDimensions(solver, suggestions)).toBe(true);
    expect(solver.dofs()).toBe(dofs - 2);
    expect(suggestDimensions(solver)).toEqual([]);
});

test("stale or conflicting batch leaves all live data unchanged", () => {
    const a = solver.addLine(0, 0, 10, 0);
    const suggestions = suggestDimensions(solver);
    solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: lineRefs(a), datum: 20 });
    solver.solve(true);
    const before = solver.toData();
    expect(applyDimensions(solver, suggestions)).toBe(false);
    expect(solver.toData()).toEqual(before);
});

test("unused construction excludes guides relating other entities and ignores structural arc equations", () => {
    const a = solver.addLine(0, 0, 10, 0);
    const b = solver.addLine(0, 10, 10, 10);
    const c = solver.addArc(20, 0, 25, 0, 20, 5);
    solver.setConstruction(a, true);
    solver.setConstruction(c, true);
    solver.addConstraint({ kind: ConstraintKind.Parallel, refs: [a, b].flatMap(lineRefs) });
    const analysis = analyzeConstraints(solver.toData());
    expect(analysis.unusedConstruction).toEqual([c]);
    expect(analysis.suggestions.map((s) => s.constraint.refs[0].entityId)).toEqual([b]);
    expect(analysis.freeMotions).toContain("Translate X");
    solver.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(b)] });
    expect(analyzeConstraints(solver.toData()).freeMotions).toEqual([]);
});

test("a 100-line sketch is analyzed without mutation", () => {
    for (let i = 0; i < 100; i++) solver.addLine(i * 20, 0, i * 20 + 10, 0);
    const data = solver.toData();
    const start = performance.now();
    const analysis = analyzeConstraints(data);
    expect(analysis.suggestions).toHaveLength(100);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(solver.toData()).toEqual(data);
});
