// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type {
    BSpline,
    Circle,
    GcsSystem,
    IntVector,
    Line,
    Point,
} from "@salusoft89/planegcs/dist/planegcs_dist/gcs_system";
import initPlaneGcsModule from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.js";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm";
import {
    type BSplineCurve2d,
    type BSplineParametrization,
    bsplinePoints,
    closestBSplineParameter,
    interpolateBSpline,
    interpolateBSplineAt,
} from "./bsplineGeometry";

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
    /**
     * p.x, p.y — the point lies on a B-spline curve (`SolverSystem.add_point_on_bspline`); its curve
     * parameter is a hidden solver param, so the point slides along the curve.
     */
    PointOnBSpline = 32,
    /**
     * l1.p1, l1.p2, a, b, each (x, y): the line runs along a B-spline's end tangent — parallel to the
     * end pole segment a → b (a clamped curve leaves its end along the first / last pole leg). A
     * direction only: the joint itself is a coincidence of its own.
     */
    TangentLineBSpline = 33,
}

/** Param count and trailing datum count of every kind. */
const LAYOUT: Record<ConstraintKind, { params: number; datums: number }> = {
    [ConstraintKind.Collinear]: { params: 0, datums: 0 },
    [ConstraintKind.Block]: { params: 0, datums: 0 },
    [ConstraintKind.EqualAngle]: { params: 16, datums: 0 },
    [ConstraintKind.Scale]: { params: 9, datums: 1 },
    [ConstraintKind.PointOnBSpline]: { params: 2, datums: 0 },
    [ConstraintKind.TangentLineBSpline]: { params: 8, datums: 0 },
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
    IntVector: new () => IntVector;
}

interface ConstraintRecord {
    readonly kind: ConstraintKind;
    readonly params: readonly number[];
    /** Resolved tangency branch (tangent kinds only). */
    readonly internal: boolean;
    /** Solver-only params this constraint owns (foot points, arc radii); removed with it. */
    readonly hidden: readonly number[];
    /** The B-spline curve a curve constraint (`PointOnBSpline`) acts on. */
    readonly curve?: number;
}

/**
 * An interpolating B-spline in the native system: the fit points are ordinary params (a sketch
 * entity's points), the poles solver-only params, and each fit point is held on the curve at its
 * fit parameter — so constraints on the fit points drive the curve, and curve constraints
 * (`PointOnBSpline`, an end tangent over the poles) act back on the fit points. The poles are
 * determined by the fit points (as many poles as fit points): the curve adds no degree of freedom.
 */
interface CurveRecord {
    /** Fit point param ids, (x, y) pairs in curve order. */
    readonly fit: readonly number[];
    /** Pole param ids, (x, y) pairs; owned by the curve. */
    readonly poles: readonly number[];
    readonly periodic: boolean;
    readonly parametrization: BSplineParametrization;
    /**
     * The knot layout (knots, multiplicities, fit parameters) the native curve is built with, and
     * the poles last interpolated on it. PlaneGCS caches a curve's knots when the curve's equations
     * are created, so new knot values take a rebuild (`updateCurveKnots`).
     */
    shape: BSplineCurve2d;
    /** Fit values the knot layout was computed from — what `curvesMoved` compares against. */
    knotFit: number[];
}

/** Tags of the curves' own equations sit above every constraint tag (constraint id + 1). */
const CURVE_TAG_BASE = 1 << 28;

/**
 * A fine solve re-solves against fresh knots for as long as the last pass moved a fit point by more
 * than `CURVE_REFRESH_TOLERANCE`. Every pass keeps the pin level of the first (`pinLevels`), so only
 * the fit points that had to move carry the knot correction, which shrinks several times per pass:
 * a handful of passes settle it. This cap only guards against a sequence that never settles.
 */
