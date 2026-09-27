// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Circle, GcsSystem, Line, Point } from "@salusoft89/planegcs/dist/planegcs_dist/gcs_system";
import initPlaneGcsModule from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.js";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm";

/**
 * The sketch constraint kinds. The numeric values are persisted in sketch data, so
 * they are fixed forever — never renumber, only append.
 *
 * Each kind takes a flat list of param ids, in the layout noted on the member; a
 * kind with a datum carries its datum param id(s) last.
 */
export enum ConstraintKind {
    /** p1.x, p1.y, p2.x, p2.y */
    P2PCoincident = 0,
    /** p1.x, p1.y, p2.x, p2.y, distance */
    P2PDistance = 1,
    /** a, b */
    Equal = 2,
    /** p.x, p.y, l1.x, l1.y, l2.x, l2.y */
    PointOnLine = 3,
    /** p1.x, p1.y, p2.x, p2.y */
    Horizontal = 4,
    /** p1.x, p1.y, p2.x, p2.y */
    Vertical = 5,
    /** l1.p1, l1.p2, l2.p1, l2.p2, each (x, y) */
    Parallel = 6,
    /** l1.p1, l1.p2, l2.p1, l2.p2, each (x, y) */
    Perpendicular = 7,
    /** p.x, p.y, l1.x, l1.y, l2.x, l2.y, distance (signed: positive right of l1→l2) */
    P2LDistance = 8,
    /** l1.p1, l1.p2, l2.p1, l2.p2, each (x, y), angle (radians, signed from line 1 to line 2) */
    Angle = 9,
    /** rad, radius */
    Radius = 10,
    /** l1.p1, l1.p2, l2.p1, l2.p2, each (x, y) */
    EqualLength = 11,
    /** r1, r2 */
    EqualRadius = 12,
    /** p.x, p.y, c.x, c.y, rad */
    PointOnCircle = 13,
    /** p.x, p.y, l1.x, l1.y, l2.x, l2.y */
    Midpoint = 14,
    /** p1.x, p1.y, p2.x, p2.y, l1.x, l1.y, l2.x, l2.y */
    Symmetric = 15,
    /** l1.x, l1.y, l2.x, l2.y, c.x, c.y, rad */
    TangentLineCircle = 16,
    /** c1.x, c1.y, r1, c2.x, c2.y, r2 */
    TangentCircleCircle = 17,
    /** p1.x, p1.y, p2.x, p2.y, distance (p2.x − p1.x) */
    HorizontalDistance = 18,
    /** p1.x, p1.y, p2.x, p2.y, distance (p2.y − p1.y) */
    VerticalDistance = 19,
    /** p1.x, p1.y, p2.x, p2.y (same y) */
    HorizontalAlign = 20,
    /** p1.x, p1.y, p2.x, p2.y (same x) */
    VerticalAlign = 21,
    /** p.x, p.y, X0, Y0 */
    Fix = 22,
    /** p.x, p.y, c.x, c.y, s.x, s.y (an arc is its center c and start s; r = ‖s − c‖) */
    PointOnArc = 23,
    /** c1.x, c1.y, s1.x, s1.y, c2.x, c2.y, s2.x, s2.y */
    EqualArcRadius = 24,
    /** l1.x, l1.y, l2.x, l2.y, c.x, c.y, s.x, s.y */
    TangentLineArc = 25,
    /** c1.x, c1.y, s1.x, s1.y, c2.x, c2.y, s2.x, s2.y */
    TangentArcArc = 26,
    /** c.x, c.y, rad, a.c.x, a.c.y, a.s.x, a.s.y */
    TangentCircleArc = 27,
    /** Two baseline points followed by points on their common line. */
    Collinear = 28,
    /** Entity parameters followed by their frozen values (variable layout). */
    Block = 29,
    /** Four directed lines, sharing the angle between each pair. */
    EqualAngle = 30,
    /** Two segments and a positive ratio: length(first) = ratio * length(second). */
    Scale = 31,
}

