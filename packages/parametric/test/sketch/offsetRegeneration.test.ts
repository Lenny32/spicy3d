// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, Plane } from "@spicy3d/core";
import { offsetCurve } from "../../src/sketch/geometryEditing";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const scope = (value: number) => new Map([["gap", { value, unit: LENGTH_UNITS }]]);
const ref = (entityId: number, pointIndex: number) => ({ entityId, pointIndex });

function fixture(type: "slot" | "arc" | "length" | "conflict") {
    const solver = new SketchSolver(Plane.XY, undefined, scope(2));
    const source = type === "arc" ? solver.addArc(0, 0, 10, 0, 0, 10) : solver.addLine(0, 0, 10, 0);
    solver.addConstraint({
        kind: ConstraintKind.Fix,
        refs: [ref(source, type === "arc" ? 1 : 0)],
        datums: [type === "arc" ? 10 : 0, 0],
    });
    const offset = offsetCurve(solver.entity(source)!, 2);
    expect(offset.isOk).toBe(true);
    const p = offset.value.pieces[0].params;
    const target =
        type === "arc"
            ? solver.addArc(p[0], p[1], p[2], p[3], p[4], p[5])
            : solver.addLine(p[0], p[1], p[2], p[3]);
    solver.addConstraint({
        kind: ConstraintKind.Offset,
        refs: [ref(source, 0), ref(target, 0)],
        datum: "gap",
    });
    const joins: { source: number; target: number; connector: number; start: number; end: number }[] = [];
    const endpoints = type === "slot" ? [0, 1] : [1];
    for (const endpoint of endpoints) {
        // The dimensioned connector forms a triangle with the source endpoint:
        // lengths 7 and 8, and a 2 mm source-to-target side at creation.
        const a: [number, number] =
            type === "length"
                ? [10 + Math.sqrt(64 - 4.75 ** 2), 4.75]
                : solver.pointOf(ref(source, endpoint));
        const b = solver.pointOf(ref(target, endpoint));
        const arc = type === "slot" || type === "arc";
        const connector = arc
            ? solver.addArc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ...a, ...b)
            : solver.addLine(...a, ...b);
        const start = arc ? 1 : 0;
        const end = arc ? 2 : 1;
        if (type !== "length")
            solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [ref(connector, start), ref(source, endpoint)],
            });
        solver.addConstraint({
            kind: ConstraintKind.P2PCoincident,
            refs: [ref(connector, end), ref(target, endpoint)],
        });
        if (type === "length") {
            solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(connector, start), ref(source, endpoint)],
                datum: 8,
            });
            solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(connector, start), ref(connector, end)],
                datum: 7,
            });
        }
        if (type === "conflict")
            solver.addConstraint({
                kind: ConstraintKind.Vertical,
                refs: [ref(connector, start), ref(connector, end)],
            });
        joins.push({ source: endpoint, target: endpoint, connector, start, end });
    }
    expect(solver.solve(true).result).toMatch(/^Ok/);
    return { solver, source, target, joins };
}

test.each(
    (["slot", "arc", "length"] as const).flatMap((type) => [3, 5, 1].map((gap) => ({ type, gap }))),
)("underconstrained $type source stays put at gap=$gap and after source edits", ({ type, gap }) => {
    const { solver, source, target, joins } = fixture(type);
    try {
        const initialDofs = solver.diagnose().dofs;
        expect(initialDofs).toBeGreaterThan(0);
        const before = solver.entity(source)!.params;
        solver.setScope(scope(gap));
        const outcome = solver.solve(true);
        expect(outcome.result).toMatch(/^Ok/);
        expect(solver.offsetErrors.size).toBe(0);
        solver.entity(source)!.params.forEach((value, i) => expect(value).toBeCloseTo(before[i], 7));
        const expected = offsetCurve(solver.entity(source)!, gap);
        expect(expected.isOk).toBe(true);
        expect(solver.entity(target)!.params).toEqual(expected.value.pieces[0].params);
        for (const join of joins) {
            const a = solver.pointOf(ref(join.connector, join.start));
            const b = solver.pointOf(ref(source, join.source));
            const c = solver.pointOf(ref(join.connector, join.end));
            const d = solver.pointOf(ref(target, join.target));
            const expectedStart = type === "length" ? 7 : 0;
            expect(
                Math.hypot(
                    a[0] - (type === "length" ? c[0] : b[0]),
                    a[1] - (type === "length" ? c[1] : b[1]),
                ),
            ).toBeCloseTo(expectedStart, 7);
            expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(type === "length" ? 8 : 0, 7);
            c.forEach((value, i) => expect(value).toBeCloseTo(d[i], 7));
        }
        expect(solver.diagnose()).toEqual({ conflicting: [], redundant: [], dofs: initialDofs });
        const fixed = solver.toData().constraints.find((c) => c.kind === ConstraintKind.Fix)!;
        solver.setDatum(fixed.id, 2, 1);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.offsetErrors.size).toBe(0);
        const edited = solver.entity(source)!.params;
        expect(solver.pointOf(fixed.refs[0])[1]).toBeCloseTo(2, 7);
        expect(edited).not.toEqual(type === "arc" ? [0, 0, 10, 0, 0, 10] : [0, 0, 10, 0]);
        solver.setScope(scope(gap === 3 ? 5 : 3));
        expect(solver.solve(true).result).toMatch(/^Ok/);
        solver.entity(source)!.params.forEach((value, i) => expect(value).toBeCloseTo(edited[i], 7));
        expect(solver.diagnose()).toEqual({ conflicting: [], redundant: [], dofs: initialDofs });
        const snapshot = solver.toData();
        expect(solver.reset(snapshot).result).toMatch(/^Ok/);
        expect(solver.toData()).toEqual(snapshot);
        expect(solver.diagnose()).toEqual({ conflicting: [], redundant: [], dofs: initialDofs });
    } finally {
        solver.dispose();
    }
});

test("a vertical connector conflicting with an edited source retains the clear diagnostic", () => {
    const { solver, source, target } = fixture("conflict");
    try {
        const before = solver.entity(target);
        solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref(source, 1)], datums: [10, 4] });
        expect(solver.solve(true).result).toBe("Unsolved constraints");
        expect(solver.entity(target)).toEqual(before);
        expect([...solver.offsetErrors.values()]).toEqual([
            expect.stringMatching(/^Offset constraint \d+: connecting geometry conflicts/),
        ]);
    } finally {
        solver.dispose();
    }
});
