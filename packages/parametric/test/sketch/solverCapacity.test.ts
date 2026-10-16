// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * PlaneGCS runs in a fixed 16 MiB heap (#175): a system too large for it is refused before it can
 * abort the module, a failed native build leaves no deleted system behind, and a module that
 * aborted anyway is replaced by a fresh one.
 */

import type { GcsSystem } from "@salusoft89/planegcs/dist/planegcs_dist/gcs_system";
import { Plane } from "@spicy3d/core";
import type { BSplinePoint } from "../../src/sketch/bsplineGeometry";
import {
    ConstraintKind,
    initPlaneGcs,
    newSolverSystem,
    SOLVER_MEMORY_BUDGET,
    SolverCapacityError,
    type SolverSystem,
    solverBytes,
} from "../../src/sketch/planegcs";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

/** The six-point periodic B-spline of the issue. */
const PROBE: BSplinePoint[] = [
    [-60, 0],
    [-58, 0],
    [-57, 1],
    [-58, 2],
    [-60, 2],
    [-61, 1],
];

/** `count` points of an ellipse-like scan outline, in order. */
function outline(count: number): BSplinePoint[] {
    return Array.from({ length: count }, (_, i) => {
        const t = (2 * Math.PI * i) / count;
        return [50 * Math.cos(t), 30 * Math.sin(t)];
    });
}

function withSolver(run: (solver: SketchSolver) => void): void {
    const solver = new SketchSolver(Plane.XY);
    try {
        run(solver);
    } finally {
        solver.dispose();
    }
}

function solveProbe(): string {
    let result = "";
    withSolver((solver) => {
        expect(solver.addBSpline(PROBE, { periodic: true }).isOk).toBe(true);
        result = solver.solve(true).result;
    });
    return result;
}

/** The PlaneGCS module a solver system was created on. */
function moduleOf(system: SolverSystem): { GcsSystem: new () => GcsSystem } {
    return (system as unknown as { module: { GcsSystem: new () => GcsSystem } }).module;
}

describe("solver capacity", () => {
    test("the six-point periodic B-spline of the issue solves", () => {
        expect(solveProbe()).toBe("OkUnderconstrained");
    });

    test.each([
        ["periodic", true],
        ["open", false],
    ])("a %s B-spline of 400 scan points is refused, naming its size", (_, periodic) => {
        withSolver((solver) => {
            expect(solver.addBSpline(outline(400), { periodic }).isOk).toBe(true);
            let error: unknown;
            try {
                solver.solve(true);
            } catch (err) {
                error = err;
            }
            expect(error).toBeInstanceOf(SolverCapacityError);
            expect((error as Error).message).toMatch(/too large for the constraint solver: \d+ unknowns/);
            expect((error as Error).message).toMatch(/fewer points/);
        });
        // nothing was handed to the module: the next sketch is unaffected
        expect(solveProbe()).toBe("OkUnderconstrained");
    });

    test("a long chain of coincident lines is refused like a large B-spline", () => {
        withSolver((solver) => {
            let previous = solver.addLine(0, 0, 1, 0.3);
            for (let i = 1; i < 600; i++) {
                const line = solver.addLine(i, 0, i + 1, 0.3);
                solver.addConstraint({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [
                        { entityId: previous, pointIndex: 1 },
                        { entityId: line, pointIndex: 0 },
                    ],
                });
                previous = line;
            }
            expect(() => solver.solve(true)).toThrow(SolverCapacityError);
        });
    });

    test("a B-spline well inside the budget still solves", () => {
        withSolver((solver) => {
            expect(solver.addBSpline(outline(120), { periodic: true }).isOk).toBe(true);
            expect(solver.solve(true).result).toBe("OkUnderconstrained");
        });
    });

    test("the size estimate grows with unknowns, equations and curve terms", () => {
        const base = { unknowns: 100, equations: 50, curveTerms: 0 };
        expect(solverBytes(base)).toBeLessThan(SOLVER_MEMORY_BUDGET);
        expect(solverBytes({ ...base, unknowns: 200 })).toBeGreaterThan(solverBytes(base));
        expect(solverBytes({ ...base, equations: 100 })).toBeGreaterThan(solverBytes(base));
        expect(solverBytes({ ...base, curveTerms: 1000 })).toBeGreaterThan(solverBytes(base));
    });
});

describe("a failed native build", () => {
    test("leaves no deleted system behind: dispose and the next solve work", () => {
        const system = newSolverSystem();
        const module = moduleOf(system);
        const real = module.GcsSystem;
        let failing = true;
        // a GcsSystem whose first coincidence fails mid-build, as an abort in the native call would
        const Failing = new Proxy(real, {
            construct(target) {
                const native = new target();
                const add = native.add_constraint_p2p_coincident.bind(native);
                native.add_constraint_p2p_coincident = (...args) => {
                    if (failing) throw new Error("native build failed");
                    return add(...args);
                };
                return native;
            },
        });
        const params = system.add_params(new Uint8Array(4), new Float64Array([0, 0, 1, 1]));
        system.add_constraint(ConstraintKind.P2PCoincident, params, null, true, 0);
        module.GcsSystem = Failing;
        try {
            expect(() => system.solve(true)).toThrow("native build failed");
            // a second failure rebuilds again instead of reaching a deleted system
            expect(() => system.solve(true)).toThrow("native build failed");
            failing = false;
            expect(system.solve(true).result).toBe("OkUnderconstrained");
            const [x1, y1, x2, y2] = system.get_params(params);
            expect(x1).toBeCloseTo(x2, 9);
            expect(y1).toBeCloseTo(y2, 9);
        } finally {
            module.GcsSystem = real;
            system.free();
        }
        // freed twice: still no "instance already deleted"
        system.free();
    });
});

describe("an aborted module", () => {
    test("is replaced by a fresh one that new systems take", async () => {
        const before = newSolverSystem();
        const aborted = moduleOf(before);
        before.free();
        // abort the module the way the issue's session did: a system far too large, built natively
        const native = new aborted.GcsSystem();
        let abortError: unknown;
        try {
            const points = [];
            for (let i = 0; i < 1000; i++) {
                points.push(native.make_point(native.push_p_param(i, false), native.push_p_param(0, false)));
            }
            for (let i = 1; i < points.length; i++)
                native.add_constraint_p2p_coincident(points[i - 1], points[i], i, true, 1);
            native.solve_system(2);
        } catch (err) {
            abortError = err;
        }
        expect(String(abortError)).toMatch(/Aborted\(OOM\)/);

        await initPlaneGcs();
        const after = newSolverSystem();
        try {
            expect(moduleOf(after)).not.toBe(aborted);
        } finally {
            after.free();
        }
        expect(solveProbe()).toBe("OkUnderconstrained");
    });
});