/** Param count and trailing datum count of every kind. */
const LAYOUT: Record<ConstraintKind, { params: number; datums: number }> = {
    [ConstraintKind.Collinear]: { params: 0, datums: 0 },
    [ConstraintKind.Block]: { params: 0, datums: 0 },
    [ConstraintKind.EqualAngle]: { params: 16, datums: 0 },
    [ConstraintKind.Scale]: { params: 9, datums: 1 },
    [ConstraintKind.P2PCoincident]: { params: 4, datums: 0 },
    [ConstraintKind.P2PDistance]: { params: 5, datums: 1 },
    [ConstraintKind.Equal]: { params: 2, datums: 0 },
    [ConstraintKind.PointOnLine]: { params: 6, datums: 0 },
    [ConstraintKind.Horizontal]: { params: 4, datums: 0 },
    [ConstraintKind.Vertical]: { params: 4, datums: 0 },
    [ConstraintKind.Parallel]: { params: 8, datums: 0 },
    [ConstraintKind.Perpendicular]: { params: 8, datums: 0 },
    [ConstraintKind.P2LDistance]: { params: 7, datums: 1 },
    [ConstraintKind.Angle]: { params: 9, datums: 1 },
    [ConstraintKind.Radius]: { params: 2, datums: 1 },
    [ConstraintKind.EqualLength]: { params: 8, datums: 0 },
    [ConstraintKind.EqualRadius]: { params: 2, datums: 0 },
    [ConstraintKind.PointOnCircle]: { params: 5, datums: 0 },
    [ConstraintKind.Midpoint]: { params: 6, datums: 0 },
    [ConstraintKind.Symmetric]: { params: 8, datums: 0 },
    [ConstraintKind.TangentLineCircle]: { params: 7, datums: 0 },
    [ConstraintKind.TangentCircleCircle]: { params: 6, datums: 0 },
    [ConstraintKind.HorizontalDistance]: { params: 5, datums: 1 },
    [ConstraintKind.VerticalDistance]: { params: 5, datums: 1 },
    [ConstraintKind.HorizontalAlign]: { params: 4, datums: 0 },
    [ConstraintKind.VerticalAlign]: { params: 4, datums: 0 },
    [ConstraintKind.Fix]: { params: 4, datums: 2 },
    [ConstraintKind.PointOnArc]: { params: 6, datums: 0 },
    [ConstraintKind.EqualArcRadius]: { params: 8, datums: 0 },
    [ConstraintKind.TangentLineArc]: { params: 8, datums: 0 },
    [ConstraintKind.TangentArcArc]: { params: 8, datums: 0 },
    [ConstraintKind.TangentCircleArc]: { params: 7, datums: 0 },
};

/** The kinds that take a tangency branch: 1 = external / positive, −1 = internal / negative. */
const TANGENT_KINDS: ReadonlySet<ConstraintKind> = new Set([
    ConstraintKind.TangentLineCircle,
    ConstraintKind.TangentCircleCircle,
    ConstraintKind.TangentLineArc,
    ConstraintKind.TangentArcArc,
    ConstraintKind.TangentCircleArc,
]);

/** Below this magnitude a signed point-line distance is solved as plain incidence. */
const ZERO_DISTANCE = 1e-9;

/** PlaneGCS algorithm ids (see `Algorithm` in @salusoft89/planegcs). */
const DOG_LEG = 2;
/** PlaneGCS solve status ids (see `SolveStatus` in @salusoft89/planegcs). */
const STATUS_SUCCESS = 0;
const STATUS_CONVERGED = 1;

/** Iteration cap for a coarse (per drag frame) solve; a fine solve uses the PlaneGCS default. */
const COARSE_MAX_ITERATIONS = 20;

export type SolveResult = "Ok" | "OkUnderconstrained" | "Conflicting" | "Diverged";

export interface SolveReport {
    result: SolveResult;
}

export interface SolverDiagnosis {
    conflicting: number[];
    redundant: number[];
    dofs: number;
}

interface ModuleStatic {
    GcsSystem: new () => GcsSystem;
}

interface ConstraintRecord {
    readonly kind: ConstraintKind;
    readonly params: readonly number[];
    /** Resolved tangency branch (tangent kinds only). */
    readonly internal: boolean;
    /** Solver-only params this constraint owns (foot points, arc radii); removed with it. */
    readonly hidden: readonly number[];
}

let planeGcs: ModuleStatic | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Initializes the PlaneGCS WASM module. Safe to call more than once: later calls
 * reuse the first initialization. In the browser the bundled wasm asset is fetched;
 * node tests pass the wasm bytes.
 */
