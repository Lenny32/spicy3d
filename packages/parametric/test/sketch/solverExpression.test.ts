// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ANGLE_UNITS, type EvaluatedValue, LENGTH_UNITS, Plane, type Scope } from "@spicy3d/core";
import {
    axisLineRefs,
    ConstraintKind,
    resolveDatumSource,
    SKETCH_X_AXIS_ID,
    toDatumSource,
    toStorageDatum,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const length = (value: number): EvaluatedValue => ({ value, unit: LENGTH_UNITS });
const angle = (value: number): EvaluatedValue => ({ value, unit: ANGLE_UNITS });
const scopeOf = (entries: Record<string, EvaluatedValue>): Scope => new Map(Object.entries(entries));

function distance(a: [number, number], b: [number, number]) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

const START = { entityId: 1, pointIndex: 0 };
const END = { entityId: 1, pointIndex: 1 };

/** A horizontal line of length 10 from the origin, dimensioned by `datum`. */
function dimensionedLine(scope: Scope, datum: number | string) {
    const solver = new SketchSolver(Plane.XY, undefined, scope);
    // entity ids are solver-owned; the line added first is the one the refs point at.
    const line = solver.addLine(0, 0, 10, 0);
    const id = solver.addConstraint({
        kind: ConstraintKind.P2PDistance,
        refs: [
            { entityId: line, pointIndex: 0 },
            { entityId: line, pointIndex: 1 },
        ],
        datum,
    });
    return { solver, refs: [START, END], id, line };
}

function measuredLength(solver: SketchSolver, line: number): number {
    return distance(
        solver.pointOf({ entityId: line, pointIndex: 0 }),
        solver.pointOf({ entityId: line, pointIndex: 1 }),
    );
}

describe("datum unit conversion", () => {
    test("a literal input is converted into storage units right away", () => {
        expect(toDatumSource(ConstraintKind.Angle, 90)).toBeCloseTo(Math.PI / 2);
        expect(toDatumSource(ConstraintKind.P2LDistance, 5)).toBe(-5);
        expect(toDatumSource(ConstraintKind.P2PDistance, 5)).toBe(5);
    });

    test("an expression is stored verbatim and only converted after it resolves", () => {
        expect(toDatumSource(ConstraintKind.Angle, "a")).toBe("a");
        const resolved = resolveDatumSource(ConstraintKind.Angle, "a", scopeOf({ a: angle(90) })).unchecked();
        expect(resolved).toBeCloseTo(Math.PI / 2);
    });

    test("a stored literal passes through untouched — old documents change not at all", () => {
        const stored = toStorageDatum(ConstraintKind.P2LDistance, 7);
        expect(stored).toBe(-7);
        expect(resolveDatumSource(ConstraintKind.P2LDistance, stored, scopeOf({})).unchecked()).toBe(-7);
    });

    test("an expression of the wrong unit is rejected", () => {
        const result = resolveDatumSource(ConstraintKind.Angle, "w", scopeOf({ w: length(5) }));
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("Dimension mismatch: expected angle, got length");
    });
});

describe("SketchSolver expression datums", () => {
    test("a datum written as an expression resolves against the scope", () => {
        const { solver, line } = dimensionedLine(scopeOf({ w: length(20) }), "w / 2");
        solver.solve(true);
        expect(measuredLength(solver, line)).toBeCloseTo(10);
    });

    test("the expression is persisted verbatim, not its current value", () => {
        const { solver, id } = dimensionedLine(scopeOf({ w: length(20) }), "w / 2");
        solver.solve(true);
        // A literal is read back from the solver (that is where normalization lands); an
        // expression must survive the round trip or every commit would erase it.
        const constraint = solver.toData().constraints.find((x) => x.id === id);
        expect(constraint?.datum).toBe("w / 2");
    });

    test("a literal datum is still read back from the solver", () => {
        const { solver, id } = dimensionedLine(scopeOf({}), 10);
        solver.solve(true);
        const constraint = solver.toData().constraints.find((x) => x.id === id);
        expect(constraint?.datum).toBeCloseTo(10);
    });

    test("loads a document whose datums are plain numbers", () => {
        const solver = new SketchSolver(
            Plane.XY,
            {
                entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
                constraints: [
                    {
                        id: 2,
                        kind: ConstraintKind.P2PDistance,
                        refs: [START, END],
                        datum: 5,
                    },
                ],
            },
            scopeOf({}),
        );
        expect(solver.datumErrors.size).toBe(0);
        expect(measuredLength(solver, 1)).toBeCloseTo(5);
    });

    test("an expression that resolves against nothing is reported and keeps the geometry", () => {
        const { solver, id, line } = dimensionedLine(scopeOf({}), "nope");
        solver.solve(true);
        expect(solver.datumErrors.get(id)).toBe("Unknown identifier: nope");
        // The sketch stays usable: the dimension falls back to the measured geometry.
        expect(measuredLength(solver, line)).toBeCloseTo(10);
    });

    test("an expression of the wrong unit is reported too", () => {
        const { solver, id } = dimensionedLine(scopeOf({ a: angle(30) }), "a");
        solver.solve(true);
        expect(solver.datumErrors.get(id)).toBe("Dimension mismatch: expected length, got angle");
    });

    test("setScope re-drives the datums, and reports whether anything moved", () => {
        const { solver, line } = dimensionedLine(scopeOf({ w: length(20) }), "w");
        solver.solve(true);
        expect(measuredLength(solver, line)).toBeCloseTo(20);

        expect(solver.setScope(scopeOf({ w: length(40) }))).toBe(true);
        solver.solve(true);
        expect(measuredLength(solver, line)).toBeCloseTo(40);

        expect(solver.setScope(scopeOf({ w: length(40) }))).toBe(false);
    });

    test("setScope re-reports an unresolvable datum", () => {
        const { solver, id } = dimensionedLine(scopeOf({ w: length(20) }), "w * 2");
        solver.solve(true);
        expect(solver.datumErrors.size).toBe(0);

        solver.setScope(scopeOf({}));
        expect(solver.datumErrors.get(id)).toBe("Unknown identifier: w");
    });

    test("setDatumSource stores what the user typed and pushes its value", () => {
        const { solver, line, id } = dimensionedLine(scopeOf({ w: length(15) }), 10);
        solver.solve(true);

        const result = solver.setDatumSource(id, "w * 2");
        expect(result.isOk).toBe(true);
        solver.solve(true);
        expect(measuredLength(solver, line)).toBeCloseTo(30);
        expect(solver.toData().constraints.find((x) => x.id === id)?.datum).toBe("w * 2");
    });

    test("setDatumSource rejects an unresolvable input without touching the datum", () => {
        const { solver, line, id } = dimensionedLine(scopeOf({}), 10);
        solver.solve(true);

        const result = solver.setDatumSource(id, "nope");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("Unknown identifier: nope");
        expect(solver.toData().constraints.find((x) => x.id === id)?.datum).toBeCloseTo(10);
        expect(measuredLength(solver, line)).toBeCloseTo(10);
    });
});

describe("signed Angle datums", () => {
    function orientedLine(datum?: number | string, degrees = 0, reversed = false) {
        const solver = new SketchSolver(Plane.XY, undefined, scopeOf({ pcb_angle: angle(-30.5) }));
        const radians = (degrees * Math.PI) / 180;
        const line = solver.addLine(100, 0, 100 + 10 * Math.cos(radians), 10 * Math.sin(radians));
        const start = { entityId: line, pointIndex: 0 };
        const end = { entityId: line, pointIndex: 1 };
        solver.addConstraint({ kind: ConstraintKind.Fix, refs: [start], datums: [100, 0] });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 });
        const refs = [...axisLineRefs(SKETCH_X_AXIS_ID), start, end];
        const id = solver.addConstraint({
            kind: ConstraintKind.Angle,
            refs: reversed ? [...refs.slice(2), ...refs.slice(0, 2)] : refs,
            ...(datum === undefined ? {} : { datum }),
        });
        return { solver, line, id };
    }

    function expectOrientation(solver: SketchSolver, line: number, degrees: number) {
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const [x1, y1] = solver.pointOf({ entityId: line, pointIndex: 0 });
        const [x2, y2] = solver.pointOf({ entityId: line, pointIndex: 1 });
        const radians = (degrees * Math.PI) / 180;
        expect(x1).toBeCloseTo(100, 6);
        expect(y1).toBeCloseTo(0, 6);
        expect(x2 - x1).toBeCloseTo(10 * Math.cos(radians), 6);
        expect(y2 - y1).toBeCloseTo(10 * Math.sin(radians), 6);
    }

    test.each([
        -180, -120, -40, 0, 40, 120, 180,
    ])("literal %s degrees drives orientation through reload", (degrees) => {
        const datum = toStorageDatum(ConstraintKind.Angle, degrees);
        // Avoid starting exactly opposite the target at the solver's 180° singularity.
        const { solver, line, id } = orientedLine(datum, Math.abs(degrees) === 180 ? 170 : 0);
        let loaded: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, degrees);
            const data = solver.toData();
            expect(data.constraints.find((c) => c.id === id)?.datum).toBeCloseTo(datum, 9);
            loaded = new SketchSolver(Plane.XY, data);
            expectOrientation(loaded, line, degrees);
            expect(loaded.toData().constraints.find((c) => c.id === id)?.datum).toBeCloseTo(datum, 9);
        } finally {
            loaded?.dispose();
            solver.dispose();
        }
    });

    test("setDatum changes sides instead of inheriting the old geometry's sign", () => {
        const { solver, line, id } = orientedLine(toStorageDatum(ConstraintKind.Angle, 20));
        try {
            expectOrientation(solver, line, 20);
            solver.setDatum(id, toStorageDatum(ConstraintKind.Angle, -40));
            expectOrientation(solver, line, -40);
            expect(solver.toData().constraints.find((c) => c.id === id)?.datum).toBeCloseTo(
                (-40 * Math.PI) / 180,
            );
            solver.setDatum(id, toStorageDatum(ConstraintKind.Angle, 14.5));
            expectOrientation(solver, line, 14.5);
        } finally {
            solver.dispose();
        }
    });

    test("expression edits and variable changes retain their signed orientation", () => {
        const { solver, line, id } = orientedLine("pcb_angle");
        let loaded: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, -30.5);
            expect(solver.setDatumSource(id, "pcb_angle + 45").isOk).toBe(true);
            expectOrientation(solver, line, 14.5);
            expect(solver.toData().constraints.find((c) => c.id === id)?.datum).toBe("pcb_angle + 45");
            expect(solver.setScope(scopeOf({ pcb_angle: angle(-60) }))).toBe(true);
            expectOrientation(solver, line, -15);
            loaded = new SketchSolver(Plane.XY, solver.toData(), scopeOf({ pcb_angle: angle(-60) }));
            expectOrientation(loaded, line, -15);
            expect(loaded.toData().constraints.find((c) => c.id === id)?.datum).toBe("pcb_angle + 45");
        } finally {
            loaded?.dispose();
            solver.dispose();
        }
    });

    test("omitting the datum retains the measured clockwise sweep", () => {
        const { solver, line, id } = orientedLine(undefined, -30.5);
        try {
            expectOrientation(solver, line, -30.5);
            expect(solver.toData().constraints.find((c) => c.id === id)?.datum).toBeCloseTo(
                (-30.5 * Math.PI) / 180,
            );
        } finally {
            solver.dispose();
        }
    });

    test("reversing entity order reverses the signed sweep", () => {
        const { solver, line } = orientedLine(toStorageDatum(ConstraintKind.Angle, 40), 0, true);
        try {
            expectOrientation(solver, line, -40);
        } finally {
            solver.dispose();
        }
    });
});
