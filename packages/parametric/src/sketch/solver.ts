// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EMPTY_SCOPE, type ParameterValue, type Plane, Result, type Scope } from "@spicy3d/core";
import { INCIDENCE_TOLERANCE } from "../features/refGeometry";
import {
    type BSplineOptions,
    type BSplineParametrization,
    type BSplinePoint,
    bsplineFitParams,
    bsplinePointAt,
    bsplinePoints,
    closestBSplineParameter,
    interpolateBSpline,
} from "./bsplineGeometry";
import {
    type ControlBSplineDefinition,
    type ControlBSplineSettings,
    controlBSplineCurve,
    defineControlBSpline,
} from "./controlBSplineGeometry";
import { entityParamKinds, PARAM_KIND_COORDINATE, PARAM_KIND_LENGTH } from "./entityLayout";
import {
    type EntityTables,
    type ExternalEntityHost,
    ExternalEntityRegistry,
    type ExternalPins,
} from "./externalEntities";
import { editableCurve, type GeometryEdit } from "./geometryEditing";
import type { SolverDiagnosis, SolverSystem } from "./planegcs";
import { newSolverSystem } from "./planegcs";
import { defaultSketchIds, type SketchIdAllocator } from "./sketchIds";
import type { SketchClipboard } from "./sketchModel";
import {
    blockParamIndices,
    ConstraintKind,
    datumEntityData,
    datumPoint,
    type ExternalRefData,
    isDatumEntityId,
    isExternalEntityId,
    pointRefKey,
    resolveDatumSource,
    SKETCH_ORIGIN_ID,
    SKETCH_X_AXIS_ID,
    SKETCH_Y_AXIS_ID,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
    type SketchEntityType,
    type SketchPointRef,
    syncExternalRoles,
    toDatumSource,
} from "./sketchModel";
import { type SplinePoint, splineParams } from "./splineGeometry";
import { type SketchTransform, transformSketchSelection } from "./utilityOperations";

function findRoot(parent: Map<string, string>, key: string): string {
    let root = key;
    while (parent.get(root) !== root) {
        root = parent.get(root)!;
    }
    return root;
}

function projectOntoCircle(
    center: [number, number],
    radius: number,
    u: number,
    v: number,
): [number, number] | undefined {
    const dx = u - center[0];
    const dy = v - center[1];
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-12) return undefined;
    return [center[0] + (dx / distance) * radius, center[1] + (dy / distance) * radius];
}

export interface SolveOutcome {
    result: string;
    dofs: number;
}

/** One datum as it goes into the solver: what to persist alongside the value it resolved to. */
interface DatumValue {
    readonly source: ParameterValue;
    readonly value: number;
}

/** solver param wiring for one constraint, as `buildConstraintParams` works it out. */
interface ConstraintParams {
    params: number[];
    /** The params a datum was written into, when the kind carries one. */
    datumParamIds?: number[];
    datumSources?: ParameterValue[];
    /** Solver kind when it differs from the sketch-level kind (arc radius → P2PDistance). */
    solverKind?: ConstraintKind;
    helperParams?: number[];
    helperConstraints?: number[];
    blockedParams?: number[];
}

/** The kinds whose value arrives through a datum param rather than from the geometry. */
const DATUM_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set([
    ConstraintKind.P2PDistance,
    ConstraintKind.Radius,
    ConstraintKind.P2LDistance,
    ConstraintKind.Angle,
    ConstraintKind.HorizontalDistance,
    ConstraintKind.VerticalDistance,
    ConstraintKind.Fix,
    ConstraintKind.Scale,
]);

interface ConstraintRecord {
    id: number;
    kind: ConstraintKind;
    refs: SketchPointRef[];
    solverId: number;
    datumParamIds?: number[];
    /**
     * What each `datumParamIds` entry was written from, in the same order: a number
     * may be read back from the solver (that is how the solver normalizes a literal),
     * a string is an expression and must be persisted verbatim — reading the solver back
     * over it would replace the user's expression with its current value.
     */
    datumSources?: ParameterValue[];
    direction?: [number, number];
    helperParams?: number[];
    helperConstraints?: number[];
    blockedParams?: number[];
}

/**
 * Wraps one PlaneGCS-backed `SolverSystem` for a sketch on a given plane.
 * Entity/constraint ids exposed here are stable and owned by this class;
 * the solver ParamId/ConstraintId handles stay internal.
 */
export class SketchSolver implements ExternalEntityHost {
    readonly plane: Plane;
    /**
     * The solver system every param and constraint is created in. Public because the
     * external-entity registry (`externalEntities.ts`) is a peer collaborator that
     * places params in it — see `ExternalEntityHost`. Replaced wholesale by `reset`.
     */
    system: SolverSystem;
    /** Entity tables holding real AND external entities (externals under reserved negative ids). */
    private readonly entityTypes = new Map<number, SketchEntityType>();
    private readonly constructionEntities = new Set<number>();
    private readonly entityParams = new Map<number, number[]>();
    private readonly entityCache = new Map<number, number[]>();
    /**
     * Parametrization and closure of each bspline entity, as stored: an absent parametrization
     * (hand-written data; the tools always write one) reads `chord` and stays absent, so a no-op
     * session gives back the data it loaded.
     */
    private readonly bsplineOptions = new Map<
        number,
        {
            parametrization: BSplineParametrization | undefined;
            periodic: boolean;
            control?: ControlBSplineDefinition;
        }
    >();
    /**
     * The solver curve of each bspline entity (`SolverSystem.add_bspline`): its poles follow the
     * fit points, and curve constraints (point on it, end tangent) act through it. A bspline
     * whose stored points do not interpolate (hand-edited data) has none — its fit points still
     * solve, curve constraints on it are refused.
     */
    private readonly bsplineCurves = new Map<number, number>();
    private readonly constraints = new Map<number, ConstraintRecord>();
    /** solver param ids of the datum entities (origin, X/Y axes), keyed by reserved id. */
    private readonly datumParams = new Map<number, number[]>();
    /** Internal constraints pinning the datum (never serialized, shown or removable). */
    private structuralConstraintIds: number[] = [];
    /**
     * Entities that can be constraint targets but never dragged, deleted or
     * param-edited: the datum (origin, X/Y axes) and every seeded external entity.
     */
    private readonly fixedEntities = new Set<number>();
    /** The pinned external entities and the refs they came from — see `externalEntities.ts`. */
    private readonly external = new ExternalEntityRegistry(this);
    private draggedParamIds: number[] = [];
    /**
     * The document's parameters, re-read by every expression datum. Held as a snapshot
     * rather than a live reference: `document.variables.evaluate()` re-resolves the
     * whole table, and `setScope` is where a new one lands.
     */
    private _scope: Scope;
    /** Expression datums that failed to resolve, by constraint id — the editor surfaces them. */
    private readonly _datumErrors = new Map<number, string>();

    /**
     * `SketchData.entityIdSeq`/`externalIdSeq` as loaded, carried back verbatim by `toData` so a
     * no-op session round-trips byte-identical (a changed dataJson would record a phantom history
     * entry). Ids are no longer counted (`sketchIds.ts`: random, collision-checked, so a freed id
     * is not reissued either), so the counters are never read nor advanced.
     */
    private legacyCounters: Pick<SketchData, "entityIdSeq" | "externalIdSeq"> = {};

    /**
     * @param ids how new entity, constraint and external ids are chosen — random by default;
     * {@link sequentialSketchIds} only for a sketch created in this session (see `sketchIds.ts`).
     */
    constructor(
        plane: Plane,
        data?: SketchData,
        scope: Scope = EMPTY_SCOPE,
        private readonly ids: SketchIdAllocator = defaultSketchIds(),
    ) {
        this.plane = plane;
        this._scope = scope;
        this.system = newSolverSystem();
        this.seedDatum();
        if (data !== undefined) {
            try {
                this.loadData(data);
            } catch (error) {
                this.system.free();
                throw error;
            }
        }
    }

    /** Expression datums that failed to resolve at the last load or scope change. */
    get datumErrors(): ReadonlyMap<number, string> {
        return this._datumErrors;
    }