export function initPlaneGcs(wasmBinary?: BufferSource): Promise<void> {
    if (planeGcs !== undefined) return Promise.resolve();
    const options = wasmBinary !== undefined ? { wasmBinary } : { locateFile: () => wasmUrl };
    initPromise ??= (initPlaneGcsModule as (options: object) => Promise<ModuleStatic>)(options).then(
        (module) => {
            planeGcs = module;
        },
    );
    return initPromise;
}

export function isPlaneGcsInitialized(): boolean {
    return planeGcs !== undefined;
}

/** Creates a fresh solver system. Throws when the WASM module is not initialized yet. */
export function newSolverSystem(): SolverSystem {
    if (planeGcs === undefined) {
        throw new Error("PlaneGCS is not initialized. Await initPlaneGcs() first.");
    }
    return new SolverSystem(planeGcs);
}

/**
 * An incremental constraint system on top of PlaneGCS.
 *
 * Callers work with stable param and constraint ids: params are created, written and
 * read by id, constraints reference params by id, and both can be removed. PlaneGCS
 * itself is a batch solver without removal, so the native system is rebuilt from this
 * model whenever its structure changes (a param or constraint added or removed) and
 * reused for value-only changes, which keeps drag frames cheap.
 *
 * Datum params (the trailing params of a datum kind) are inputs: they are fixed in the
 * native system and only ever written from outside. Dragged params are fixed for the
 * duration of a drag so the rest of the sketch follows them.
 *
 * Method names follow the solver API this replaced, which `SketchSolver` is written
 * against.
 */
export class SolverSystem {
    private readonly values: number[] = [];
    private readonly alive: boolean[] = [];
    private readonly constraints: (ConstraintRecord | undefined)[] = [];
    private readonly dragged = new Set<number>();

    private native: GcsSystem | undefined;
    /** Native param index of every live param, valid while `native` is current. */
    private nativeIndex: number[] = [];
    /** Params the native system treats as fixed inputs (datums). */
    private datumParams = new Set<number>();
    /** Datum params whose value shapes the native constraints; writing one forces a rebuild. */
    private structuralDatums = new Set<number>();
    private dirty = true;
    private cachedDofs: number | undefined;

    constructor(private readonly module: ModuleStatic) {}

    // ------------------------------------------------------------------ Params

    /** Creates params; `kinds` is accepted for layout compatibility and not used. Returns their ids. */
    add_params(_kinds: Uint8Array, values: Float64Array): Uint32Array {
        const ids = new Uint32Array(values.length);
        for (let i = 0; i < values.length; i++) {
            ids[i] = this.pushParam(values[i]);
        }
        this.invalidate();
        return ids;
    }

    get_params(ids: Uint32Array): Float64Array {
        const out = new Float64Array(ids.length);
        for (let i = 0; i < ids.length; i++) {
            this.assertParam(ids[i]);
            out[i] = this.values[ids[i]];
        }
        return out;
    }

    set_param(id: number, value: number): void {
        this.assertParam(id);
        this.values[id] = value;
        if (this.structuralDatums.has(id)) {
            this.invalidate();
        } else if (!this.dirty && this.native !== undefined) {
            this.native.set_p_param(this.nativeIndex[id], value, this.isFixed(id));
        }
    }

    /** Removes a param. A param still referenced by a live constraint cannot be removed. */
    remove_param(id: number): void {
        this.assertParam(id);
        for (const record of this.constraints) {
            if (record?.params.includes(id)) {
                throw new Error(`ParamInUse: param ${id} is referenced by a constraint`);
            }
        }
        this.alive[id] = false;
        this.dragged.delete(id);
        this.invalidate();
    }

    // ------------------------------------------------------------------ Constraints