const CURVE_REFRESH_PASSES = 50;
/** Fit points moving less than this in the last pass (since the knots were computed) end the refresh. */
const CURVE_REFRESH_TOLERANCE = 1e-10;

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
    private readonly curves: (CurveRecord | undefined)[] = [];
    private readonly dragged = new Set<number>();
    /** Params released from a drag since the last fine solve: held until its plain level (`pinLevels`). */
    private readonly released = new Set<number>();

    private native: GcsSystem | undefined;
    /** Native B-spline objects by curve id, valid while `native` is current. */
    private nativeCurves = new Map<number, BSpline>();
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
        for (const curve of this.curves) {
            if (curve?.fit.includes(id)) throw new Error(`ParamInUse: param ${id} is a B-spline fit point`);
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
        if (kind === ConstraintKind.PointOnBSpline)
            throw new Error("PointOnBSpline is added with add_point_on_bspline");
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

    // ------------------------------------------------------------------ B-spline curves

    /**
     * Adds the interpolating B-spline through the fit point params `fit` ((x, y) pairs in curve
     * order), with its poles as new solver-only params. Fails, touching nothing, when the fit
     * points do not interpolate (`interpolateBSpline`). Returns the curve id.
     */
    add_bspline(fit: readonly number[], periodic: boolean, parametrization: BSplineParametrization): number {
        for (const id of fit) this.assertParam(id);
        const values = fit.map((id) => this.values[id]);
        const shape = interpolateBSpline(bsplinePoints(values), { periodic, parametrization });
        if (!shape.isOk) throw new Error(shape.error);
        if (shape.value.poles.length * 2 !== fit.length) {
            throw new Error(
                "B-spline fit points must be distinct: a periodic curve does not repeat its first",
            );
        }
        const poles = shape.value.poles.flatMap(([x, y]) => [this.pushParam(x), this.pushParam(y)]);
        this.curves.push({
            fit: [...fit],
            poles,
            periodic,
            parametrization,
            shape: shape.value,
            knotFit: values,
        });
        this.invalidate();
        return this.curves.length - 1;
    }

    /** Removes a curve and its poles. A curve still referenced by a live constraint cannot be removed. */
    remove_bspline(id: number): void {
        const curve = this.curves[id];
        if (curve === undefined) throw new Error(`UnknownCurve: ${id}`);
        for (const record of this.constraints) {
            if (record === undefined) continue;
            if (record.curve === id || record.params.some((param) => curve.poles.includes(param))) {
                throw new Error(`CurveInUse: curve ${id} is referenced by a constraint`);
            }
        }
        for (const pole of curve.poles) {
            this.alive[pole] = false;
            this.dragged.delete(pole);
        }
        this.curves[id] = undefined;
        this.invalidate();
    }

    /** Pole param ids of a curve, (x, y) pairs — the end tangent constraint's legs. */
    bspline_poles(id: number): readonly number[] {
        const curve = this.curves[id];
        if (curve === undefined) throw new Error(`UnknownCurve: ${id}`);
        return curve.poles;
    }

    /** The curve's current shape (poles from the solver params, knots of the last refresh). */
    bspline_shape(id: number): BSplineCurve2d {
        const curve = this.curves[id];
        if (curve === undefined) throw new Error(`UnknownCurve: ${id}`);
        return this.shapeOf(curve);
    }

    /**
     * Holds the point (px, py) on the curve; its curve parameter is a hidden param starting at the
     * parameter closest to the point. Returns the constraint id (removed with `remove_constraint`).
     */
    add_point_on_bspline(curveId: number, px: number, py: number): number {
        const curve = this.curves[curveId];
        if (curve === undefined) throw new Error(`UnknownCurve: ${curveId}`);
        this.assertParam(px);
        this.assertParam(py);
        const u = closestBSplineParameter(this.shapeOf(curve), [this.values[px], this.values[py]]);
        this.constraints.push({
            kind: ConstraintKind.PointOnBSpline,
            params: [px, py],
            internal: false,
            hidden: [this.pushParam(u)],
            curve: curveId,
        });
        this.invalidate();
        return this.constraints.length - 1;
    }

    private shapeOf(curve: CurveRecord): BSplineCurve2d {
        const poles = [];
        for (let i = 0; i < curve.poles.length; i += 2) {
            poles.push([this.values[curve.poles[i]], this.values[curve.poles[i + 1]]] as [number, number]);
        }
        return { ...curve.shape, poles };
    }

    /**
     * Recomputes each curve's knot layout from its fit points' current values (chord-length and
     * centripetal knots follow the points); a layout that changed invalidates the native system,
     * whose curves cache their knots. Run before every solve, drag frames included (see
     * `preparedNative`). A fit set that no longer interpolates (two points dragged together) keeps
     * its previous layout.
     */
    private updateCurveKnots(): void {
        for (const curve of this.curves) {
            if (curve === undefined) continue;
            const values = curve.fit.map((id) => this.values[id]);
            const shape = interpolateBSpline(bsplinePoints(values), {
                periodic: curve.periodic,
                parametrization: curve.parametrization,
            });
            // a fit set that does not interpolate keeps its layout, but counts as refreshed: nothing
            // a further pass could compute differs (`curvesMoved`)
            curve.knotFit = values;
            if (!shape.isOk || shape.value.poles.length * 2 !== curve.poles.length) continue;
            const same =
                shape.value.degree === curve.shape.degree &&
                shape.value.knots.every((knot, i) => knot === curve.shape.knots[i]) &&
                shape.value.parameters.every((parameter, i) => parameter === curve.shape.parameters[i]);
            if (same) continue;
            curve.shape = shape.value;
            this.invalidate();
        }
    }

    /**
     * Re-interpolates every curve's poles from its fit points' current values, on its current knot
     * layout, and writes them into the model and the native system — before each solve, so a
     * curve's own equations start satisfied: dragging one fit point moves the poles, never the
     * other fit points (a least-change step would otherwise spread the drag over them). What a
     * constraint asks of a curve (an end pulled, an end tangent turned) is kept off the fit points
     * no constraint names by `pinLevels`; they move only when the constraints cannot be met without
     * them, the nearest to the constrained ones first.
     */
    private refreshCurvePoles(native: GcsSystem): void {
        for (const curve of this.curves) {
            if (curve === undefined) continue;
            const values = curve.fit.map((id) => this.values[id]);
            const shape = interpolateBSplineAt(bsplinePoints(values), curve.shape);
            if (!shape.isOk) continue;
            curve.shape = shape.value;
            shape.value.poles.forEach(([x, y], i) => {
                for (const [id, value] of [
                    [curve.poles[2 * i], x],
                    [curve.poles[2 * i + 1], y],
                ]) {
                    this.values[id] = value;
                    native.set_p_param(this.nativeIndex[id], value, this.isFixed(id));
                }
            });
        }
    }

    /** Whether a solve moved any curve's fit points off the values its knots were computed from. */
    private curvesMoved(): boolean {
        return this.curves.some(
            (curve) =>
                curve !== undefined &&
                curve.parametrization !== "uniform" &&
                curve.fit.some(
                    (id, i) => Math.abs(this.values[id] - curve.knotFit[i]) > CURVE_REFRESH_TOLERANCE,
                ),
        );
    }

    /**
     * The native system, current, with every curve's knots and poles refreshed (see above). Every
     * solve re-knots — a drag frame too, so the knot correction of a constrained curve is spread over
     * the drag instead of landing on mouse-up — which rebuilds the native system whenever the fit
     * points moved (a chord-length or centripetal curve being dragged); a sketch without such a curve
     * keeps reusing it.
     */
    private preparedNative(): GcsSystem {
        const previous = this.native;
        this.updateCurveKnots();
        const native = this.ensureBuilt();
        this.refreshCurvePoles(native);
        if (native !== previous) this.primeDiagnosis(native);
        return native;
    }

    /**
     * A native system takes its DOF count and its conflict / redundancy diagnosis from its first
     * solve, with the fixed flags of that moment. So a new one first runs a one-iteration solve,
     * thrown away, with only the datums fixed — the diagnosis of the sketch itself: neither the
     * pinned fit points of a pre-solve nor a held drag counts (with the dragged point fixed, a
     * distance between it and a fixed point would read as a conflict).
     */
    private primeDiagnosis(native: GcsSystem): void {
        for (const id of this.dragged)
            native.set_p_param(this.nativeIndex[id], this.values[id], this.datumParams.has(id));
        native.set_max_iterations(1);
        native.solve_system(DOG_LEG);
        native.set_max_iterations(this.defaultMaxIterations);
        this.pushValues(native);
    }

    /** @internal The native B-spline object of a curve, while the native system is current. */
    nativeCurve(id: number): BSpline {
        const curve = this.nativeCurves.get(id);
        if (curve === undefined) throw new Error(`UnknownCurve: ${id}`);
        return curve;
    }

    // ------------------------------------------------------------------ Dragging

    /** Pins `ids` at their current values (set them to the cursor first) until `clear_dragged`. */
    mark_dragged(ids: Uint32Array): void {
        for (const id of ids) {
            this.assertParam(id);
            this.dragged.add(id);
        }
        this.released.clear();
        this.applyDragged(true);
    }

    /** Releases every dragged param (the whole dragged set, whatever `ids` holds). */
    clear_dragged(ids: Uint32Array): void {
        for (const id of ids) this.assertParam(id);
        this.applyDragged(false);
        for (const id of this.dragged) this.released.add(id);
        this.dragged.clear();
    }

    // ------------------------------------------------------------------ Solving

    /**
     * Solves the system; `fine` is a full solve, otherwise a capped one for drag frames.
     *
     * Chord-length knots follow the fit points, so a fine solve that moved them re-solves against
     * fresh knots (`CURVE_REFRESH_PASSES`) until the solved curve is the one the edges are built
     * from. Every refresh pass keeps the release level the first pass settled on (`pinLevels`): the
     * knot correction is carried by the fit points that had to move anyway, never spread over the
     * rest of the curve pass after pass.
     */
    solve(fine: boolean): SolveReport {
        let { report, level } = this.solveOnce(fine, 0);
        for (let pass = 0; fine && pass < CURVE_REFRESH_PASSES && this.curvesMoved(); pass++) {
            ({ report, level } = this.solveOnce(fine, level));
        }
        if (fine) this.released.clear();
        return report;
    }

    /**
     * One solve against the current knots. The candidates run in order and the first that solves
     * is kept: the dragged params held at the cursor with the pin levels from `start` up to the
     * plain solve, then — only when even the plain solve cannot hold the cursor (it is off the
     * constraint locus) — the dragged params released, from the fully pinned level up. `level` is
     * the held pin level that was kept (0 after a released solve: the next pass starts over).
     */
    private solveOnce(fine: boolean, start: number): { report: SolveReport; level: number } {
        const native = this.preparedNative();
        native.set_max_iterations(fine ? this.defaultMaxIterations : COARSE_MAX_ITERATIONS);
        const levels = this.pinLevels();
        const plain = levels.length - 1;
        const before = [...this.values];

        const tryCandidate = (level: number, release: boolean): number | undefined => {
            if (level === plain && !release) {
                this.pushValues(native);
                const status = native.solve_system(DOG_LEG);
                if (isSolved(status)) {
                    this.applySolution(native);
                    return status;
                }
                this.pushValues(native);
                return undefined;
            }
            const solved = this.solvePinned(native, levels[level], release, before);
            if (!solved) return undefined;
            // the solve that reports runs unpinned with the drag held; from a real solution it starts
            // converged and moves nothing
            const status = native.solve_system(DOG_LEG);
            if (isSolved(status) && !native.has_conflicting() && !this.solutionMoved(native)) {
                this.applySolution(native);
                return status;
            }
            // the pinned solution is none the full system can build on: an equation over held params
            // only is left out of a pinned solve, not met (the report solve then moves on from it),
            // or the configuration reads as conflicting — drop it
            this.restoreValues(before);
            this.pushValues(native);
            return undefined;
        };

        let kept: { status: number; level: number } | undefined;
        for (let level = Math.min(start, plain); kept === undefined && level <= plain; level++) {
            const status = tryCandidate(level, false);
            if (status !== undefined) kept = { status, level };
        }
        for (let level = 0; kept === undefined && this.dragged.size > 0 && level <= plain; level++) {
            const status = tryCandidate(level, true);
            if (status !== undefined) kept = { status, level: 0 };
        }
        let status = kept?.status;
        if (status === undefined) {
            // nothing solves: report the plain solve (its iterate is not kept)
            this.pushValues(native);
            status = native.solve_system(DOG_LEG);
            this.pushValues(native);
        }
        this.cachedDofs = native.dof();
        return { report: { result: this.resultOf(native, status) }, level: kept?.level ?? 0 };
    }

    /** Whether a solve's solution leaves the model values (by more than `SOLUTION_MOVE_TOLERANCE`). */
    private solutionMoved(native: GcsSystem): boolean {
        native.apply_solution();
        for (let id = 0; id < this.values.length; id++) {
            if (!this.alive[id] || this.datumParams.has(id)) continue;
            const moved = Math.abs(native.get_p_param(this.nativeIndex[id]) - this.values[id]);
            if (moved > SOLUTION_MOVE_TOLERANCE) return true;
        }
        return false;
    }

    /** Writes back a snapshot of `values` (the params alive now), undoing every solve since. */
    private restoreValues(snapshot: readonly number[]): void {
        for (let id = 0; id < snapshot.length; id++) {
            if (this.alive[id]) this.values[id] = snapshot[id];
        }
    }

    /**
     * One solve from the model values with the params `pinned` held fixed and, when `release`, the
     * dragged params free to follow the constraints; applies its solution when it solved. A pinned
     * success is not trusted on its own: with the curve held, a constraint can be met trivially — a
     * zero-length line satisfies the parallel equation an end tangent is emitted as — so a solution
     * that collapsed a line a direction constraint acts on is refused. Returns whether the solution
     * was applied; the native params are back on the model values (unpinned) either way.
     */
    private solvePinned(
        native: GcsSystem,
        pinned: readonly number[],
        release: boolean,
        before: readonly number[],
    ): boolean {
        this.pushValues(native);
        for (const id of pinned) native.set_p_param(this.nativeIndex[id], this.values[id], true);
        if (release) this.applyDragged(false);
        let applied = isSolved(native.solve_system(DOG_LEG));
        if (applied) {
            this.applySolution(native, release);
            if (pinned.length > 0 && this.collapsedLine(before)) {
                this.restoreValues(before);
                applied = false;
            }
        }
        // back on the model values: every pin released, the drag held again
        this.pushValues(native);
        return applied;
    }

    /**
     * Whether a line some direction constraint acts on (parallel, perpendicular, angle, tangent,
     * point on line, …) is now shorter than `LINE_COLLAPSE_TOLERANCE` though it was not in `before`:
     * such equations hold trivially for a zero-length line.
     */
    private collapsedLine(before: readonly number[]): boolean {
        const length = (values: readonly number[], ids: readonly number[], at: number) =>
            Math.hypot(values[ids[at + 2]] - values[ids[at]], values[ids[at + 3]] - values[ids[at + 1]]);
        for (const record of this.constraints) {
            if (record === undefined) continue;
            for (const at of directionLines(record)) {
                const collapsed = length(this.values, record.params, at) < LINE_COLLAPSE_TOLERANCE;
                if (collapsed && length(before, record.params, at) >= LINE_COLLAPSE_TOLERANCE) return true;
            }
        }
        return false;
    }

    /** Params some (non-removed) constraint references. */
    private namedParams(): Set<number> {
        const named = new Set<number>();
        for (const record of this.constraints) {
            if (record !== undefined) for (const id of record.params) named.add(id);
        }
        return named;
    }

    /**
     * The pin sets a solve tries in turn, from every free fit point held (level 0) to none (the
     * last level, the plain solve).
     *
     * A curve adds no degree of freedom, but its fit points are free params: a least-norm solver
     * step spreads whatever a constraint asks of a curve (an end pulled along, an end tangent
     * turned, a fixed point on it) over every fit point, so points no constraint names would creep,
     * and the refresh passes (fresh chord-length knots after each solve) would compound that spread
     * — each pass a new least-norm reshape from the last one's state, the walk measured at 16 mm on
     * a 12 mm sketch for one end tangent. So the free fit points (neither dragged, a datum nor named
     * by a constraint) are released a ring at a time, outwards from the curve's anchors: the fit
     * points that are named, fixed, dragged or were dragged until this solve, and those whose pole
     * a constraint names (an end tangent acts on the end pole leg, so on the fit point next to the
     * end). Level k frees the free fit points fewer than k steps along the curve from an anchor;
     * a fit point just released from a drag stays held until the plain level, so letting go of the
     * mouse never moves it off the cursor. The first level that solves is kept, and the refresh
     * passes stay on it: the knot correction is carried by the fit points that had to move anyway,
     * and it shrinks from pass to pass because the reshape itself does not grow.
     *
     * Of the alternatives, re-solving each pass from the snapshot before the first one does not
     * converge (knots from the solution, solution from the base is an unstable iteration), and
     * freezing the knots after the first pass leaves the built curve (re-knotted from the stored
     * fit points) off the solved one, so an end tangent would not hold on the real edge. A fit
     * parameter of its own per fit point would change the entity's degrees of freedom. Levels
     * change nothing the caller sees: a curve without anchors (a fixed point on an otherwise free
     * curve) goes from all held to the plain solve, as before.
     *
     * The plain walk also made results depend on the page's history: after a few unrelated solvers
     * had run (and been disposed) in the same PlaneGCS module, the identical sketch (an end tangent
     * plus a free line joined to fit 3) was driven to a different far-off configuration (fit 3 at
     * 3.4·10⁸ or 4.3·10⁸ mm), and in the review's variant to `Diverged` instead of
     * `OkUnderconstrained`. PlaneGCS keeps part of its bookkeeping in pointer-keyed maps and sets,
     * so what earlier systems allocated can change the order it treats unknowns in; that only
     * shows in an ill-conditioned configuration like the walk's, and the levels do not reach one
     * (`bspline.test.ts` replays the sequence).
     */
    private pinLevels(): number[][] {
        const named = this.namedParams();
        const anchored = (id: number) => named.has(id) || this.isFixed(id) || this.released.has(id);
        const movable = (id: number) => !this.isFixed(id);
        /** Free fit params with their distance (in fit points) from the nearest anchor. */
        const rings: { id: number; distance: number }[] = [];
        for (const curve of this.curves) {
            if (curve === undefined) continue;
            const count = curve.fit.length / 2;
            const anchors: number[] = [];
            for (let i = 0; i < count; i++) {
                const ids = [
                    curve.fit[2 * i],
                    curve.fit[2 * i + 1],
                    curve.poles[2 * i],
                    curve.poles[2 * i + 1],
                ];
                if (ids.slice(0, 2).some(anchored) || ids.slice(2).some((id) => named.has(id)))
                    anchors.push(i);
            }
            for (let i = 0; i < count; i++) {
                const distance = Math.min(
                    ...anchors.map((a) => {
                        const d = Math.abs(i - a);
                        return curve.periodic ? Math.min(d, count - d) : d;
                    }),
                );
                for (const id of [curve.fit[2 * i], curve.fit[2 * i + 1]]) {
                    if (!movable(id)) continue;
                    // a fit point just released from a drag is held until the plain level
                    rings.push({ id, distance: this.released.has(id) ? Number.POSITIVE_INFINITY : distance });
                }
            }
        }
        if (rings.length === 0) return [[]];
        const finite = rings.map((ring) => ring.distance).filter(Number.isFinite);
        const levels: number[][] = [];
        for (let level = 0; level <= (finite.length > 0 ? Math.max(...finite) + 1 : 0); level++) {
            const pinned = rings.filter((ring) => ring.distance >= level).map((ring) => ring.id);
            if (pinned.length > 0 && pinned.length !== levels.at(-1)?.length) levels.push(pinned);
        }
        levels.push([]);
        return levels;
    }

    /** Degrees of freedom of the whole system (dragged params count as free). */
    dofs(): number {
        if (this.cachedDofs === undefined || this.dirty) {
            const native = this.preparedNative();
            native.solve_system(DOG_LEG);
            this.cachedDofs = native.dof();
            this.pushValues(native);
        }
        return this.cachedDofs;
    }

    /** Conflicting and redundant constraint ids, and the DOF count, as of a fresh solve. */
    diagnose(): SolverDiagnosis {
        const native = this.preparedNative();
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
        this.deleteNativeCurves();
        this.native?.delete();
        this.native = undefined;
        this.dirty = true;
    }

    private deleteNativeCurves(): void {
        for (const curve of this.nativeCurves.values()) curve.delete();
        this.nativeCurves.clear();
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
            // a curve's own equations are no constraint of the caller's
            if (tags.get(i) >= CURVE_TAG_BASE) continue;
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
        this.deleteNativeCurves();
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
            // datums are fixed from the start; dragged params are held per solve (`applyDragged`),
            // and the diagnosis solve (`primeDiagnosis`) counts them as free
            this.nativeIndex[id] = native.push_p_param(this.values[id], this.datumParams.has(id));
        }
        this.curves.forEach((curve, id) => {
            if (curve !== undefined) this.emitCurve(native, curve, id);
        });
        this.constraints.forEach((record, id) => {
            if (record !== undefined) new NativeConstraintBuilder(native, this, record, id + 1).emit();
        });

        this.native = native;
        this.dirty = false;
        this.applyDragged(this.dragged.size > 0);
        return native;
    }

    /**
     * The native B-spline of a curve, and its interpolation equations: each fit point on the curve
     * at its (fixed) fit parameter. A clamped curve starts and ends on its first and last pole, a
     * periodic one has no ends (its first fit point stands in for them).
     */
    private emitCurve(native: GcsSystem, curve: CurveRecord, id: number): void {
        const { module } = this;
        const index = (paramId: number) => this.nativeIndex[paramId];
        const vector = (values: readonly number[]) => {
            const out = new module.IntVector();
            for (const value of values) out.push_back(value);
            return out;
        };
        const shape = curve.shape;
        const knots = shape.knots.map((knot) => native.push_p_param(knot, true));
        const weights = shape.poles.map(() => native.push_p_param(1, true));
        const [sx, sy, ex, ey] = curve.periodic
            ? [curve.fit[0], curve.fit[1], curve.fit[0], curve.fit[1]]
            : [
                  curve.poles[0],
                  curve.poles[1],
                  curve.poles[curve.poles.length - 2],
                  curve.poles[curve.poles.length - 1],
              ];
        const vectors = [
            vector(curve.poles.map(index)),
            vector(weights),
            vector(knots),
            vector(shape.multiplicities),
        ];
        try {
            const bspline = native.make_bspline(
                index(sx),
                index(sy),
                index(ex),
                index(ey),
                vectors[0],
                vectors[1],
                vectors[2],
                vectors[3],
                shape.degree,
                curve.periodic,
            );
            this.nativeCurves.set(id, bspline);
            const tag = CURVE_TAG_BASE + id;
            shape.parameters.forEach((parameter, i) => {
                const u = native.push_p_param(parameter, true);
                const point = native.make_point(index(curve.fit[2 * i]), index(curve.fit[2 * i + 1]));
                native.add_constraint_point_on_bspline(point, bspline, u, tag, true, 1);
                point.delete();
            });
        } finally {
            for (const v of vectors) v.delete();
        }
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

/** A solve from a solution that moves a param further than this did not start from a solution. */
const SOLUTION_MOVE_TOLERANCE = 1e-9;

/** Below this length a line a direction constraint acts on counts as collapsed (see `collapsedLine`). */
const LINE_COLLAPSE_TOLERANCE = 1e-6;

/**
 * Offsets (into a constraint's params) of the lines, each (x1, y1, x2, y2), whose direction the
 * constraint's equations use — equations a zero-length line satisfies whatever its direction.
 */
function directionLines(record: ConstraintRecord): number[] {
    switch (record.kind) {
        case ConstraintKind.Horizontal:
        case ConstraintKind.Vertical:
        case ConstraintKind.HorizontalAlign:
        case ConstraintKind.VerticalAlign:
        case ConstraintKind.TangentLineCircle:
        case ConstraintKind.TangentLineArc:
        case ConstraintKind.Collinear:
            return [0];
        case ConstraintKind.Parallel:
        case ConstraintKind.Perpendicular:
        case ConstraintKind.Angle:
        case ConstraintKind.TangentLineBSpline:
            return [0, 4];
        case ConstraintKind.EqualAngle:
            return [0, 4, 8, 12];
        case ConstraintKind.PointOnLine:
        case ConstraintKind.P2LDistance:
            return [2];
        case ConstraintKind.Symmetric:
            return [4];
        default:
            return [];
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
            case ConstraintKind.TangentLineBSpline:
                native.add_constraint_parallel(this.line(0), this.line(4), tag, true, 1);
                return;
            case ConstraintKind.PointOnBSpline:
                native.add_constraint_point_on_bspline(
                    this.pt(0),
                    this.system.nativeCurve(this.record.curve!),
                    this.h(0),
                    tag,
                    true,
                    1,
                );
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
