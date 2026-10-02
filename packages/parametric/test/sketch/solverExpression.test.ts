// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ANGLE_UNITS, type EvaluatedValue, LENGTH_UNITS, Plane, Result, type Scope } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { migrateAngleSides } from "../../src/angleMigration";
import {
    axisLineRefs,
    ConstraintKind,
    resolveDatumSource,
    SKETCH_X_AXIS_ID,
    toDatumSource,
    toStorageDatum,
} from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
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

    function legacyClockwiseData(datum: number | string, scope = scopeOf({ tilt: angle(30) })) {
        const { solver, line, id } = orientedLine(undefined, -30);
        try {
            expectOrientation(solver, line, -30);
            const data = solver.toData();
            const constraint = data.constraints.find((c) => c.id === id)!;
            constraint.datum = datum;
            delete constraint.angleSide;
            return { data: migrateAngleSides(data, scope), line, id };
        } finally {
            solver.dispose();
        }
    }

    test.each(["tilt", Math.PI / 6])("unchanged datum source %s keeps the migrated side", (datum) => {
        const { data, line, id } = legacyClockwiseData(datum);
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(30) }));
        try {
            expectOrientation(solver, line, -30);
            expect(solver.setDatumSource(id, typeof datum === "string" ? datum : 30).isOk).toBe(true);
            expectOrientation(solver, line, -30);
            expect(solver.toData().constraints.find((c) => c.id === id)?.angleSide).toBe(-1);
            expect(solver.datumValue(id)).toBeCloseTo(-Math.PI / 6, 6);
            if (typeof datum === "number") {
                solver.setDatum(id, datum);
                expectOrientation(solver, line, -30);
                expect(solver.toData().constraints.find((c) => c.id === id)?.angleSide).toBe(-1);
            }
            expect(solver.setDatumSource(id, typeof datum === "string" ? "tilt + 15" : 45).isOk).toBe(true);
            expectOrientation(solver, line, 45);
            expect(solver.toData().constraints.find((c) => c.id === id)?.angleSide).toBe(1);
        } finally {
            solver.dispose();
        }
    });

    test.each([
        Math.PI / 6,
        "tilt",
    ])("migrated positive datum %s preserves clockwise geometry and its marker", (datum) => {
        const { data, line, id } = legacyClockwiseData(datum);
        const stored = structuredClone(data);
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(30) }));
        let reloaded: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, -30);
            expect(data).toEqual(stored);
            expect(solver.setScope(scopeOf({ tilt: angle(30), unrelated: length(5) }))).toBe(false);
            expectOrientation(solver, line, -30);
            expect(solver.toData().constraints.find((c) => c.id === id)?.datum).toEqual(
                typeof datum === "string" ? datum : -Math.PI / 6,
            );
            // The migrated side is ordinary stored data and survives reloading.
            expect(solver.toData().constraints.find((c) => c.id === id)).toEqual({
                ...stored.constraints.find((c) => c.id === id),
                datum: typeof datum === "string" ? datum : -Math.PI / 6,
            });
            reloaded = new SketchSolver(Plane.XY, solver.toData(), scopeOf({ tilt: angle(30) }));
            expectOrientation(reloaded, line, -30);
            expect(solver.setScope(scopeOf({ tilt: angle(45) }))).toBe(typeof datum === "string");
            expectOrientation(solver, line, typeof datum === "string" ? -45 : -30);
            expect(solver.setScope(scopeOf({ tilt: angle(-20) }))).toBe(typeof datum === "string");
            expectOrientation(solver, line, typeof datum === "string" ? -20 : -30);
        } finally {
            reloaded?.dispose();
            solver.dispose();
        }
    });

    test.each(["tilt", "-tilt"])("signed negative expression %s follows the variable sign", (datum) => {
        const { solver, line } = orientedLine(toStorageDatum(ConstraintKind.Angle, 30), 30);
        let loaded: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, 30);
            const data = solver.toData();
            data.constraints.find((c) => c.kind === ConstraintKind.Angle)!.datum = datum;
            loaded = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(datum === "tilt" ? -30 : 30) }));
            expectOrientation(loaded, line, -30);
            expect(loaded.setScope(scopeOf({ tilt: angle(datum === "tilt" ? 20 : -20) }))).toBe(true);
            expectOrientation(loaded, line, 20);
        } finally {
            loaded?.dispose();
            solver.dispose();
        }
    });

    test("reset with a stale negative scope does not pin an expression to its restored side", () => {
        const { solver, line, id } = orientedLine(toStorageDatum(ConstraintKind.Angle, 30), 30);
        try {
            solver.setScope(scopeOf({ tilt: angle(30) }));
            expect(solver.setDatumSource(id, "tilt").isOk).toBe(true);
            expectOrientation(solver, line, 30);
            const at30 = solver.toData();
            expect(solver.setScope(scopeOf({ tilt: angle(-30) }))).toBe(true);
            expectOrientation(solver, line, -30);
            solver.reset(at30);
            expect(solver.setScope(scopeOf({ tilt: angle(30) }))).toBe(true);
            expectOrientation(solver, line, 30);
            expect(solver.setScope(scopeOf({ tilt: angle(-20) }))).toBe(true);
            expectOrientation(solver, line, -20);
        } finally {
            solver.dispose();
        }
    });

    test.each([
        [Math.PI / 6, "literal"],
        [Math.PI / 6, "source"],
        ["tilt", "literal"],
        ["tilt", "source"],
    ] as const)("explicit %s edit via %s clears the loaded side", (datum, method) => {
        const { data, line, id } = legacyClockwiseData(datum);
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(30) }));
        try {
            expectOrientation(solver, line, -30);
            for (const degrees of [-40, 20]) {
                if (method === "literal") {
                    solver.setDatum(id, toStorageDatum(ConstraintKind.Angle, degrees));
                } else {
                    expect(solver.setDatumSource(id, degrees < 0 ? "-tilt - 10" : "tilt - 10").isOk).toBe(
                        true,
                    );
                }
                expectOrientation(solver, line, degrees);
                expect(solver.toData().constraints.find((c) => c.id === id)?.angleSide).toBe(1);
                expect(solver.setScope(scopeOf({ tilt: angle(30), unrelated: length(5) }))).toBe(false);
                expectOrientation(solver, line, degrees);
            }
        } finally {
            solver.dispose();
        }
    });

    test.each([Math.PI / 6, "tilt"])("applyVariables preserves the stored side of %s", (datum) => {
        const { data, line, id } = legacyClockwiseData(datum);
        const document = new TestDocument({ application: createMockApplication() });
        const variables = [
            { id: "tilt", name: "tilt", type: "angle" as const, expression: "30" },
            { id: "unused", name: "unused", type: "length" as const, expression: "5" },
        ];
        document.variables.setItems(variables);
        const node = new SketchNode({ document, plane: Plane.XY, data });
        document.variables.setItems([variables[0], { ...variables[1], expression: "10" }]);
        node.applyVariables();
        const storedLine = node.data.entities.find((e) => e.id === line)!;
        expect(storedLine.params[3] - storedLine.params[1]).toBeCloseTo(-5, 6);
        expect(node.data.constraints.find((c) => c.id === id)?.datum).toBe(datum);
    });

    test.each(["tilt", "-tilt"])("fresh solver follows a sign-flipped variable in %s", (datum) => {
        const { solver, line, id } = orientedLine();
        let fresh: SketchSolver | undefined;
        try {
            solver.setScope(scopeOf({ tilt: angle(30) }));
            expect(solver.setDatumSource(id, datum).isOk).toBe(true);
            expectOrientation(solver, line, datum === "tilt" ? 30 : -30);
            fresh = new SketchSolver(Plane.XY, solver.toData(), scopeOf({ tilt: angle(-20) }));
            expectOrientation(fresh, line, datum === "tilt" ? -20 : 20);
            expect(fresh.toData().constraints.find((c) => c.id === id)?.datum).toBe(datum);
        } finally {
            fresh?.dispose();
            solver.dispose();
        }
    });

    test.each([
        ["fork", -40],
        ["fork", -30],
        ["reload", -40],
        ["reload", -30],
    ] as const)("%s before solve retains a %s degree literal edit", (method, degrees) => {
        const { solver, line, id } = orientedLine(toStorageDatum(ConstraintKind.Angle, 30));
        let fresh: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, 30);
            // Include equal magnitudes: negative literals cannot be legacy unsigned datums.
            solver.setDatum(id, toStorageDatum(ConstraintKind.Angle, degrees));
            fresh = method === "fork" ? solver.fork() : new SketchSolver(Plane.XY, solver.toData());
            expectOrientation(fresh, line, degrees);
        } finally {
            fresh?.dispose();
            solver.dispose();
        }
    });

    test("fork before solve retains the migrated expression marker after its magnitude changes", () => {
        const { data, line } = legacyClockwiseData("tilt");
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(30) }));
        let trial: SketchSolver | undefined;
        try {
            expect(solver.setScope(scopeOf({ tilt: angle(20) }))).toBe(true);
            trial = solver.fork();
            expectOrientation(trial, line, -20);
        } finally {
            trial?.dispose();
            solver.dispose();
        }
    });

    test("fork before solve preserves the side of an unchanged expression", () => {
        const { data, line, id } = legacyClockwiseData("tilt");
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(30) }));
        let trial: SketchSolver | undefined;
        try {
            expect(solver.setDatumSource(id, "tilt").isOk).toBe(true);
            trial = solver.fork();
            expectOrientation(trial, line, -30);
        } finally {
            trial?.dispose();
            solver.dispose();
        }
    });

    test("merged negative datum wins over another device's positive geometry", () => {
        const { solver, line, id } = orientedLine(toStorageDatum(ConstraintKind.Angle, 30));
        let loaded: SketchSolver | undefined;
        try {
            expectOrientation(solver, line, 30);
            const geometrySide = solver.toData();
            solver.setDatum(id, toStorageDatum(ConstraintKind.Angle, -40));
            const datumSide = solver.toData();
            const merged = { ...geometrySide, constraints: datumSide.constraints };
            loaded = new SketchSolver(Plane.XY, merged);
            expectOrientation(loaded, line, -40);
        } finally {
            loaded?.dispose();
            solver.dispose();
        }
    });

    test("signed zero expression follows a later positive variable", () => {
        const { data, line } = legacyClockwiseData("tilt", scopeOf({ tilt: angle(0) }));
        const solver = new SketchSolver(Plane.XY, data, scopeOf({ tilt: angle(0) }));
        try {
            expectOrientation(solver, line, 0);
            expect(solver.setScope(scopeOf({ tilt: angle(20) }))).toBe(true);
            expectOrientation(solver, line, 20);
        } finally {
            solver.dispose();
        }
    });

    test.each([-20, -30])("applyVariables follows tilt 30 -> %s through a fresh solver", (degrees) => {
        const { solver, line, id } = orientedLine();
        const application = createMockApplication();
        application.shapeProvider.factory.line = () => Result.err("No kernel in this test");
        rs.stubGlobal("app", application);
        const document = new TestDocument({ application });
        const variable = { id: "tilt", name: "tilt", type: "angle" as const, expression: "30" };
        try {
            document.variables.setItems([variable]);
            solver.setScope(document.variables.evaluate().scope);
            expect(solver.setDatumSource(id, "tilt").isOk).toBe(true);
            expectOrientation(solver, line, 30);
            const node = new SketchNode({ document, plane: Plane.XY, data: solver.toData() });
            document.variables.setItems([{ ...variable, expression: String(degrees) }]);
            node.applyVariables();
            const storedLine = node.data.entities.find((e) => e.id === line)!;
            expect(storedLine.params[3] - storedLine.params[1]).toBeCloseTo(
                10 * Math.sin((degrees * Math.PI) / 180),
                6,
            );
            expect(node.data.constraints.find((c) => c.id === id)?.datum).toBe("tilt");
            const session = node.createSolver();
            try {
                expectOrientation(session, line, degrees);
            } finally {
                session.dispose();
                node.dispose();
            }
        } finally {
            solver.dispose();
            document.dispose();
            rs.unstubAllGlobals();
        }
    });

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