    /**
     * Adds a constraint over `params` (layout per `ConstraintKind`). When `datum` is
     * given, a datum param holding it is created and appended — single-datum kinds
     * only; otherwise `params` must already end with the datum param id(s).
     *
     * `driving` must be true: every datum is an input. `tag` is accepted for layout
     * compatibility. `branch` selects the tangency branch of a tangent kind (1 =
     * external / positive side, −1 = internal / negative side); when omitted it is
     * detected from the current geometry. Returns the constraint id.
     */
    add_constraint(
        kind: ConstraintKind,
        params: Uint32Array,
        datum: number | null | undefined,
        driving: boolean,
        _tag: number,
        branch?: number | null,
    ): number {
        const layout = LAYOUT[kind];
        if (layout === undefined) throw new Error(`Unknown constraint kind: ${kind}`);
        if (!driving) throw new Error("Reference (non-driving) constraints are not supported");
        const ids = Array.from(params);
        if (datum !== null && datum !== undefined) {
            if (layout.datums !== 1) throw new Error(`Constraint kind ${kind} does not take a datum value`);
            ids.push(this.pushParam(datum));
        }
        if (kind === ConstraintKind.Collinear && (ids.length < 6 || ids.length % 2 !== 0)) {
            throw new Error("Collinear requires at least three points");
        }
        if (kind === ConstraintKind.Block && (ids.length < 4 || ids.length % 2 !== 0)) {
            throw new Error("Block requires parameters and matching frozen values");
        }
        if (layout.params !== 0 && ids.length !== layout.params) {
            throw new Error(`Constraint kind ${kind} takes ${layout.params} params, got ${ids.length}`);
        }
        for (const id of ids) this.assertParam(id);
        if (branch !== null && branch !== undefined) {
            if (!TANGENT_KINDS.has(kind)) throw new Error(`Constraint kind ${kind} takes no branch`);
            if (branch !== 1 && branch !== -1) throw new Error(`Invalid tangency branch: ${branch}`);
        }

        const internal = TANGENT_KINDS.has(kind) ? this.resolveInternal(kind, ids, branch) : false;
        const hidden = this.createHiddenParams(kind, ids);
        this.constraints.push({ kind, params: ids, internal, hidden });
        this.invalidate();
        return this.constraints.length - 1;
    }

    /** Removes a constraint; its id is never reused. */
    remove_constraint(id: number): void {
        const record = this.constraints[id];
        if (record === undefined) throw new Error(`UnknownConstraint: ${id}`);
        for (const hiddenId of record.hidden) this.alive[hiddenId] = false;
        this.constraints[id] = undefined;
        this.invalidate();
    }

    // ------------------------------------------------------------------ Dragging

    /** Pins `ids` at their current values (set them to the cursor first) until `clear_dragged`. */
    mark_dragged(ids: Uint32Array): void {
        for (const id of ids) {
            this.assertParam(id);
            this.dragged.add(id);
        }
        this.applyDragged(true);
    }

    /** Releases every dragged param (the whole dragged set, whatever `ids` holds). */
    clear_dragged(ids: Uint32Array): void {
        for (const id of ids) this.assertParam(id);
        this.applyDragged(false);
        this.dragged.clear();
    }

    // ------------------------------------------------------------------ Solving

    /** Solves the system; `fine` is a full solve, otherwise a capped one for drag frames. */
    solve(fine: boolean): SolveReport {
        const native = this.ensureBuilt();
        native.set_max_iterations(fine ? this.defaultMaxIterations : COARSE_MAX_ITERATIONS);
        let status = native.solve_system(DOG_LEG);
        if (!isSolved(status) && this.dragged.size > 0) {
            // the dragged position may be off the geometry's reach (a point held on a
            // line, say): let the dragged params follow the constraints instead
            this.pushValues(native);
            this.applyDragged(false);
            status = native.solve_system(DOG_LEG);
            if (isSolved(status)) this.applySolution(native, true);
            this.applyDragged(true);
        } else if (isSolved(status)) {
            this.applySolution(native);
        }
        // an unapplied solve may leave its iterate behind in the native params
        if (!isSolved(status)) this.pushValues(native);
        this.cachedDofs = native.dof();
        return { result: this.resultOf(native, status) };
    }

    /** Degrees of freedom of the whole system (dragged params count as free). */
    dofs(): number {
        if (this.cachedDofs === undefined || this.dirty) {
            const native = this.ensureBuilt();
            native.solve_system(DOG_LEG);
            this.cachedDofs = native.dof();
            this.pushValues(native);
        }
        return this.cachedDofs;
    }

    /** Conflicting and redundant constraint ids, and the DOF count, as of a fresh solve. */
    diagnose(): SolverDiagnosis {
        const native = this.ensureBuilt();
        native.solve_system(DOG_LEG);
        const diagnosis = {
            conflicting: this.constraintIdsOf(native.get_conflicting()),
            redundant: this.constraintIdsOf(native.get_redundant()),
            dofs: native.dof(),
        };
        this.pushValues(native);
        return diagnosis;
    }

    free(): void {
        this.native?.delete();
        this.native = undefined;
        this.dirty = true;
    }