    /**
     * Re-resolves every expression datum against `scope` and pushes the new values into
     * the solver. Returns whether any value actually moved, so the caller can skip a solve
     * that would find nothing to do. A datum that no longer resolves is reported through
     * `datumErrors` and keeps its previous value — the sketch stays usable.
     */
    setScope(scope: Scope): boolean {
        this._scope = scope;
        this._datumErrors.clear();
        let changed = false;
        for (const record of this.constraints.values()) {
            const sources = record.datumSources;
            const paramIds = record.datumParamIds;
            if (sources === undefined || paramIds === undefined) continue;
            for (let index = 0; index < sources.length; index++) {
                const resolved = resolveDatumSource(record.kind, sources[index], scope);
                if (!resolved.isOk) {
                    this._datumErrors.set(record.id, resolved.error);
                    continue;
                }
                const current = this.system.get_params(new Uint32Array([paramIds[index]]))[0];
                if (current === resolved.value) continue;
                this.system.set_param(paramIds[index], resolved.value);
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Writes a user input as one of a constraint's datums: a literal is converted into
     * storage units, an expression is stored verbatim and resolved on the spot. A failed
     * resolve returns the error without touching the datum — the user is editing, so the
     * dialog rejects the input rather than the sketch silently keeping a stale value.
     */
    setDatumSource(constraintId: number, input: ParameterValue, index = 0): Result<void> {
        const record = this.constraints.get(constraintId);
        const paramId = record?.datumParamIds?.[index];
        if (record === undefined || paramId === undefined) {
            return Result.err(`Constraint ${constraintId} has no datum ${index}`);
        }
        const source = toDatumSource(record.kind, input);
        const resolved = resolveDatumSource(record.kind, source, this._scope);
        if (!resolved.isOk) return Result.err(resolved.error);
        if (record.datumSources === undefined) record.datumSources = [];
        record.datumSources[index] = source;
        this._datumErrors.delete(constraintId);
        this.system.set_param(paramId, resolved.value);
        return Result.ok(undefined);
    }

    // ------------------------------------------------------------------ Entity and constraint editing

    addLine(x1: number, y1: number, x2: number, y2: number): number {
        return this.registerEntity("line", this.addEntityParams("line", [x1, y1, x2, y2]));
    }

    /** Only the endpoints enter PlaneGCS; interior interpolation points remain fixed client-side. */
    addSpline(points: readonly SplinePoint[]): Result<number> {
        const params = splineParams(points);
        if (!params.isOk) return Result.err(params.error);
        const id = this.registerEntity("spline", this.addEntityParams("spline", params.value));
        this.entityCache.set(id, [...params.value]);
        return Result.ok(id);
    }

    /**
     * One interpolating B-spline through `points` in curve order (`bsplineGeometry.ts`): every fit
     * point is a solver point (point index i = fit point i), the curve's poles follow them. A
     * periodic curve closes smoothly without repeating its first point (a repeated one is dropped).
     */
    addBSpline(points: readonly BSplinePoint[], options: BSplineOptions = {}): Result<number> {
        const periodic = options.periodic === true;
        if (options.control !== undefined) {
            if (options.parametrization !== undefined)
                return Result.err("Control B-splines do not use fit parametrization");
            const curve = controlBSplineCurve(points.flat(), options.control, periodic);
            if (!curve.isOk) return Result.err(curve.error);
            const id = this.registerEntity("bspline", this.addEntityParams("bspline", points.flat()));
            this.attachBSpline(id, undefined, periodic, options.control);
            return Result.ok(id);
        }
        const parametrization = options.parametrization ?? "chord";
        const params = bsplineFitParams(points, periodic);
        if (!params.isOk) return Result.err(params.error);
        const curve = interpolateBSpline(bsplinePoints(params.value), { periodic, parametrization });
        if (!curve.isOk) return Result.err(curve.error);
        const id = this.registerEntity("bspline", this.addEntityParams("bspline", params.value));
        this.attachBSpline(id, parametrization, periodic);
        return Result.ok(id);
    }

    /** Edits a coherent control layout atomically, preserving entity and constraint identities. */
    setControlBSpline(
        id: number,
        settings: ControlBSplineSettings & { poles?: BSplinePoint[] },
    ): Result<void> {
        const entity = this.entity(id);
        if (entity?.type !== "bspline" || !entity.control) return Result.err("Select a control B-spline");
        if (settings.periodic !== undefined && typeof settings.periodic !== "boolean")
            return Result.err("Periodic must be true or false");
        const poles = settings.poles === undefined ? bsplinePoints(entity.params) : settings.poles;
        const periodic = settings.periodic ?? entity.periodic === true;
        const changedLayout = settings.degree !== undefined && settings.degree !== entity.control.degree;
        const definition = defineControlBSpline(poles, {
            ...(changedLayout ? { weights: entity.control.weights } : entity.control),
            ...settings,
            periodic,
        });
        if (!definition.isOk) return Result.err(definition.error);
        const data = this.toData();
        const replacement = { ...entity, params: poles.flat(), control: definition.value };
        if (periodic) replacement.periodic = true;
        else delete replacement.periodic;
        data.entities[data.entities.findIndex((item) => item.id === id)] = replacement;
        let trial: SketchSolver | undefined;
        try {
            trial = new SketchSolver(this.plane, data, this._scope);
            const outcome = trial.solve(true);
            if (!outcome.result.startsWith("Ok"))
                return Result.err(`Control B-spline edit failed: ${outcome.result}`);
            this.reset(trial.toData());
            return Result.ok(undefined);
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        } finally {
            trial?.dispose();
        }
    }

    /** Records a bspline entity's options and creates its solver curve (see `bsplineCurves`). */
    private attachBSpline(
        id: number,
        parametrization: BSplineParametrization | undefined,
        periodic: boolean,
        control?: ControlBSplineDefinition,
    ): void {
        this.bsplineOptions.set(id, {
            parametrization,
            periodic,
            ...(control ? { control: structuredClone(control) } : {}),
        });
        if (control !== undefined) {
            if (parametrization !== undefined)
                throw new Error("Control B-splines do not use fit parametrization");
            const params = Array.from(this.system.get_params(new Uint32Array(this.entityParams.get(id)!)));
            const shape = controlBSplineCurve(params, control, periodic);
            if (!shape.isOk) throw new Error(shape.error);
            this.bsplineCurves.set(
                id,
                this.system.add_control_bspline(this.entityParams.get(id)!, shape.value),
            );
            return;
        }
        try {
            this.bsplineCurves.set(
                id,
                this.system.add_bspline(this.entityParams.get(id)!, periodic, parametrization ?? "chord"),
            );
        } catch {
            // points that do not interpolate: the entity stays, without a solver curve
        }
    }

    /** The solver curve of a bspline entity; throws for any other entity or a bspline without one. */
    private bsplineCurveOf(entityId: number): number {
        if (this.typeOf(entityId) !== "bspline") throw new Error(`Entity ${entityId} is not a bspline`);
        const curve = this.bsplineCurves.get(entityId);
        if (curve === undefined) throw new Error(`B-spline ${entityId} does not interpolate its points`);
        return curve;
    }

    /**
     * The end tangent leg of a bspline at the end `ref` addresses (fit point 0 or the last one): the
     * param ids of the two poles a clamped curve leaves that end along.
     */
    private bsplineEndLegParams(ref: SketchPointRef): number[] {
        const curve = this.bsplineCurveOf(ref.entityId);
        if (this.bsplineOptions.get(ref.entityId)?.periodic) {
            throw new Error(`B-spline ${ref.entityId} is periodic: it has no end to be tangent at`);
        }
        const poles = this.system.bspline_poles(curve);
        const last = this.entityParams.get(ref.entityId)!.length / 2 - 1;
        if (ref.pointIndex === 0) return poles.slice(0, 4);
        if (ref.pointIndex === last) return poles.slice(poles.length - 4);
        throw new Error(`Point ${ref.pointIndex} is no end of B-spline ${ref.entityId}`);
    }

    addPoint(x: number, y: number): number {
        return this.registerEntity("point", this.addEntityParams("point", [x, y]));
    }

    /** Exact ellipse: center and two perpendicular axis endpoints, all addressable. */
    addEllipse(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
        const id = this.registerEntity("ellipse", this.addEntityParams("ellipse", [cx, cy, ax, ay, bx, by]));
        this.addConstraint({
            kind: ConstraintKind.Perpendicular,
            refs: [0, 1, 0, 2].map((pointIndex) => ({ entityId: id, pointIndex })),
        });
        return id;
    }

    setConstruction(entityId: number, construction: boolean): void {
        if (construction) this.constructionEntities.add(entityId);
        else this.constructionEntities.delete(entityId);
    }

    addCircle(cx: number, cy: number, r: number): number {
        return this.registerEntity("circle", this.addEntityParams("circle", [cx, cy, r]));
    }

    addArc(cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): number {
        const id = this.registerEntity("arc", this.addEntityParams("arc", [cx, cy, sx, sy, ex, ey]));
        // structural constraint (invisible in the UI): keeps the end point on the
        // circle defined by center + start, so the arc always ends at its end point
        this.addConstraint({
            kind: ConstraintKind.PointOnArc,
            refs: [
                { entityId: id, pointIndex: 2 },
                { entityId: id, pointIndex: 0 },
                { entityId: id, pointIndex: 1 },
            ],
        });
        return id;
    }

    addConstraint(constraint: Omit<SketchConstraintData, "id">): number {
        const id = this.ids.next("constraint", (candidate) => this.constraints.has(candidate));
        this.addConstraintWithId(id, constraint);
        return id;
    }

    removeConstraint(id: number): void {
        const record = this.constraints.get(id);
        // Deletion stays idempotent: the UI can carry a dead id (e.g. an annotation
        // whose constraint was cascaded away untransacted by syncExternalRefs), and
        // a no-op beats throwing from a delete handler.
        if (record === undefined) return;
        this.system.remove_constraint(record.solverId);
        for (const id of record.helperConstraints ?? []) this.system.remove_constraint(id);
        for (const id of record.helperParams ?? []) this.system.remove_param(id);
        for (const datumParamId of record.datumParamIds ?? []) {
            this.system.remove_param(datumParamId);
        }
        this.constraints.delete(id);
        this._datumErrors.delete(id);
    }

    /** Validate a complete utility proposal before replacing any solver state. */
    applyTransform(
        ids: readonly number[],
        transform: SketchTransform,
        clipboard?: SketchClipboard,
        copy = false,
    ): Result<number[]> {
        const proposal = transformSketchSelection(this.toData(), ids, transform, clipboard, copy, this.ids);
        if (!proposal.isOk) return Result.err(proposal.error);
        this.reset(proposal.value.data);
        return Result.ok(proposal.value.ids);
    }

    /** Apply a previewed edit, tracking old points onto surviving endpoints and centers. */
    applyGeometryEdit(edit: GeometryEdit): Result<{ entityIds: number[]; removedConstraints: number[] }> {
        const current = this.entity(edit.source.id);
        if (
            this.isFixed(edit.source.id) ||
            current === undefined ||
            current.type !== edit.source.type ||
            current.construction !== edit.source.construction ||
            current.params.length !== edit.source.params.length ||
            current.params.some((value, i) => value !== edit.source.params[i])
        ) {
            return Result.err("The edited geometry has changed; select it again");
        }
        if (!editableCurve(current) || !edit.pieces.every(editableCurve)) {
            return Result.err("The edit contains invalid geometry");
        }
        const saved = this.toData().constraints.filter((c) => c.refs.some((r) => r.entityId === current.id));
        const removedConstraints = edit.copy ? [] : this.removeEntity(current.id);
        const entityIds = edit.pieces.map((e) => {
            const p = e.params;
            const id =
                e.type === "line"
                    ? this.addLine(p[0], p[1], p[2], p[3])
                    : e.type === "circle"
                      ? this.addCircle(p[0], p[1], p[2])
                      : this.addArc(p[0], p[1], p[2], p[3], p[4], p[5]);
            this.setConstruction(id, e.construction === true);
            return id;
        });
        if (edit.copy) return Result.ok({ entityIds, removedConstraints });
        const points = new Map<number, SketchPointRef>();
        const oldCount = current.type === "line" ? 2 : current.type === "arc" ? 3 : 1;
        for (let i = 0; i < oldCount; i++) {
            for (const id of entityIds) {
                const entity = this.entity(id)!;
                const count = entity.type === "line" ? 2 : entity.type === "arc" ? 3 : 1;
                for (let j = 0; j < count; j++) {
                    if (
                        Math.hypot(
                            current.params[2 * i] - entity.params[2 * j],
                            current.params[2 * i + 1] - entity.params[2 * j + 1],
                        ) < INCIDENCE_TOLERANCE
                    ) {
                        if (!points.has(i)) points.set(i, { entityId: id, pointIndex: j });
                    }
                }
            }
        }
        const pointKinds = new Set([
            ConstraintKind.Fix,
            ConstraintKind.P2PCoincident,
            ConstraintKind.HorizontalAlign,
            ConstraintKind.VerticalAlign,
            ConstraintKind.P2PDistance,
            ConstraintKind.HorizontalDistance,
            ConstraintKind.VerticalDistance,
        ]);
        for (const constraint of saved) {
            if (
                (constraint.kind === ConstraintKind.Horizontal ||
                    constraint.kind === ConstraintKind.Vertical) &&
                current.type === "line" &&
                constraint.refs.every((r) => r.entityId === current.id)
            ) {
                for (const id of entityIds)
                    this.addConstraint({
                        kind: constraint.kind,
                        refs: [
                            { entityId: id, pointIndex: 0 },
                            { entityId: id, pointIndex: 1 },
                        ],
                    });
            } else if (constraint.kind === ConstraintKind.Radius && current.type !== "line") {
                for (const id of entityIds)
                    this.addConstraint({ ...constraint, refs: [{ entityId: id, pointIndex: 0 }] });
            } else if (pointKinds.has(constraint.kind)) {
                const refs = constraint.refs.map((r) =>
                    r.entityId === current.id ? points.get(r.pointIndex) : r,
                );
                if (refs.every((r) => r !== undefined)) this.addConstraint({ ...constraint, refs });
            }
        }
        return Result.ok({ entityIds, removedConstraints });
    }

    /** Removes the entity and every constraint referencing it; returns removed constraint ids. */
    removeEntity(id: number): number[] {
        if (isDatumEntityId(id)) {
            throw new Error("The sketch datum cannot be removed");
        }
        if (isExternalEntityId(id)) {
            throw new Error("External references are removed with removeExternalEntity");
        }
        const paramIds = this.entityParams.get(id);
        if (paramIds === undefined) {
            throw new Error(`Unknown sketch entity: ${id}`);
        }
        const removedConstraints: number[] = [];
        for (const record of [...this.constraints.values()]) {
            if (record.refs.some((r) => r.entityId === id)) {
                this.removeConstraint(record.id);
                removedConstraints.push(record.id);
            }
        }
        const curve = this.bsplineCurves.get(id);
        if (curve !== undefined) this.system.remove_bspline(curve);
        for (const paramId of paramIds) {
            this.system.remove_param(paramId);
        }
        this.entityTypes.delete(id);
        this.constructionEntities.delete(id);
        this.entityParams.delete(id);
        this.entityCache.delete(id);
        this.bsplineOptions.delete(id);
        this.bsplineCurves.delete(id);
        return removedConstraints;
    }

    /** Whether the entity is fixed (datum or external): targetable, but never movable/deletable/editable. */
    isFixed(entityId: number): boolean {
        return this.fixedEntities.has(entityId);
    }

    /** Removes every constraint referencing the entity; returns removed constraint ids. */
    removeConstraintsOn(entityId: number): number[] {
        const removed: number[] = [];
        for (const record of [...this.constraints.values()]) {
            if (record.refs.some((r) => r.entityId === entityId)) {
                this.removeConstraint(record.id);
                removed.push(record.id);
            }
        }
        return removed;
    }

    setDatum(constraintId: number, value: number, index = 0): void {
        const paramId = this.constraints.get(constraintId)?.datumParamIds?.[index];
        if (paramId === undefined) {
            throw new Error(`Constraint ${constraintId} has no datum ${index}`);
        }
        this.system.set_param(paramId, value);
    }

    /** Moves a point without solving; used by auto-constraint snapping before a solve. */
    setPointPosition(ref: SketchPointRef, u: number, v: number): void {
        if (isDatumEntityId(ref.entityId)) {
            throw new Error("The sketch datum cannot be moved");
        }
        if (isExternalEntityId(ref.entityId)) {
            throw new Error("An external reference cannot be moved");
        }
        const [xId, yId] = this.pointParamIds(ref);
        this.system.set_param(xId, u);
        this.system.set_param(yId, v);
        const [x, y] = this.pointCacheIndices(ref);
        const cache = this.entityCache.get(ref.entityId)!;
        cache[x] = u;
        cache[y] = v;
    }

    /** Kinds of constraints currently applied to any point of the entity. */
    constraintKindsOn(entityId: number): ConstraintKind[] {
        return [...this.constraints.values()]
            .filter((c) => c.refs.some((r) => r.entityId === entityId))
            .map((c) => c.kind);
    }

    /** Kinds of constraints currently applied to a specific point ref. */
    constraintKindsOnPoint(ref: SketchPointRef): ConstraintKind[] {
        return [...this.constraints.values()]
            .filter((c) => c.refs.some((r) => pointRefKey(r) === pointRefKey(ref)))
            .map((c) => c.kind);
    }

    /**
     * Whether a constraint of one of `kinds` pins `ref` to geometry outside its own
     * entity. An arc's structural PointOnArc refers to that arc alone, so it is no
     * incidence: it keeps the arc on its own circle without pinning the point to
     * anything else.
     */
    hasIncidenceOn(ref: SketchPointRef, kinds: readonly ConstraintKind[]): boolean {
        const key = pointRefKey(ref);
        return [...this.constraints.values()].some(
            (c) =>
                kinds.includes(c.kind) &&
                c.refs.some((r) => pointRefKey(r) === key) &&
                c.refs.some((r) => r.entityId !== ref.entityId),
        );
    }

    /** Whether an identical constraint (same kind and refs, order-insensitive) already exists. */
    hasConstraint(kind: ConstraintKind, refs: SketchPointRef[]): boolean {
        const key = refs.map(pointRefKey).sort().join("|");
        return [...this.constraints.values()].some(
            (c) => c.kind === kind && c.refs.map(pointRefKey).sort().join("|") === key,
        );
    }

    // ------------------------------------------------------------------ Solving

    /** Independent trial system retaining document expression scope. Caller owns disposal. */
    fork(): SketchSolver {
        return new SketchSolver(this.plane, this.toData(), this._scope, this.ids);
    }

    /** Translate native tags, including helper equations, back to persistent constraint IDs. */
    diagnose(): SolverDiagnosis {
        const diagnosis = this.system.diagnose();
        const mapIds = (ids: number[]) => {
            const native = new Set(ids);
            return [...this.constraints.values()]
                .filter((c) => native.has(c.solverId) || c.helperConstraints?.some((id) => native.has(id)))
                .map((c) => c.id);
        };
        return {
            ...diagnosis,
            conflicting: mapIds(diagnosis.conflicting),
            redundant: mapIds(diagnosis.redundant),
        };
    }

    solve(fine: boolean): SolveOutcome {
        this.syncAngleDatumSide();
        let report = this.system.solve(fine);
        this.refreshCache();
        // A fine solve can silently stall when the geometry starts far off its
        // constraints (e.g. a sketch saved mid-drift): snap any point left off its
        // incidence geometry back onto it and re-solve once to heal the state.
        if (fine && this.repairIncidenceResiduals()) {
            report = this.system.solve(true);
            this.refreshCache();
        }
        return {
            result: typeof report === "string" ? report : String(report?.result),
            dofs: this.system.dofs(),
        };
    }

    /**
     * Snaps every point whose incidence constraint (point on line/circle/arc) is
     * violated beyond tolerance back onto its geometry. Returns whether anything moved.
     */
    private repairIncidenceResiduals(): boolean {
        let repaired = false;
        for (const record of this.constraints.values()) {
            const ref = record.refs[0];
            if (ref === undefined || this.fixedEntities.has(ref.entityId)) continue;
            const [u, v] = this.pointOf(ref);
            const projected = this.projectedIncidence(record, u, v);
            if (projected === undefined) continue;
            if (Math.hypot(projected[0] - u, projected[1] - v) <= INCIDENCE_TOLERANCE) continue;
            this.setPointPosition(ref, projected[0], projected[1]);
            repaired = true;
        }
        return repaired;
    }

    /** Projects (u, v) onto the line an incidence constraint pins any point of the dragged group to. */
    private projectOntoIncidence(groupKeys: Set<string>, u: number, v: number): [number, number] {
        let point: [number, number] = [u, v];
        for (const record of this.constraints.values()) {
            // lines only: circles/arcs stay loose during a coarse drag (the fine
            // solve re-asserts them on pointer-up)
            if (record.kind !== ConstraintKind.PointOnLine) continue;
            if (!groupKeys.has(pointRefKey(record.refs[0]))) continue;
            // self-incidence (the target geometry rides along with the dragged
            // group) has no fixed manifold to project onto
            if (record.refs.slice(1).some((r) => groupKeys.has(pointRefKey(r)))) continue;
            const projected = this.projectedIncidence(record, point[0], point[1]);
            if (projected !== undefined) point = projected;
        }
        return point;
    }

    /** Nearest position on the geometry an incidence constraint pins its point to. */
    private projectedIncidence(record: ConstraintRecord, u: number, v: number): [number, number] | undefined {
        switch (record.kind) {
            case ConstraintKind.PointOnLine: {
                const [x1, y1] = this.pointOf(record.refs[1]);
                const [x2, y2] = this.pointOf(record.refs[2]);
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lengthSq = dx * dx + dy * dy;
                if (lengthSq < 1e-12) return undefined;
                const t = ((u - x1) * dx + (v - y1) * dy) / lengthSq;
                return [x1 + t * dx, y1 + t * dy];
            }
            case ConstraintKind.PointOnCircle: {
                const radius = this.currentRadius(record.refs[1].entityId);
                return projectOntoCircle(this.pointOf(record.refs[1]), radius, u, v);
            }
            case ConstraintKind.PointOnArc: {
                const center = this.pointOf(record.refs[1]);
                const start = this.pointOf(record.refs[2]);
                const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
                return projectOntoCircle(center, radius, u, v);
            }
            case ConstraintKind.PointOnBSpline: {
                const curve = this.bsplineCurves.get(record.refs[1].entityId);
                if (curve === undefined) return undefined;
                const shape = this.system.bspline_shape(curve);
                return bsplinePointAt(shape, closestBSplineParameter(shape, [u, v]));
            }
            default:
                return undefined;
        }
    }

    /**
     * Angle datums are signed: the sign records which side of the first line the
     * second line sits on (the UI edits only the magnitude). Sync the sign with
     * the current geometry before solving, so an edit never flips a line across
     * its reference — and legacy unsigned datums adopt the loaded geometry's side.
     */
    private syncAngleDatumSide(): void {
        for (const [id, record] of this.constraints) {
            if (record.kind !== ConstraintKind.Angle || record.datumParamIds === undefined) continue;
            const sweep = this.currentSweep(record.refs);
            // ambiguous at 0°/180° — leave the datum sign alone
            if (Math.abs(sweep) < 1e-9 || Math.abs(Math.PI - Math.abs(sweep)) < 1e-9) continue;
            const datum = Number(this.system.get_params(new Uint32Array(record.datumParamIds))[0]);
            if (datum !== 0 && sweep * datum < 0) this.setDatum(id, -datum);
        }
    }

    /** Signed sweep (radians) from the first line's direction to the second's. */
    private currentSweep(refs: readonly SketchPointRef[]): number {
        const [x1, y1] = this.pointOf(refs[0]);
        const [x2, y2] = this.pointOf(refs[1]);
        const [x3, y3] = this.pointOf(refs[2]);
        const [x4, y4] = this.pointOf(refs[3]);
        const d1x = x2 - x1;
        const d1y = y2 - y1;
        const d2x = x4 - x3;
        const d2y = y4 - y3;
        if (Math.hypot(d1x, d1y) < 1e-12 || Math.hypot(d2x, d2y) < 1e-12) return 0;
        return Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y);
    }

    dofs(): number {
        return this.system.dofs();
    }

    // ------------------------------------------------------------------ Queries

    /** Data of every real (editable) entity; fixed datum/external entities are excluded. */
    entities(): SketchEntityData[] {
        return [...this.entityCache.entries()]
            .filter(([id]) => !this.fixedEntities.has(id))
            .map(([id, params]) => this.entityDataOf(id, this.entityTypes.get(id)!, params));
    }

    /** An entity's data as it is persisted: params copied, the optional fields only when set. */
    private entityDataOf(id: number, type: SketchEntityType, params: readonly number[]): SketchEntityData {
        const options = this.bsplineOptions.get(id);
        return {
            id,
            type,
            params: [...params],
            ...(this.constructionEntities.has(id) ? { construction: true } : {}),
            ...(options?.parametrization === undefined ? {} : { parametrization: options.parametrization }),
            ...(options?.periodic ? { periodic: true } : {}),
            ...(options?.control ? { control: structuredClone(options.control) } : {}),
        };
    }

    /** Current data of one entity, or undefined when unknown. Datum axes answer synthetic line data. */
    entity(id: number): SketchEntityData | undefined {
        if (id === SKETCH_X_AXIS_ID || id === SKETCH_Y_AXIS_ID) return datumEntityData(id);
        const type = this.entityTypes.get(id);
        const params = this.entityCache.get(id);
        return type === undefined || params === undefined ? undefined : this.entityDataOf(id, type, params);
    }

    pointOf(ref: SketchPointRef): [number, number] {
        if (isDatumEntityId(ref.entityId)) return datumPoint(ref);
        const [x, y] = this.pointCacheIndices(ref);
        const params = this.entityCache.get(ref.entityId)!;
        return [params[x], params[y]];
    }

    entityPoints(entityId: number): [number, number][] {
        const type = this.entityTypes.get(entityId);
        if (type === undefined) {
            throw new Error(`Unknown sketch entity: ${entityId}`);
        }
        switch (type) {
            case "bspline": {
                if (this.bsplineOptions.get(entityId)?.periodic) return [];
                const last = this.entityParams.get(entityId)!.length / 2 - 1;
                return [
                    this.pointOf({ entityId, pointIndex: 0 }),
                    this.pointOf({ entityId, pointIndex: last }),
                ];
            }
            case "spline":
            case "line":
                return [this.pointOf({ entityId, pointIndex: 0 }), this.pointOf({ entityId, pointIndex: 1 })];
            case "arc":
                return [this.pointOf({ entityId, pointIndex: 1 }), this.pointOf({ entityId, pointIndex: 2 })];
            default:
                return [this.pointOf({ entityId, pointIndex: 0 })];
        }
    }

    /**
     * All point refs coincident-linked to `ref` (including `ref` itself).
     * Coincident constraints merge points conceptually; the solver keeps separate params,
     * so drag operations must move the whole group. Fixed (datum and external) refs
     * never join a group — fixed entities must not be dragged.
     */
    coincidentGroup(ref: SketchPointRef): SketchPointRef[] {
        const parent = this.coincidentParentMap();
        const key = pointRefKey(ref);
        if (!parent.has(key)) {
            return [ref];
        }
        const root = findRoot(parent, key);
        const group: SketchPointRef[] = [];
        for (const record of this.constraints.values()) {
            if (record.kind !== ConstraintKind.P2PCoincident) continue;
            for (const r of record.refs) {
                if (this.fixedEntities.has(r.entityId)) continue;
                if (
                    findRoot(parent, pointRefKey(r)) === root &&
                    !group.some((g) => pointRefKey(g) === pointRefKey(r))
                ) {
                    group.push(r);
                }
            }
        }
        return group;
    }

    /** Union-find parent map over all coincident-linked point refs (fixed refs excluded). */
    private coincidentParentMap(): Map<string, string> {
        const parent = new Map<string, string>();
        for (const record of this.constraints.values()) {
            if (record.kind !== ConstraintKind.P2PCoincident || record.refs.length !== 2) continue;
            if (record.refs.some((r) => this.fixedEntities.has(r.entityId))) continue;
            const a = pointRefKey(record.refs[0]);
            const b = pointRefKey(record.refs[1]);
            if (!parent.has(a)) parent.set(a, a);
            if (!parent.has(b)) parent.set(b, b);
            parent.set(findRoot(parent, a), findRoot(parent, b));
        }
        return parent;
    }

    // ------------------------------------------------------------------ Dragging

    beginDrag(refs: SketchPointRef[]): void {
        const paramIds = new Set<number>();
        for (const ref of refs) {
            for (const r of this.coincidentGroup(ref)) {
                if (this.fixedEntities.has(r.entityId)) continue;
                for (const id of this.pointParamIds(r)) {
                    paramIds.add(id);
                }
            }
        }
        this.draggedParamIds = [...paramIds];
        this.system.mark_dragged(new Uint32Array(this.draggedParamIds));
    }

    dragTo(ref: SketchPointRef, u: number, v: number): SolveOutcome {
        const group = this.coincidentGroup(ref).filter((r) => !this.fixedEntities.has(r.entityId));
        const groupKeys = new Set(group.map(pointRefKey));
        // A point pinned onto a line slides along it instead of following the raw
        // cursor: the coarse solve does not converge from far off-manifold
        // positions, which would leave the point drifting off its constraint and
        // eventually surface as a bogus "Conflicting" report.
        const [pu, pv] = this.projectOntoIncidence(groupKeys, u, v);
        for (const r of group) {
            const [xId, yId] = this.pointParamIds(r);
            this.system.set_param(xId, pu);
            this.system.set_param(yId, pv);
        }
        return this.solve(false);
    }

    endDrag(): SolveOutcome {
        if (this.draggedParamIds.length > 0) {
            this.system.clear_dragged(new Uint32Array(this.draggedParamIds));
            this.draggedParamIds = [];
        }
        return this.solve(true);
    }

    // ------------------------------------------------------------------ Serialization and lifecycle

    toData(): SketchData {
        const constraints = this.constraintsData();
        const result: SketchData = { entities: this.entities(), constraints };
        // external refs live in SketchData, not in the entity list — preserve them
        if (this.external.refs.length > 0) {
            result.externalRefs = JSON.parse(JSON.stringify(this.external.refs)) as ExternalRefData[];
            // roles derive from the constraints referencing each ref (pinned refs keep theirs)
            syncExternalRoles(result);
        }
        // timeline anchors are capture-time metadata the solver never derives — carry them
        if (this.external.refPositions !== undefined) {
            result.refPositions = { ...this.external.refPositions };
        }
        // legacy id counters, carried verbatim (see the field comment)
        if (this.legacyCounters.entityIdSeq !== undefined)
            result.entityIdSeq = this.legacyCounters.entityIdSeq;
        if (this.legacyCounters.externalIdSeq !== undefined) {
            result.externalIdSeq = this.legacyCounters.externalIdSeq;
        }
        return result;
    }

    /** Every constraint record, with the current datum parameter values folded back in. */
    private constraintsData(): SketchConstraintData[] {
        return [...this.constraints.values()].map((record) => {
            const data: SketchConstraintData = {
                id: record.id,
                kind: record.kind,
                refs: record.refs.map((r) => ({ ...r })),
            };
            const sources = this.persistedDatums(record);
            if (record.blockedParams) data.blockedParams = [...record.blockedParams];
            if (record.direction) data.direction = [...record.direction];
            if (sources !== undefined) {
                if (sources.length === 1) {
                    data.datum = sources[0];
                } else {
                    data.datums = sources;
                }
            }
            return data;
        });
    }

    /**
     * The datums of a record as they should be persisted, in order. A literal is read
     * back from the solver — that is where the solver's normalization lands (the angle sign
     * `syncAngleDatumSide` settles on, the geometric fallback a datumless constraint
     * started from). An expression is returned as written: reading the solver back over it
     * would replace the user's expression with whatever it currently evaluates to, once
     * per commit.
     */
    private persistedDatums(record: ConstraintRecord): ParameterValue[] | undefined {
        const paramIds = record.datumParamIds;
        if (paramIds === undefined) return undefined;
        const values = Array.from(this.system.get_params(new Uint32Array(paramIds)));
        return values.map((value, index) => {
            const source = record.datumSources?.[index];
            return typeof source === "string" ? source : value;
        });
    }

    dispose(): void {
        this.system.free();
    }

    /** Replaces all state with `data` — undo/redo rewrites the node data behind the solver. */
    reset(data: SketchData): void {
        this.system.free();
        this.system = newSolverSystem();
        this.entityTypes.clear();
        this.constructionEntities.clear();
        this.entityParams.clear();
        this.entityCache.clear();
        this.bsplineOptions.clear();
        this.bsplineCurves.clear();
        this.constraints.clear();
        this.fixedEntities.clear();
        this.external.clear();
        this.legacyCounters = {};
        this.draggedParamIds = [];
        this.seedDatum();
        this.loadData(data);
    }

    // ------------------------------------------------------------------ Datum seeding (see `solverEntities` / `sketchModel` for the reserved ids)

    /**
     * Creates the datum entities (origin at (0,0), X axis (0,0)-(1,0), Y axis
     * (0,0)-(0,1)) as solver params under reserved negative ids, each point pinned
     * by an internal Fix constraint and marked fixed. Net dofs contribution is
     * zero; the structural constraints stay out of `this.constraints`, so they are
     * never serialized, annotated or removable.
     */
    private seedDatum(): void {
        this.datumParams.clear();
        this.structuralConstraintIds = [];
        const seed = (entityId: number, coords: number[]) => {
            const kinds = new Uint8Array(coords.length).fill(PARAM_KIND_COORDINATE);
            const ids = Array.from(this.system.add_params(kinds, new Float64Array(coords)));
            this.datumParams.set(entityId, ids);
            this.fixedEntities.add(entityId);
            const { constraintIds } = this.pinPoints(ids, coords);
            this.structuralConstraintIds.push(...constraintIds);
        };
        seed(SKETCH_ORIGIN_ID, [0, 0]);
        seed(SKETCH_X_AXIS_ID, [0, 0, 1, 0]);
        seed(SKETCH_Y_AXIS_ID, [0, 0, 0, 1]);
    }

    // ------------------------------------------------------------------ External entities

    // The registry in `externalEntities.ts` owns which externals exist and where they
    // came from; these are the two halves of the seam. First the `ExternalEntityHost`
    // operations it borrows — the entity tables and the solver system, expressed as
    // named operations rather than handed over as fields. Then one-line delegations,
    // which are the reason nothing outside this class had to change.

    /** `ExternalEntityHost`: creates `type`'s params and registers them as one entity. */
    seedEntity(type: SketchEntityType, values: number[], id?: number): number[] {
        const paramIds = this.addEntityParams(type, values);
        this.registerEntity(type, paramIds, id);
        return paramIds;
    }

    /** `ExternalEntityHost`: the entity's tables in one view; `cache` is the live array. */
    entityTablesOf(id: number): EntityTables | undefined {
        const type = this.entityTypes.get(id);
        const params = this.entityParams.get(id);
        const cache = this.entityCache.get(id);
        return type === undefined || params === undefined || cache === undefined
            ? undefined
            : { type, params, cache };
    }

    /** `ExternalEntityHost`: drops the entity's rows; its solver params are the caller's. */
    forgetEntity(id: number): void {
        this.entityTypes.delete(id);
        this.entityParams.delete(id);
        this.entityCache.delete(id);
    }

    setFixed(id: number, fixed: boolean): void {
        if (fixed) this.fixedEntities.add(id);
        else this.fixedEntities.delete(id);
    }

    /** `ExternalEntityHost`: a new external entity id, unused by any entity of the sketch nor `reserved`. */
    allocateEntityId(kind: "external", reserved: ReadonlySet<number>): number {
        return this.ids.next(kind, (candidate) => this.entityTypes.has(candidate) || reserved.has(candidate));
    }

    addExternalEntity(ref: ExternalRefData): void {
        this.external.addExternalEntity(ref);
    }

    allocateExternalEntityId(): number {
        return this.external.allocateExternalEntityId();
    }

    recordRefPosition(nodeId: string, featureCount: number): void {
        this.external.recordRefPosition(nodeId, featureCount);
    }

    /** Removes the ref and every constraint referencing it; returns the removed constraint ids. */
    removeExternalEntity(id: number): number[] {
        return this.external.removeExternalEntity(id);
    }

    updateExternalEntity(id: number, params: number[]): void {
        this.external.updateExternalEntity(id, params);
    }

    syncExternalRefs(refs: ExternalRefData[]): boolean {
        return this.external.syncExternalRefs(refs);
    }

    externalEntitiesData(): SketchEntityData[] {
        return this.external.externalEntitiesData();
    }

    externalRefsData(): ExternalRefData[] {
        return this.external.externalRefsData();
    }

    /**
     * Ids of the user constraints the latest `syncExternalRefs` cascaded away —
     * through a type-flip reseed (their entity's param layout changed, so they could
     * not survive) or through a dropped ref (their target geometry no longer exists).
     * Both are reported so the editor can drop the constraints' dimension anchors:
     * an unreported removal would leave orphan anchors in `SketchData.anchors`.
     */
    get lastRemovedConstraintIds(): readonly number[] {
        return this.external.removedConstraintIds;
    }

    /**
     * Node id of the sketch plane's face owner (`SketchNode.planeRef`), set by the
     * editor — the solver never sees the node-level planeRef. Node-level, not
     * data-level: it survives `reset` (see the registry's field comment).
     */
    get planeOwnerNodeId(): string | undefined {
        return this.external.planeOwnerNodeId;
    }

    set planeOwnerNodeId(value: string | undefined) {
        this.external.planeOwnerNodeId = value;
    }

    /**
     * Pins every (x, y) point param pair of `paramIds` with an internal Fix
     * constraint to a datum param holding the point's current value — the shared
     * core of `seedDatum` and `seedExternalEntity`. `values` parallels `paramIds`
     * and supplies the pinned coordinates.
     */
    pinPoints(paramIds: readonly number[], values: readonly number[]): ExternalPins {
        const datumParamIds: number[] = [];
        const constraintIds: number[] = [];
        for (let i = 0; i < paramIds.length; i += 2) {
            const x0 = this.createDatumParam(values[i]);
            const y0 = this.createDatumParam(values[i + 1]);
            datumParamIds.push(x0, y0);
            constraintIds.push(
                this.system.add_constraint(
                    ConstraintKind.Fix,
                    new Uint32Array([paramIds[i], paramIds[i + 1], x0, y0]),
                    null,
                    true,
                    0,
                ),
            );
        }
        return { datumParamIds, constraintIds };
    }

    // ------------------------------------------------------------------ Constraint-parameter plumbing

    private registerEntity(type: SketchEntityType, paramIds: number[], id?: number): number {
        let entityId: number;
        if (id === undefined) {
            entityId = this.ids.next("entity", (candidate) => this.entityTypes.has(candidate));
        } else {
            entityId = id;
        }
        this.entityTypes.set(entityId, type);
        this.entityParams.set(entityId, paramIds);
        this.entityCache.set(entityId, [...this.system.get_params(new Uint32Array(paramIds))]);
        return entityId;
    }

    private addConstraintWithId(id: number, constraint: Omit<SketchConstraintData, "id">): void {
        if (constraint.kind === ConstraintKind.PointOnBSpline) {
            this.addPointOnBSpline(id, constraint);
            return;
        }
        const {
            params,
            datumParamIds,
            datumSources,
            solverKind,
            helperParams,
            helperConstraints,
            blockedParams,
        } = this.buildConstraintParams(constraint, id);
        const solverId = this.system.add_constraint(
            solverKind ?? constraint.kind,
            new Uint32Array(params),
            null,
            true,
            0,
        );
        this.constraints.set(id, {
            id,
            kind: constraint.kind,
            refs: constraint.refs.map((r) => ({ ...r })),
            solverId,
            blockedParams,
            datumParamIds,
            datumSources,
            direction: constraint.direction ? [...constraint.direction] : undefined,
            helperParams,
            helperConstraints,
        });
    }

    /**
     * refs = [point, any point of the bspline]: the point slides on the curve (its curve parameter
     * is the solver's). A fit point of the same bspline lies on it by construction — refused.
     */
    private addPointOnBSpline(id: number, constraint: Omit<SketchConstraintData, "id">): void {
        const [point, curveRef] = constraint.refs;
        if (point === undefined || curveRef === undefined)
            throw new Error("Point on B-spline takes two refs");
        if (point.entityId === curveRef.entityId && !this.bsplineOptions.get(curveRef.entityId)?.control) {
            throw new Error("A B-spline's own point already lies on it");
        }
        const [px, py] = this.pointParamIds(point);
        const solverId = this.system.add_point_on_bspline(this.bsplineCurveOf(curveRef.entityId), px, py);
        this.constraints.set(id, {
            id,
            kind: constraint.kind,
            refs: constraint.refs.map((r) => ({ ...r })),
            solverId,
        });
    }

    /** solver param ids for a constraint; datum kinds also create their datum params. */
    private buildConstraintParams(
        constraint: Omit<SketchConstraintData, "id">,
        id: number,
    ): ConstraintParams {
        if (constraint.kind === ConstraintKind.Block) {
            const entityId = constraint.refs[0].entityId;
            if (entityId < 1) throw new Error("Cannot block reference geometry");
            const blockedParams = constraint.blockedParams ?? blockParamIndices(this.entity(entityId)!);
            const params = blockedParams.map((i) => this.entityParams.get(entityId)![i]);
            const values = Array.from(this.system.get_params(new Uint32Array(params)));
            return {
                ...this.withDatums(
                    params,
                    values.map((value, index) =>
                        this.datumOf(id, constraint.kind, constraint.datums?.[index], () => value),
                    ),
                ),
                blockedParams: [...blockedParams],
            };
        }
        if (constraint.direction) return this.directionalConstraintParams(constraint, id);
        if (DATUM_CONSTRAINTS.has(constraint.kind)) return this.datumConstraintParams(constraint, id);
        return { params: this.geometricConstraintParams(constraint) };
    }

    /** A hidden point follows p1 at a fixed offset, defining the transformed measurement axis. */
    private directionalConstraintParams(
        constraint: Omit<SketchConstraintData, "id">,
        id: number,
    ): ConstraintParams {
        const dimension =
            constraint.kind === ConstraintKind.HorizontalDistance ||
            constraint.kind === ConstraintKind.VerticalDistance;
        const [ux, uy] = constraint.direction!;
        const [dx, dy] = dimension ? [-uy, ux] : [ux, uy];
        const first = this.pointParamIds(constraint.refs[0]);
        const second = this.pointParamIds(constraint.refs[1]);
        const [x, y] = this.system.get_params(new Uint32Array(first));
        const helperParams = Array.from(
            this.system.add_params(new Uint8Array(4), new Float64Array([x + dx, y + dy, dx, dy])),
        );
        const [qx, qy, deltaX, deltaY] = helperParams;
        const helperConstraints = [ConstraintKind.HorizontalDistance, ConstraintKind.VerticalDistance].map(
            (kind, i) =>
                this.system.add_constraint(
                    kind,
                    new Uint32Array([...first, qx, qy, i === 0 ? deltaX : deltaY]),
                    null,
                    true,
                    0,
                ),
        );
        const params = [...second, ...first, qx, qy];
        if (!dimension)
            return { params, helperParams, helperConstraints, solverKind: ConstraintKind.PointOnLine };
        return {
            ...this.withDatum(params, id, constraint, () => {
                const [px, py] = this.system.get_params(new Uint32Array(second));
                return (px - x) * ux + (py - y) * uy;
            }),
            helperParams,
            helperConstraints,
            solverKind: ConstraintKind.P2LDistance,
        };
    }

    /**
     * The solver params of a constraint that is pure geometry: every ref contributes the
     * point / line / arc / radius ids the solver reads for that kind, in ref order.
     */
    private geometricConstraintParams(constraint: Omit<SketchConstraintData, "id">): number[] {
        const { refs } = constraint;
        switch (constraint.kind) {
            case ConstraintKind.Collinear:
            case ConstraintKind.EqualAngle:
                return this.pointParams(...refs);
            case ConstraintKind.P2PCoincident:
            case ConstraintKind.Horizontal:
            case ConstraintKind.Vertical:
            case ConstraintKind.HorizontalAlign:
            case ConstraintKind.VerticalAlign:
                return this.pointParams(refs[0], refs[1]);
            case ConstraintKind.PointOnArc:
                // p, c, s — refs are [point, center, start] (arc structural: end, center, start)
                return [...this.pointParams(refs[0]), ...this.arcParams(refs[1], refs[2])];
            case ConstraintKind.PointOnLine:
            case ConstraintKind.Midpoint:
                return [...this.pointParams(refs[0]), ...this.lineParams(refs[1], refs[2])];
            case ConstraintKind.Parallel:
            case ConstraintKind.EqualLength:
                return this.twoLineParams(refs);
            case ConstraintKind.Perpendicular:
                return refs.every((ref) => ref.entityId === refs[0].entityId) &&
                    this.typeOf(refs[0].entityId) === "ellipse"
                    ? this.pointParams(...refs)
                    : this.twoLineParams(refs);
            case ConstraintKind.Symmetric:
                return [...this.pointParams(refs[0], refs[1]), ...this.lineParams(refs[2], refs[3])];
            case ConstraintKind.EqualRadius:
                return [this.radiusParamId(refs[0].entityId), this.radiusParamId(refs[1].entityId)];
            case ConstraintKind.PointOnCircle:
                return [
                    ...this.pointParams(refs[0]),
                    ...this.circleCenterParamIds(refs[1]),
                    this.radiusParamId(refs[1].entityId),
                ];
            case ConstraintKind.TangentLineCircle:
                return [
                    ...this.lineParams(refs[0], refs[1]),
                    ...this.circleCenterParamIds(refs[2]),
                    this.radiusParamId(refs[2].entityId),
                ];
            case ConstraintKind.TangentCircleCircle:
                return [
                    ...this.circleCenterParamIds(refs[0]),
                    this.radiusParamId(refs[0].entityId),
                    ...this.circleCenterParamIds(refs[1]),
                    this.radiusParamId(refs[1].entityId),
                ];
            case ConstraintKind.EqualArcRadius:
            case ConstraintKind.TangentArcArc:
                return this.arcParams(refs[0], refs[1], refs[2], refs[3]);
            case ConstraintKind.TangentLineArc:
                return [...this.lineParams(refs[0], refs[1]), ...this.arcParams(refs[2], refs[3])];
            case ConstraintKind.TangentCircleArc:
                return [
                    ...this.circleCenterParamIds(refs[0]),
                    this.radiusParamId(refs[0].entityId),
                    ...this.arcParams(refs[1], refs[2]),
                ];
            case ConstraintKind.TangentLineBSpline:
                // refs = [line start, line end, the bspline end it is tangent at]
                return [...this.lineParams(refs[0], refs[1]), ...this.bsplineEndLegParams(refs[2])];
            default:
                // A datum kind never reaches here — `buildConstraintParams` routes it first.
                throw new Error(`Unsupported constraint kind: ${constraint.kind}`);
        }
    }

    /**
     * The solver params of a datum-driven constraint: its geometric params plus the param
     * its datum is written into. The value comes from the expression scope, the geometry's
     * own value standing in when the datum is absent or does not resolve (see `datumOf`).
     */
    private datumConstraintParams(
        constraint: Omit<SketchConstraintData, "id">,
        id: number,
    ): ConstraintParams {
        const { refs } = constraint;
        switch (constraint.kind) {
            case ConstraintKind.P2PDistance:
                return this.withDatum(this.pointParams(refs[0], refs[1]), id, constraint, () =>
                    this.currentDistance(refs[0], refs[1]),
                );
            case ConstraintKind.Radius:
                return this.radiusConstraintParams(constraint, id);
            case ConstraintKind.P2LDistance:
                return this.withDatum(
                    [...this.pointParams(refs[0]), ...this.lineParams(refs[1], refs[2])],
                    id,
                    constraint,
                    () => this.currentP2LDistance(refs),
                );
            case ConstraintKind.Angle:
                return this.withDatum(this.pointParams(...refs), id, constraint, () =>
                    this.currentAngle(refs),
                );
            case ConstraintKind.HorizontalDistance:
            case ConstraintKind.VerticalDistance:
                return this.withDatum(this.pointParams(refs[0], refs[1]), id, constraint, () =>
                    this.currentSignedDistance(
                        refs[0],
                        refs[1],
                        constraint.kind === ConstraintKind.HorizontalDistance ? 0 : 1,
                    ),
                );
            case ConstraintKind.Scale:
                return this.withDatum(
                    this.pointParams(...refs),
                    id,
                    constraint,
                    () => this.currentDistance(refs[0], refs[1]) / this.currentDistance(refs[2], refs[3]),
                );
            case ConstraintKind.Fix:
                return this.fixConstraintParams(constraint, id);
            default:
                throw new Error(`Unsupported datum constraint kind: ${constraint.kind}`);
        }
    }

    /** A circle's radius drives its radius param; an arc has none, so it drives a point distance. */
    private radiusConstraintParams(
        constraint: Omit<SketchConstraintData, "id">,
        id: number,
    ): ConstraintParams {
        const entityId = constraint.refs[0].entityId;
        if (this.typeOf(entityId) !== "arc") {
            return this.withDatum([this.radiusParamId(entityId)], id, constraint, () =>
                this.currentRadius(entityId),
            );
        }
        // arcs have no radius param — drive ‖start−center‖ as a point distance
        const start: SketchPointRef = { entityId, pointIndex: 1 };
        return {
            solverKind: ConstraintKind.P2PDistance,
            ...this.withDatum(this.arcParams(constraint.refs[0], start), id, constraint, () =>
                this.currentRadius(entityId),
            ),
        };
    }

    /** A fix pins one point; given explicit datums, each coordinate carries its own. */
    private fixConstraintParams(constraint: Omit<SketchConstraintData, "id">, id: number): ConstraintParams {
        const ref = constraint.refs[0];
        const fallback = this.pointOf(ref);
        const sources = constraint.datums;
        return this.withDatums(
            this.pointParams(ref),
            sources === undefined
                ? fallback.map((value) => ({ source: value, value }))
                : sources.map((source, index) =>
                      this.datumOf(id, constraint.kind, source, () => fallback[index]),
                  ),
        );
    }

    /** One datum on top of a constraint's geometric params. */
    private withDatum(
        params: number[],
        id: number,
        constraint: Omit<SketchConstraintData, "id">,
        fallback: () => number,
    ): ConstraintParams {
        return this.withDatums(params, [this.datumOf(id, constraint.kind, constraint.datum, fallback)]);
    }

    /** The solver params of each ref, concatenated in ref order. */
    private pointParams(...refs: readonly SketchPointRef[]): number[] {
        return refs.flatMap((ref) => this.pointParamIds(ref));
    }

    private lineParams(...refs: readonly SketchPointRef[]): number[] {
        return refs.flatMap((ref) => this.linePointParamIds(ref));
    }

    private arcParams(...refs: readonly SketchPointRef[]): number[] {
        return refs.flatMap((ref) => this.arcPointParamIds(ref));
    }

    /**
     * One datum as a source/value pair. `source === undefined` is the datumless case: the
     * geometry's current value becomes both the source and the value, exactly as before.
     *
     * An expression that does not resolve does NOT throw — the dimension falls back to
     * that same geometric value and the error is recorded in `datumErrors`, mirroring how
     * a failed feature keeps the body's last good shape. A bad expression must not make
     * the sketch unopenable; the editor surfaces it on the annotation instead.
     */
    private datumOf(
        id: number,
        kind: ConstraintKind,
        source: ParameterValue | undefined,
        fallback: () => number,
    ): DatumValue {
        if (source === undefined) {
            const value = fallback();
            return { source: value, value };
        }
        const resolved = resolveDatumSource(kind, source, this._scope);
        if (resolved.isOk) return { source, value: resolved.value };
        this._datumErrors.set(id, resolved.error);
        return { source, value: fallback() };
    }

    private withDatums(params: number[], datums: readonly DatumValue[]): ConstraintParams {
        const datumParamIds = datums.map((datum) => this.createDatumParam(datum.value));
        return {
            params: [...params, ...datumParamIds],
            datumParamIds,
            datumSources: datums.map((datum) => datum.source),
        };
    }

    createDatumParam(value: number): number {
        return Number(
            this.system.add_params(new Uint8Array([PARAM_KIND_LENGTH]), new Float64Array([value]))[0],
        );
    }

    /** [l1.p1, l1.p2, l2.p1, l2.p2] param ids for two-line constraints. */
    private twoLineParams(refs: SketchPointRef[]): number[] {
        return [
            ...this.linePointParamIds(refs[0]),
            ...this.linePointParamIds(refs[1]),
            ...this.linePointParamIds(refs[2]),
            ...this.linePointParamIds(refs[3]),
        ];
    }

    private typedPointParamIds(ref: SketchPointRef, type: SketchEntityType): [number, number] {
        // datum axes pass as lines; the origin is a bare point and never matches here
        if (isDatumEntityId(ref.entityId)) {
            if (type === "line" && ref.entityId !== SKETCH_ORIGIN_ID) {
                return this.pointParamIds(ref);
            }
            throw new Error(`Datum entity ${ref.entityId} is not a ${type}`);
        }
        if (this.typeOf(ref.entityId) !== type) {
            throw new Error(`Entity ${ref.entityId} is not a ${type}`);
        }
        return this.pointParamIds(ref);
    }

    /** Entity type of a real or external entity, undefined when unknown. */
    private typeOf(entityId: number): SketchEntityType | undefined {
        return this.entityTypes.get(entityId);
    }

    private linePointParamIds(ref: SketchPointRef): [number, number] {
        return this.typedPointParamIds(ref, "line");
    }

    private circleCenterParamIds(ref: SketchPointRef): [number, number] {
        return this.typedPointParamIds(ref, "circle");
    }

    private arcPointParamIds(ref: SketchPointRef): [number, number] {
        return this.typedPointParamIds(ref, "arc");
    }

    private pointCacheIndices(ref: SketchPointRef): [number, number] {
        const type = this.entityTypes.get(ref.entityId);
        if ((type === "line" || type === "spline") && (ref.pointIndex === 0 || ref.pointIndex === 1)) {
            return [ref.pointIndex * 2, ref.pointIndex * 2 + 1];
        }
        if (
            type === "bspline" &&
            Number.isInteger(ref.pointIndex) &&
            ref.pointIndex >= 0 &&
            ref.pointIndex * 2 + 1 < this.entityParams.get(ref.entityId)!.length
        ) {
            return [ref.pointIndex * 2, ref.pointIndex * 2 + 1];
        }
        if ((type === "arc" || type === "ellipse") && ref.pointIndex >= 0 && ref.pointIndex <= 2) {
            return [ref.pointIndex * 2, ref.pointIndex * 2 + 1];
        }
        if ((type === "circle" || type === "point") && ref.pointIndex === 0) {
            return [0, 1];
        }
        throw new Error(`Invalid point ref ${ref.entityId}:${ref.pointIndex}`);
    }

    private pointParamIds(ref: SketchPointRef): [number, number] {
        const datum = this.datumParams.get(ref.entityId);
        if (datum !== undefined) {
            return [datum[ref.pointIndex * 2], datum[ref.pointIndex * 2 + 1]];
        }
        const [x, y] = this.pointCacheIndices(ref);
        const params = this.entityParams.get(ref.entityId)!;
        return [params[x], params[y]];
    }

    private radiusParamId(entityId: number): number {
        if (this.entityTypes.get(entityId) !== "circle") {
            throw new Error(`Entity ${entityId} is not a circle`);
        }
        return this.entityParams.get(entityId)![2];
    }

    private currentDistance(a: SketchPointRef, b: SketchPointRef): number {
        const [ax, ay] = this.pointOf(a);
        const [bx, by] = this.pointOf(b);
        return Math.hypot(bx - ax, by - ay);
    }

    /** Radius from the cache: params[2] for circles, ‖start−center‖ for arcs. */
    private currentRadius(entityId: number): number {
        const params = this.entityCache.get(entityId)!;
        if (this.entityTypes.get(entityId) === "arc") {
            return Math.hypot(params[2] - params[0], params[3] - params[1]);
        }
        return params[2];
    }

    /** solver-signed perpendicular distance (negative of the usual cross-product sign). */
    private currentP2LDistance(refs: SketchPointRef[]): number {
        const [px, py] = this.pointOf(refs[0]);
        const [x1, y1] = this.pointOf(refs[1]);
        const [x2, y2] = this.pointOf(refs[2]);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        if (length < 1e-12) return 0;
        return (dy * (px - x1) - dx * (py - y1)) / length;
    }

    /** Angle magnitude (radians) between the directions of the two referenced lines. */
    private currentAngle(refs: SketchPointRef[]): number {
        return Math.abs(this.currentSweep(refs));
    }

    /** Signed axis distance (axis 0: p2.x − p1.x; axis 1: p2.y − p1.y). */
    private currentSignedDistance(a: SketchPointRef, b: SketchPointRef, axis: 0 | 1): number {
        return this.pointOf(b)[axis] - this.pointOf(a)[axis];
    }

    // ------------------------------------------------------------------ Load and param cache

    private refreshCache(): void {
        const all: number[] = [];
        for (const ids of this.entityParams.values()) {
            all.push(...ids);
        }
        if (all.length === 0) return;
        const values = this.system.get_params(new Uint32Array(all));
        let offset = 0;
        for (const [id, ids] of this.entityParams) {
            const interior = this.entityTypes.get(id) === "spline" ? this.entityCache.get(id)!.slice(4) : [];
            this.entityCache.set(id, [...values.slice(offset, offset + ids.length), ...interior]);
            offset += ids.length;
        }
    }

    private loadData(data: SketchData): void {
        // The constraints are rebuilt below, so their datum errors are too.
        this._datumErrors.clear();
        this.external.refPositions = data.refPositions === undefined ? undefined : { ...data.refPositions };
        // external refs seed before the constraints that may reference them
        for (const ref of data.externalRefs ?? []) {
            this.external.addExternalEntity(ref);
        }
        for (const entity of data.entities) {
            this.registerEntity(entity.type, this.addEntityParams(entity.type, entity.params), entity.id);
            if (entity.type === "spline") this.entityCache.set(entity.id, [...entity.params]);
            if (entity.type === "bspline") {
                this.attachBSpline(
                    entity.id,
                    entity.parametrization,
                    entity.periodic === true,
                    entity.control,
                );
            }
            if (entity.construction) this.constructionEntities.add(entity.id);
        }
        for (const constraint of data.constraints) {
            this.addConstraintWithId(constraint.id, constraint);
        }
        this.legacyCounters = {};
        if (data.entityIdSeq !== undefined) this.legacyCounters.entityIdSeq = data.entityIdSeq;
        if (data.externalIdSeq !== undefined) this.legacyCounters.externalIdSeq = data.externalIdSeq;
        // normalize roles for documents written before role derivation (and for
        // hand-edited data): an unpinned ref any constraint references is a profile
        syncExternalRoles({ constraints: data.constraints, externalRefs: [...this.external.refs] });
        this.solve(true);
    }

    private addEntityParams(type: SketchEntityType, values: number[]): number[] {
        const ids = this.system.add_params(
            new Uint8Array(entityParamKinds(type, values)),
            new Float64Array(type === "spline" ? values.slice(0, 4) : values),
        );
        return Array.from(ids);
    }
}