    // ------------------------------------------------------------------ Model helpers

    private pushParam(value: number): number {
        this.values.push(value);
        this.alive.push(true);
        return this.values.length - 1;
    }

    private assertParam(id: number): void {
        if (!this.alive[id]) throw new Error(`UnknownParam: ${id}`);
    }

    private invalidate(): void {
        this.dirty = true;
        this.cachedDofs = undefined;
    }

    private isFixed(id: number): boolean {
        return this.datumParams.has(id) || this.dragged.has(id);
    }

    private point(ids: readonly number[], at: number): [number, number] {
        return [this.values[ids[at]], this.values[ids[at + 1]]];
    }

    /** Resolves a tangency branch: explicit, or whichever the current geometry is closer to. */
    private resolveInternal(kind: ConstraintKind, ids: number[], branch?: number | null): boolean {
        if (branch === 1) return false;
        if (branch === -1) return true;
        const circles = this.tangentCircles(kind, ids);
        if (circles === undefined) return false; // line tangencies take their side from the geometry
        const [[c1x, c1y, r1], [c2x, c2y, r2]] = circles;
        const d = Math.hypot(c2x - c1x, c2y - c1y);
        return Math.abs(d - Math.abs(r1 - r2)) < Math.abs(d - (r1 + r2));
    }

    /** Center and radius of both curves of a circle/arc tangency, from current values. */
    private tangentCircles(kind: ConstraintKind, ids: number[]): [number, number, number][] | undefined {
        const v = (i: number) => this.values[ids[i]];
        const arc = (i: number): [number, number, number] => [
            v(i),
            v(i + 1),
            Math.hypot(v(i + 2) - v(i), v(i + 3) - v(i + 1)),
        ];
        switch (kind) {
            case ConstraintKind.TangentCircleCircle:
                return [
                    [v(0), v(1), v(2)],
                    [v(3), v(4), v(5)],
                ];
            case ConstraintKind.TangentArcArc:
                return [arc(0), arc(4)];
            case ConstraintKind.TangentCircleArc:
                return [[v(0), v(1), v(2)], arc(3)];
            default:
                return undefined;
        }
    }

    /**
     * The solver-only params a constraint needs: the radius of each arc it treats as a
     * circle, or the foot point of a signed point-line distance.
     */
    private createHiddenParams(kind: ConstraintKind, ids: number[]): number[] {
        const radius = (at: number) => {
            const [cx, cy] = this.point(ids, at);
            const [sx, sy] = this.point(ids, at + 2);
            return this.pushParam(Math.hypot(sx - cx, sy - cy));
        };
        switch (kind) {
            case ConstraintKind.EqualAngle: {
                const [ax, ay] = this.point(ids, 0);
                const [bx, by] = this.point(ids, 2);
                const [cx, cy] = this.point(ids, 4);
                const [dx, dy] = this.point(ids, 6);
                return [this.pushParam(Math.atan2(dy - cy, dx - cx) - Math.atan2(by - ay, bx - ax))];
            }
            case ConstraintKind.Scale:
                return [radius(0), radius(4)];
            case ConstraintKind.TangentLineArc:
                return [radius(4)];
            case ConstraintKind.TangentArcArc:
                return [radius(0), radius(4)];
            case ConstraintKind.TangentCircleArc:
                return [radius(3)];
            case ConstraintKind.P2LDistance: {
                const [px, py] = this.point(ids, 0);
                const [x1, y1] = this.point(ids, 2);
                const [x2, y2] = this.point(ids, 4);
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lengthSq = dx * dx + dy * dy;
                const t = lengthSq < 1e-24 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
                return [this.pushParam(x1 + t * dx), this.pushParam(y1 + t * dy)];
            }
            default:
                return [];
        }
    }

    private constraintIdsOf(tags: { size(): number; get(i: number): number; delete(): void }): number[] {
        const ids: number[] = [];
        for (let i = 0; i < tags.size(); i++) {
            const id = tags.get(i) - 1;
            if (!ids.includes(id)) ids.push(id);
        }
        tags.delete();
        return ids;
    }

    private resultOf(native: GcsSystem, status: number): SolveResult {
        if (native.has_conflicting()) return "Conflicting";
        if (!isSolved(status)) return "Diverged";
        return (this.cachedDofs ?? 0) > 0 ? "OkUnderconstrained" : "Ok";
    }

    // ------------------------------------------------------------------ Native system

    private defaultMaxIterations = 100;

    private ensureBuilt(): GcsSystem {
        if (!this.dirty && this.native !== undefined) return this.native;
        this.native?.delete();
        const native = new this.module.GcsSystem();
        native.set_debug_mode(0);
        this.defaultMaxIterations = native.get_max_iterations();

        this.datumParams = new Set();
        this.structuralDatums = new Set();
        for (const record of this.constraints) {
            if (record === undefined) continue;
            const datums =
                record.kind === ConstraintKind.Block ? record.params.length / 2 : LAYOUT[record.kind].datums;
            for (let i = record.params.length - datums; i < record.params.length; i++) {
                this.datumParams.add(record.params[i]);
            }
            if (record.kind === ConstraintKind.P2LDistance) this.structuralDatums.add(record.params[6]);
            if (record.kind === ConstraintKind.Scale) this.structuralDatums.add(record.params[8]);
        }

        this.nativeIndex = [];
        for (let id = 0; id < this.values.length; id++) {
            if (!this.alive[id]) continue;
            // datums are fixed from the start; dragged params are toggled below so the
            // native DOF count keeps treating them as free
            this.nativeIndex[id] = native.push_p_param(this.values[id], this.datumParams.has(id));
        }
        this.constraints.forEach((record, id) => {
            if (record !== undefined) new NativeConstraintBuilder(native, this, record, id + 1).emit();
        });

        this.native = native;
        this.dirty = false;
        this.applyDragged(this.dragged.size > 0);
        return native;
    }

    /** Toggles the fixed flag of every dragged param in the current native system. */
    private applyDragged(fixed: boolean): void {
        if (this.dirty || this.native === undefined) return;
        for (const id of this.dragged) {
            this.native.set_p_param(this.nativeIndex[id], this.values[id], fixed || this.datumParams.has(id));
        }
    }

    /** Copies solved values of the free params (dragged ones too when released) back into the model. */
    private applySolution(native: GcsSystem, includeDragged = false): void {
        native.apply_solution();
        for (let id = 0; id < this.values.length; id++) {
            if (!this.alive[id] || this.datumParams.has(id)) continue;
            if (!includeDragged && this.dragged.has(id)) continue;
            this.values[id] = native.get_p_param(this.nativeIndex[id]);
        }
    }

    /** Rewrites the model values into the native system, undoing a solve that was not applied. */
    private pushValues(native: GcsSystem): void {
        for (let id = 0; id < this.values.length; id++) {
            if (this.alive[id]) native.set_p_param(this.nativeIndex[id], this.values[id], this.isFixed(id));
        }
    }

    /** @internal Native index of a live param. */
    indexOf(id: number): number {
        return this.nativeIndex[id];
    }

    /** @internal Current value of a param. */
    valueOf(id: number): number {
        return this.values[id];
    }
}

function isSolved(status: number): boolean {
    return status === STATUS_SUCCESS || status === STATUS_CONVERGED;
}

/**
 * Emits one constraint record as PlaneGCS constraints. Every native constraint of a
 * record carries the same tag (constraint id + 1), so diagnostics map back to it.
 */
class NativeConstraintBuilder {
    private readonly shapes: { delete(): void }[] = [];

    constructor(
        private readonly native: GcsSystem,
        private readonly system: SolverSystem,
        private readonly record: ConstraintRecord,
        private readonly tag: number,
    ) {}

    emit(): void {
        try {
            this.emitKind();
        } finally {
            for (const shape of this.shapes) shape.delete();
        }
    }

    /** Native index of the record param at `at`. */
    private p(at: number): number {
        return this.system.indexOf(this.record.params[at]);
    }

    /** Native index of the hidden param at `at`. */
    private h(at: number): number {
        return this.system.indexOf(this.record.hidden[at]);
    }

    private track<T extends { delete(): void }>(shape: T): T {
        this.shapes.push(shape);
        return shape;
    }

    private pt(at: number): Point {
        return this.track(this.native.make_point(this.p(at), this.p(at + 1)));
    }

    private line(at: number): Line {
        return this.track(this.native.make_line(this.p(at), this.p(at + 1), this.p(at + 2), this.p(at + 3)));
    }

    private circle(centerAt: number, radiusIndex: number): Circle {
        return this.track(this.native.make_circle(this.p(centerAt), this.p(centerAt + 1), radiusIndex));
    }

    /** A line from native point param indices. */
    private lineOf(x1: number, y1: number, x2: number, y2: number): Line {
        return this.track(this.native.make_line(x1, y1, x2, y2));
    }

    /** Hidden radius `hiddenAt` held equal to the arc (center `at`, start `at + 2`). */
    private arcRadius(at: number, hiddenAt: number): number {
        const radius = this.h(hiddenAt);
        this.native.add_constraint_p2p_distance(this.pt(at), this.pt(at + 2), radius, this.tag, true, 1);
        return radius;
    }

    private fixedParam(value: number): number {
        return this.native.push_p_param(value, true);
    }

    private emitKind(): void {
        const { native, tag } = this;
        const { internal } = this.record;
        switch (this.record.kind) {
            case ConstraintKind.Collinear:
                for (let i = 4; i < this.record.params.length; i += 2) {
                    native.add_constraint_point_on_line_ppp(this.pt(i), this.pt(0), this.pt(2), tag, true, 1);
                }
                return;
            case ConstraintKind.Block: {
                const count = this.record.params.length / 2;
                for (let i = 0; i < count; i++) {
                    native.add_constraint_equal(this.p(i), this.p(i + count), tag, true, 0, 1);
                }
                return;
            }
            case ConstraintKind.EqualAngle:
                for (const i of [0, 8]) {
                    native.add_constraint_l2l_angle_pppp(
                        this.pt(i),
                        this.pt(i + 2),
                        this.pt(i + 4),
                        this.pt(i + 6),
                        this.h(0),
                        tag,
                        true,
                        1,
                    );
                }
                return;
            case ConstraintKind.Scale:
                native.add_constraint_p2p_distance(this.pt(0), this.pt(2), this.h(0), tag, true, 1);
                native.add_constraint_p2p_distance(this.pt(4), this.pt(6), this.h(1), tag, true, 1);
                // The bundled proportional equation is reduced as plain equality by PlaneGCS.
                // Incidence on y = ratio*x keeps both lengths free and preserves the ratio.
                native.add_constraint_point_on_line_ppp(
                    this.track(native.make_point(this.h(1), this.h(0))),
                    this.track(native.make_point(this.fixedParam(0), this.fixedParam(0))),
                    this.track(native.make_point(this.fixedParam(1), this.p(8))),
                    tag,
                    true,
                    1,
                );
                return;
            case ConstraintKind.P2PCoincident:
                native.add_constraint_p2p_coincident(this.pt(0), this.pt(2), tag, true, 1);
                return;
            case ConstraintKind.P2PDistance:
                native.add_constraint_p2p_distance(this.pt(0), this.pt(2), this.p(4), tag, true, 1);
                return;
            case ConstraintKind.Equal:
            case ConstraintKind.EqualRadius:
            case ConstraintKind.Radius:
                native.add_constraint_equal(this.p(0), this.p(1), tag, true, 0, 1);
                return;
            case ConstraintKind.PointOnLine:
                native.add_constraint_point_on_line_ppp(this.pt(0), this.pt(2), this.pt(4), tag, true, 1);
                return;
            case ConstraintKind.Horizontal:
            case ConstraintKind.HorizontalAlign:
                native.add_constraint_horizontal_pp(this.pt(0), this.pt(2), tag, true, 1);
                return;
            case ConstraintKind.Vertical:
            case ConstraintKind.VerticalAlign:
                native.add_constraint_vertical_pp(this.pt(0), this.pt(2), tag, true, 1);
                return;
            case ConstraintKind.Parallel:
                native.add_constraint_parallel(this.line(0), this.line(4), tag, true, 1);
                return;
            case ConstraintKind.Perpendicular:
                native.add_constraint_perpendicular_pppp(
                    this.pt(0),
                    this.pt(2),
                    this.pt(4),
                    this.pt(6),
                    tag,
                    true,
                    1,
                );
                return;
            case ConstraintKind.P2LDistance:
                this.emitSignedPointLineDistance();
                return;
            case ConstraintKind.Angle:
                native.add_constraint_l2l_angle_pppp(
                    this.pt(0),
                    this.pt(2),
                    this.pt(4),
                    this.pt(6),
                    this.p(8),
                    tag,
                    true,
                    1,
                );
                return;
            case ConstraintKind.EqualLength:
                native.add_constraint_equal_length(this.line(0), this.line(4), tag, true, 1);
                return;
            case ConstraintKind.PointOnCircle:
                native.add_constraint_point_on_circle(this.pt(0), this.circle(2, this.p(4)), tag, true, 1);
                return;
            case ConstraintKind.Midpoint:
                native.add_constraint_p2p_symmetric_ppp(this.pt(2), this.pt(4), this.pt(0), tag, true, 1);
                return;
            case ConstraintKind.Symmetric:
                native.add_constraint_p2p_symmetric_ppl(this.pt(0), this.pt(2), this.line(4), tag, true, 1);
                return;
            case ConstraintKind.TangentLineCircle:
                native.add_constraint_tangent_lc(this.line(0), this.circle(4, this.p(6)), tag, true, 1);
                return;
            case ConstraintKind.TangentCircleCircle:
                native.add_constraint_tangent_circumf(
                    this.pt(0),
                    this.pt(3),
                    this.p(2),
                    this.p(5),
                    internal,
                    tag,
                    true,
                    1,
                );
                return;
            case ConstraintKind.HorizontalDistance:
                native.add_constraint_difference(this.p(0), this.p(2), this.p(4), tag, true, 1);
                return;
            case ConstraintKind.VerticalDistance:
                native.add_constraint_difference(this.p(1), this.p(3), this.p(4), tag, true, 1);
                return;
            case ConstraintKind.Fix:
                native.add_constraint_equal(this.p(0), this.p(2), tag, true, 0, 1);
                native.add_constraint_equal(this.p(1), this.p(3), tag, true, 0, 1);
                return;
            case ConstraintKind.PointOnArc:
                // ‖p − c‖ = ‖s − c‖
                native.add_constraint_equal_length(
                    this.lineOf(this.p(2), this.p(3), this.p(0), this.p(1)),
                    this.lineOf(this.p(2), this.p(3), this.p(4), this.p(5)),
                    tag,
                    true,
                    1,
                );
                return;
            case ConstraintKind.EqualArcRadius:
                native.add_constraint_equal_length(this.line(0), this.line(4), tag, true, 1);
                return;
            case ConstraintKind.TangentLineArc: {
                const radius = this.arcRadius(4, 0);
                native.add_constraint_tangent_lc(this.line(0), this.circle(4, radius), tag, true, 1);
                return;
            }
            case ConstraintKind.TangentArcArc: {
                const r1 = this.arcRadius(0, 0);
                const r2 = this.arcRadius(4, 1);
                native.add_constraint_tangent_circumf(this.pt(0), this.pt(4), r1, r2, internal, tag, true, 1);
                return;
            }
            case ConstraintKind.TangentCircleArc: {
                const r2 = this.arcRadius(3, 0);
                native.add_constraint_tangent_circumf(
                    this.pt(0),
                    this.pt(3),
                    this.p(2),
                    r2,
                    internal,
                    tag,
                    true,
                    1,
                );
                return;
            }
        }
    }

    /**
     * PlaneGCS only has an unsigned point-line distance, so the signed one is built from
     * a hidden foot point F: F lies on the line, the segment F→p stands at a signed right
     * angle to the line direction, and ‖F − p‖ is the distance's magnitude. A positive
     * distance puts p right of l1→l2, i.e. at −90° from the line direction.
     */
    private emitSignedPointLineDistance(): void {
        const { native, tag } = this;
        const distance = this.system.valueOf(this.record.params[6]);
        if (Math.abs(distance) < ZERO_DISTANCE) {
            native.add_constraint_point_on_line_ppp(this.pt(0), this.pt(2), this.pt(4), tag, true, 1);
            return;
        }
        const foot = this.track(native.make_point(this.h(0), this.h(1)));
        native.add_constraint_point_on_line_ppp(foot, this.pt(2), this.pt(4), tag, true, 1);
        native.add_constraint_l2l_angle_pppp(
            this.pt(2),
            this.pt(4),
            foot,
            this.pt(0),
            this.fixedParam(distance > 0 ? -Math.PI / 2 : Math.PI / 2),
            tag,
            true,
            1,
        );
        native.add_constraint_p2p_distance(
            foot,
            this.pt(0),
            this.fixedParam(Math.abs(distance)),
            tag,
            true,
            1,
        );
    }
}
