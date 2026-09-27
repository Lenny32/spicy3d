// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type INode,
    Matrix4,
    type ParameterValue,
    type Plane,
    type Scope,
    ShapeNode,
    ShapeTypes,
} from "@spicy3d/core";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { ParametricBodyNode } from "../parametricBodyNode";
import { applyAutoConstraints } from "../sketch/autoConstraints";
import { addPolygon } from "../sketch/commands/sketchPolygon";
import { addRectangle } from "../sketch/commands/sketchRectangle";
import { applyDimensions, suggestDimensions } from "../sketch/editor/constraintAnalyzer";
import { captureExternalRef, isEdgeCoplanarWithPlane } from "../sketch/externalRef";
import { editableCurve, extendCurve, offsetCurve, splitCurve, trimCurve } from "../sketch/geometryEditing";
import {
    ConstraintKind,
    datumPoint,
    type ExternalRefData,
    entityPointCount,
    isDatumEntityId,
    isExternalEntityId,
    isStructuralConstraint,
    SKETCH_ORIGIN_ID,
    SKETCH_X_AXIS_ID,
    SKETCH_Y_AXIS_ID,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
    type SketchEntityType,
    type SketchPointRef,
    toDatumSource,
    toDisplayDatum,
} from "../sketch/sketchModel";
import type { SketchNode } from "../sketch/sketchNode";
import { SketchSolver } from "../sketch/solver";
import {
    arcStartRef,
    centerRef,
    constraintTargetEntities,
    lineRefs,
    tangentConstraintFor,
} from "../sketch/solverEntities";
import { splinePoints } from "../sketch/splineGeometry";
import { copySketchSelection, type SketchTransform } from "../sketch/utilityOperations";

/**
 * The sketch half of a parametric program: every tool the interactive sketch editor
 * offers, driven headlessly through the same `SketchSolver` API the editor's commands
 * use. A session loads a sketch's data into a solver, applies actions in order —
 * re-solving after each one, like the editor does after every command — and hands back
 * the solved data for the node to store. Any failure throws; the caller's transaction
 * rolls the whole program back.
 */

/** An entity reference: its id, a name given earlier in this program, or a datum name. */
export type SketchEntityKey = number | string;

export interface SketchPointSpec {
    entity: SketchEntityKey;
    point: number;
}

export interface SketchEntitySpec {
    type: SketchEntityType;
    params?: number[];
    /** Spline only: the interpolation points, first and last are the endpoints. */
    points?: [number, number][];
    construction?: boolean;
    /** Names the entity for later refs in this program. */
    name?: string;
}

export interface SketchConstraintSpec {
    kind: string;
    /** Explicit point refs, in the solver's params layout for `kind`. */
    refs?: SketchPointSpec[];
    /** Entities the refs are derived from (the editor's picks) when `refs` is omitted. */
    entities?: SketchEntityKey[];
    /** Points the refs are derived from (coincident, symmetric, point-on, midpoint, fix). */
    points?: SketchPointSpec[];
    /** A number in display units (mm, degrees, ratio), or an expression naming document parameters. */
    datum?: ParameterValue;
    datums?: ParameterValue[];
    /** Unit vector in UV for directional horizontal/vertical relations and dimensions. */
    direction?: [number, number];
    /** Names the constraint for later `setDatum`/`remove` actions in this program. */
    name?: string;
}

/** Every sketch action name, in the order the tool schema lists them. */
export const SKETCH_ACTION_NAMES = [
    "add",
    "rectangle",
    "polygon",
    "remove",
    "setDatum",
    "setConstruction",
    "movePoint",
    "trim",
    "split",
    "extend",
    "offset",
    "move",
    "rotate",
    "mirror",
    "paste",
    "projectEdges",
    "setExternalRole",
    "autoConstrain",
    "autoDimension",
] as const satisfies readonly SketchAction["action"][];

export type SketchAction =
    | { action: "add"; entities?: SketchEntitySpec[]; constraints?: SketchConstraintSpec[] }
    | {
          action: "rectangle";
          corners: [[number, number], [number, number]];
          construction?: boolean;
          name?: string;
      }
    | {
          action: "polygon";
          center: [number, number];
          rim: [number, number];
          sides: number;
          inscribed?: boolean;
          name?: string;
      }
    | { action: "remove"; entities?: SketchEntityKey[]; constraints?: (number | string)[] }
    | { action: "setDatum"; constraint: number | string; value: ParameterValue; index?: number }
    | { action: "setConstruction"; entities: SketchEntityKey[]; value?: boolean }
    | { action: "movePoint"; entity: SketchEntityKey; point: number; to: [number, number] }
    | { action: "trim"; entity: SketchEntityKey; at: [number, number] }
    | { action: "split"; entity: SketchEntityKey; at: [number, number] }
    | { action: "extend"; entity: SketchEntityKey; to: SketchEntityKey; end?: "start" | "end" }
    | { action: "offset"; entity: SketchEntityKey; distance: number; name?: string }
    | { action: "move"; entities: SketchEntityKey[]; delta: [number, number]; copy?: boolean }
    | {
          action: "rotate";
          entities: SketchEntityKey[];
          center: [number, number];
          angle: number;
          copy?: boolean;
      }
    | { action: "mirror"; entities: SketchEntityKey[]; axis: SketchEntityKey; copy?: boolean }
    | { action: "paste"; from: string; entities: number[]; delta?: [number, number] }
    | {
          action: "projectEdges";
          nodeId: string;
          edgeIndexes: number[];
          role?: "reference" | "profile";
          names?: string[];
      }
    | { action: "setExternalRole"; entities: SketchEntityKey[]; role: "reference" | "profile" }
    | { action: "autoConstrain"; entities?: SketchEntityKey[]; tolerance?: number; angleTolerance?: number }
    | { action: "autoDimension" };

/** Names given in one program, per sketch node — they only live for that call. */
export interface SketchNames {
    entities: Map<string, number>;
    constraints: Map<string, number>;
}

/** What the program needs from its caller: node lookup by op id or node id. */
export interface SketchProgramHost {
    resolveNode(ref: unknown, what: string): INode;
    resolveSketch(ref: unknown): SketchNode;
}

/** What one sketch op reports back. */
export interface SketchReport {
    nodeId: string;
    /** Entities the op created, in creation order. */
    entities: { id: number; type: SketchEntityType; construction?: boolean }[];
    /** Constraints the op created (structural ones of arcs/ellipses included). */
    constraints: { id: number; kind: string }[];
    removedConstraints: number[];
    /** Every name given in this program for this sketch → its id. */
    names: Record<string, number>;
    constraintNames: Record<string, number>;
    dofs: number;
    solve: string;
    /** Labels of the dimensions `autoDimension` applied. */
    appliedDimensions?: string[];
}

const DATUM_NAMES: Record<string, number> = {
    origin: SKETCH_ORIGIN_ID,
    xAxis: SKETCH_X_AXIS_ID,
    yAxis: SKETCH_Y_AXIS_ID,
};

const ENTITY_PARAM_COUNTS: Partial<Record<SketchEntityType, number>> = {
    line: 4,
    circle: 3,
    arc: 6,
    point: 2,
    ellipse: 6,
};

const DEFAULT_AUTO_TOLERANCE = 1e-3;

export class SketchSession {
    readonly solver: SketchSolver;
    private readonly report: SketchReport;
    private readonly initialConstraintIds: Set<number>;

    constructor(
        private readonly host: SketchProgramHost,
        private readonly node: SketchNode,
        private readonly names: SketchNames,
        scope: Scope,
    ) {
        this.solver = new SketchSolver(node.plane, node.data, scope);
        // the anchor of the face the sketch sits on outlives its boundary refs (as in the editor)
        this.solver.planeOwnerNodeId = node.planeRef?.nodeId;
        this.initialConstraintIds = new Set(this.solver.toData().constraints.map((c) => c.id));
        this.report = {
            nodeId: node.id,
            entities: [],
            constraints: [],
            removedConstraints: [],
            names: {},
            constraintNames: {},
            dofs: 0,
            solve: "",
        };
    }

    get plane(): Plane {
        return this.node.plane;
    }

    dispose(): void {
        this.solver.dispose();
    }

    /** Applies the actions in order, re-solving after each. Throws naming the failed action. */
    run(actions: readonly SketchAction[]): void {
        actions.forEach((action, index) => {
            try {
                this.apply(action);
                this.solveOrThrow();
            } catch (err) {
                throw new Error(
                    `sketch action ${index} ("${action?.action}") failed: ${(err as Error).message}`,
                );
            }
        });
    }

    /** The solved data to store, with the node's dimension anchors that still have their constraint. */
    finish(): { data: SketchData; report: SketchReport } {
        this.solveOrThrow();
        const data = this.solver.toData();
        const retained = new Set(data.constraints.map((c) => c.id));
        const anchors = this.node.data.anchors?.filter((anchor) => retained.has(anchor.id));
        if (anchors !== undefined && anchors.length > 0) data.anchors = anchors;
        const outcome = this.solver.solve(true);
        // entities a later action removed again (trim, split) are dropped from the report
        const current = new Map(data.entities.map((e) => [e.id, e]));
        const externals = new Set((data.externalRefs ?? []).map((ref) => ref.entityId));
        this.report.entities = this.report.entities
            .filter((e) => current.has(e.id) || externals.has(e.id))
            .map((e) => {
                const entity = current.get(e.id);
                return entity?.construction ? { ...e, construction: true } : e;
            });
        this.report.constraints = data.constraints
            .filter((c) => !this.initialConstraintIds.has(c.id))
            .map((c) => ({ id: c.id, kind: ConstraintKind[c.kind] }));
        this.report.removedConstraints = [...this.initialConstraintIds].filter((id) => !retained.has(id));
        this.report.dofs = outcome.dofs;
        this.report.solve = outcome.result;
        return { data, report: this.report };
    }

    private solveOrThrow(): void {
        if (this.solver.datumErrors.size > 0) {
            const [id, message] = [...this.solver.datumErrors][0];
            throw new Error(`constraint ${id} has an unusable value: ${message}`);
        }
        const outcome = this.solver.solve(true);
        if (outcome.result.startsWith("Ok")) return;
        const diagnosis = this.solver.diagnose();
        const detail = [
            diagnosis.conflicting.length > 0
                ? `conflicting constraints ${diagnosis.conflicting.join(", ")}`
                : "",
            diagnosis.redundant.length > 0 ? `redundant constraints ${diagnosis.redundant.join(", ")}` : "",
        ]
            .filter((x) => x !== "")
            .join("; ");
        throw new Error(`the sketch does not solve (${outcome.result})${detail ? `: ${detail}` : ""}`);
    }

    // ------------------------------------------------------------------ Actions

    private apply(action: SketchAction): void {
        switch (action?.action) {
            case "add":
                for (const entity of action.entities ?? []) this.addEntity(entity);
                for (const constraint of action.constraints ?? []) this.addConstraint(constraint);
                return;
            case "rectangle":
                this.addRectangle(action);
                return;
            case "polygon":
                this.addPolygon(action);
                return;
            case "remove":
                this.remove(action);
                return;
            case "setDatum": {
                // takes the display value: literals are converted to storage units inside
                const result = this.solver.setDatumSource(
                    this.constraintId(action.constraint),
                    action.value,
                    action.index ?? 0,
                );
                if (!result.isOk) throw new Error(result.error);
                return;
            }
            case "setConstruction":
                for (const key of action.entities) {
                    this.solver.setConstruction(this.editableEntity(key).id, action.value ?? true);
                }
                return;
            case "movePoint":
                this.movePoint(action);
                return;
            case "trim":
            case "split": {
                const source = this.editableCurveOf(action.entity);
                const others = constraintTargetEntities(this.solver).filter(editableCurve);
                const edit =
                    action.action === "trim"
                        ? trimCurve(source, others, uv(action.at, "at"))
                        : splitCurve(source, uv(action.at, "at"), others);
                this.applyEdit(edit);
                return;
            }
            case "extend": {
                const source = this.editableCurveOf(action.entity);
                const target = this.solver.entity(this.entityId(action.to));
                if (target === undefined) throw new Error(`unknown extension target ${String(action.to)}`);
                const points = this.solver.entityPoints(source.id);
                const at = action.end === "start" ? points[0] : points[points.length - 1];
                this.applyEdit(extendCurve(source, target, at));
                return;
            }
            case "offset": {
                const edit = offsetCurve(
                    this.editableCurveOf(action.entity),
                    finite(action.distance, "distance"),
                );
                const ids = this.applyEdit(edit);
                if (action.name !== undefined) this.nameEntity(action.name, ids[0]);
                return;
            }
            case "move":
                this.transform(
                    action.entities,
                    { kind: "move", delta: uv(action.delta, "delta") },
                    action.copy,
                );
                return;
            case "rotate":
                this.transform(
                    action.entities,
                    {
                        kind: "rotate",
                        center: uv(action.center, "center"),
                        angle: (finite(action.angle, "angle") * Math.PI) / 180,
                    },
                    action.copy,
                );
                return;
            case "mirror": {
                const axis = this.solver.entity(this.entityId(action.axis));
                if (axis?.type !== "line") throw new Error('"axis" must be a line (or "xAxis"/"yAxis")');
                this.transform(action.entities, { kind: "mirror", axis }, action.copy ?? true);
                return;
            }
            case "paste":
                this.paste(action);
                return;
            case "projectEdges":
                this.projectEdges(action);
                return;
            case "setExternalRole": {
                const ids = new Set(action.entities.map((key) => this.entityId(key)));
                const refs = (this.solver.toData().externalRefs ?? []).map((ref) =>
                    ids.has(ref.entityId) ? { ...ref, role: action.role, pinned: true } : ref,
                );
                const unknown = [...ids].filter((id) => !refs.some((ref) => ref.entityId === id));
                if (unknown.length > 0) throw new Error(`not external references: ${unknown.join(", ")}`);
                this.solver.syncExternalRefs(refs);
                return;
            }
            case "autoConstrain":
                this.autoConstrain(action);
                return;
            case "autoDimension": {
                const suggestions = suggestDimensions(this.solver);
                if (suggestions.length > 0 && !applyDimensions(this.solver, suggestions)) {
                    throw new Error("the suggested dimensions conflict with the sketch");
                }
                this.report.appliedDimensions = [
                    ...(this.report.appliedDimensions ?? []),
                    ...suggestions.map((s) => s.label),
                ];
                return;
            }
            default:
                throw new Error(`unknown sketch action "${(action as { action?: string })?.action}"`);
        }
    }

    addEntity(spec: SketchEntitySpec): number {
        const id = this.createEntity(spec);
        if (spec.construction === true) this.solver.setConstruction(id, true);
        if (spec.name !== undefined) this.nameEntity(spec.name, id);
        this.report.entities.push({ id, type: spec.type });
        return id;
    }

    private createEntity(spec: SketchEntitySpec): number {
        if (spec.type === "spline") {
            // stored params are [start, end, ...interior]; addSpline takes them in curve order
            const points = spec.points ?? splinePoints(evenParams(spec.params ?? [], "spline params"));
            const id = this.solver.addSpline(points);
            if (!id.isOk) throw new Error(id.error);
            return id.value;
        }
        const count = ENTITY_PARAM_COUNTS[spec.type];
        if (count === undefined) throw new Error(`unknown entity type "${spec.type}"`);
        const p = spec.params ?? [];
        if (p.length !== count || !p.every(Number.isFinite)) {
            throw new Error(`a ${spec.type} needs ${count} finite params, got [${p.join(", ")}]`);
        }
        switch (spec.type) {
            case "line":
                return this.solver.addLine(p[0], p[1], p[2], p[3]);
            case "circle":
                if (p[2] <= 0) throw new Error("a circle needs a positive radius");
                return this.solver.addCircle(p[0], p[1], p[2]);
            case "arc":
                return this.solver.addArc(p[0], p[1], p[2], p[3], p[4], p[5]);
            case "point":
                return this.solver.addPoint(p[0], p[1]);
            default:
                return this.solver.addEllipse(p[0], p[1], p[2], p[3], p[4], p[5]);
        }
    }

    addConstraint(spec: SketchConstraintSpec): number {
        const built = this.buildConstraints(spec);
        let last = -1;
        for (const constraint of built) last = this.solver.addConstraint(constraint);
        if (spec.name !== undefined) {
            this.names.constraints.set(spec.name, last);
            this.report.constraintNames[spec.name] = last;
        }
        return last;
    }

    private addRectangle(action: Extract<SketchAction, { action: "rectangle" }>): void {
        const [a, b] = action.corners ?? [];
        const [u1, v1] = uv(a, "corners[0]");
        const [u2, v2] = uv(b, "corners[1]");
        if (Math.abs(u2 - u1) < 1e-7 || Math.abs(v2 - v1) < 1e-7)
            throw new Error("rectangle sides are too small");
        const ids = addRectangle(this.solver, [u1, v1], [u2, v2]);
        const sides = ["top", "right", "bottom", "left"];
        ids.forEach((id, i) => {
            if (action.construction === true) this.solver.setConstruction(id, true);
            if (action.name !== undefined) this.nameEntity(`${action.name}.${sides[i]}`, id);
            this.report.entities.push({ id, type: "line" });
        });
    }

    private addPolygon(action: Extract<SketchAction, { action: "polygon" }>): void {
        const result = addPolygon(
            this.solver,
            uv(action.center, "center"),
            uv(action.rim, "rim"),
            action.sides,
            action.inscribed ?? true,
        );
        if (!result.isOk) throw new Error(result.error);
        for (const id of result.value.entities) {
            this.report.entities.push({ id, type: this.solver.entity(id)!.type });
        }
        if (action.name !== undefined) {
            this.nameEntity(`${action.name}.circle`, result.value.circle);
            result.value.edges.forEach((id, i) => {
                this.nameEntity(`${action.name}.${i}`, id);
            });
        }
    }

    private remove(action: Extract<SketchAction, { action: "remove" }>): void {
        for (const key of action.constraints ?? []) {
            const id = this.constraintId(key);
            const data = this.solver.toData();
            const constraint = data.constraints.find((c) => c.id === id)!;
            if (isStructuralConstraint(constraint, data.entities)) {
                throw new Error(`constraint ${id} is structural (it maintains its entity's shape)`);
            }
            this.solver.removeConstraint(id);
        }
        for (const key of action.entities ?? []) {
            const id = this.entityId(key);
            if (isDatumEntityId(id)) throw new Error("the sketch origin and axes cannot be removed");
            if (isExternalEntityId(id)) this.solver.removeExternalEntity(id);
            else if (this.solver.entity(id) === undefined) throw new Error(`unknown entity ${id}`);
            else this.solver.removeEntity(id);
        }
    }

    private movePoint(action: Extract<SketchAction, { action: "movePoint" }>): void {
        const ref = this.pointRef({ entity: action.entity, point: action.point });
        if (ref.entityId < 1) throw new Error("reference geometry cannot be moved");
        const [u, v] = uv(action.to, "to");
        // the editor's drag path: the dragged group follows, everything else re-solves around it
        this.solver.beginDrag([ref]);
        this.solver.dragTo(ref, u, v);
        this.solver.endDrag();
    }

    private applyEdit(edit: ReturnType<typeof trimCurve>): number[] {
        if (!edit.isOk) throw new Error(edit.error);
        const result = this.solver.applyGeometryEdit(edit.value);
        if (!result.isOk) throw new Error(result.error);
        for (const id of result.value.entityIds) {
            this.report.entities.push({ id, type: this.solver.entity(id)!.type });
        }
        return result.value.entityIds;
    }

    private transform(keys: readonly SketchEntityKey[], transform: SketchTransform, copy = false): void {
        const ids = keys.map((key) => this.editableEntity(key).id);
        if (ids.length === 0) throw new Error('"entities" must not be empty');
        const result = this.solver.applyTransform(ids, transform, undefined, copy);
        if (!result.isOk) throw new Error(result.error);
        if (copy) this.recordCreated(result.value);
    }

    private paste(action: Extract<SketchAction, { action: "paste" }>): void {
        const source = this.host.resolveSketch(action.from);
        const clipboard = copySketchSelection(source.data, action.entities ?? []);
        if (!clipboard.isOk) throw new Error(clipboard.error);
        const delta = action.delta === undefined ? ([0, 0] as [number, number]) : uv(action.delta, "delta");
        const result = this.solver.applyTransform([], { kind: "move", delta }, clipboard.value);
        if (!result.isOk) throw new Error(result.error);
        this.recordCreated(result.value);
    }

    private recordCreated(ids: readonly number[]): void {
        for (const id of ids) this.report.entities.push({ id, type: this.solver.entity(id)!.type });
    }

    private projectEdges(action: Extract<SketchAction, { action: "projectEdges" }>): void {
        const owner = this.host.resolveNode(action.nodeId, "projectEdges node");
        if (owner.id === this.node.id) throw new Error("a sketch cannot project its own edges");
        if (!(owner instanceof ShapeNode) || !owner.shape.isOk) {
            throw new Error(`node "${action.nodeId}" has no valid shape to project edges from`);
        }
        const edges = owner.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const transform = owner.worldTransform();
        const isIdentity = transform.equals(Matrix4.identity());
        const role = action.role ?? "reference";
        const existing = this.solver.toData().externalRefs ?? [];
        (action.edgeIndexes ?? []).forEach((index, i) => {
            const local = edges[index];
            if (local === undefined) {
                throw new Error(
                    `edgeIndex ${index} is out of range on "${action.nodeId}" (0..${edges.length - 1})`,
                );
            }
            const world = isIdentity ? local : (local.transformedMul(transform) as IEdge);
            try {
                if (!isEdgeCoplanarWithPlane(this.plane, world)) {
                    throw new Error(`edge ${index} does not lie in the sketch plane`);
                }
                const edgeId = isBodyTrackingNode(owner) ? owner.edgeIdAt(index) : undefined;
                const ref = captureExternalRef(
                    this.solver.allocateExternalEntityId(),
                    owner.id,
                    this.plane,
                    world,
                    edgeId,
                    role,
                );
                if (ref === undefined) throw new Error(`edge ${index} is neither a line nor a circle/arc`);
                if (existing.some((r) => sameSource(r, ref))) {
                    throw new Error(`edge ${index} is already projected into this sketch`);
                }
                if (role === "profile") ref.pinned = true;
                this.solver.addExternalEntity(ref);
                if (owner instanceof ParametricBodyNode) {
                    this.solver.recordRefPosition(owner.id, owner.rollbackIndex ?? owner.features.length);
                }
                existing.push(ref);
                const name = action.names?.[i];
                if (name !== undefined) this.nameEntity(name, ref.entityId);
                this.report.entities.push({ id: ref.entityId, type: ref.type });
            } finally {
                if (!isIdentity) world.dispose();
            }
        });
    }

    private autoConstrain(action: Extract<SketchAction, { action: "autoConstrain" }>): void {
        const ids =
            action.entities === undefined
                ? this.solver.entities().map((e) => e.id)
                : action.entities.map((key) => this.editableEntity(key).id);
        const tolerance = action.tolerance ?? DEFAULT_AUTO_TOLERANCE;
        const before = new Set(this.solver.toData().constraints.map((c) => c.id));
        for (const id of ids) {
            applyAutoConstraints(this.solver, id, {
                pointTolerance: finite(tolerance, "tolerance"),
                ...(action.angleTolerance === undefined ? {} : { angleToleranceDeg: action.angleTolerance }),
            });
        }
        // The editor infers for one freshly drawn entity against the rest; inferring for
        // several at once finds each shared relation from both sides. Drop the inferred
        // constraints the solver reports redundant, one at a time — a redundant pair
        // reports both, and removing one makes the other independent again.
        for (;;) {
            const redundant = this.solver.diagnose().redundant.filter((id) => !before.has(id));
            if (redundant.length === 0) break;
            this.solver.removeConstraint(redundant[redundant.length - 1]);
        }
    }

    // ------------------------------------------------------------------ Constraints

    private buildConstraints(spec: SketchConstraintSpec): Omit<SketchConstraintData, "id">[] {
        const alias = CONSTRAINT_ALIASES[spec.kind] ?? spec.kind;
        if (spec.refs !== undefined) {
            const kind = parseConstraintKind(alias);
            return [
                this.withDatums(
                    kind,
                    spec,
                    spec.refs.map((ref) => this.pointRef(ref)),
                ),
            ];
        }
        const entities = (spec.entities ?? []).map((key) => this.entityId(key));
        const points = (spec.points ?? []).map((ref) => this.pointRef(ref));
        const typeOf = (id: number) => this.solver.entity(id)?.type;
        const need = (n: number, what: string) => {
            if (entities.length < n) throw new Error(`"${spec.kind}" needs ${what} in "entities"`);
        };
        const needPoints = (n: number) => {
            if (points.length < n) throw new Error(`"${spec.kind}" needs ${n} point(s) in "points"`);
        };
        switch (alias) {
            case "Horizontal":
            case "Vertical":
                if (points.length === 2) return [this.withDatums(parseConstraintKind(alias), spec, points)];
                need(1, "a line");
                return entities.map((id) => this.withDatums(parseConstraintKind(alias), spec, lineRefs(id)));
            case "HorizontalAlign":
            case "VerticalAlign":
            case "P2PCoincident":
            case "P2PDistance":
            case "HorizontalDistance":
            case "VerticalDistance":
                if (points.length === 2) return [this.withDatums(parseConstraintKind(alias), spec, points)];
                if (alias === "P2PDistance" && entities.length === 1) {
                    return [this.withDatums(ConstraintKind.P2PDistance, spec, lineRefs(entities[0]))];
                }
                throw new Error(`"${spec.kind}" needs two "points"`);
            case "Parallel":
            case "Perpendicular":
            case "EqualLength":
            case "Angle":
            case "Scale":
                need(2, "two lines");
                return [
                    this.withDatums(parseConstraintKind(alias), spec, [
                        ...lineRefs(entities[0]),
                        ...lineRefs(entities[1]),
                    ]),
                ];
            case "EqualAngle":
                need(4, "four lines");
                return [
                    this.withDatums(ConstraintKind.EqualAngle, spec, entities.slice(0, 4).flatMap(lineRefs)),
                ];
            case "Equal": {
                need(2, "two entities of the same type");
                const [a, b] = entities;
                const type = typeOf(a);
                if (type !== typeOf(b)) throw new Error('"Equal" needs two entities of the same type');
                if (type === "line")
                    return [
                        this.withDatums(ConstraintKind.EqualLength, spec, [...lineRefs(a), ...lineRefs(b)]),
                    ];
                if (type === "circle")
                    return [this.withDatums(ConstraintKind.EqualRadius, spec, [centerRef(a), centerRef(b)])];
                if (type === "arc")
                    return [
                        this.withDatums(ConstraintKind.EqualArcRadius, spec, [
                            centerRef(a),
                            arcStartRef(a),
                            centerRef(b),
                            arcStartRef(b),
                        ]),
                    ];
                throw new Error('"Equal" applies to lines, circles or arcs');
            }
            case "Tangent": {
                need(2, "two entities");
                const [a, b] = entities;
                const tangent = tangentConstraintFor(typeOf(a), a, typeOf(b), b);
                if (tangent === undefined) throw new Error("tangent does not apply to this pair of entities");
                return [this.withDatums(tangent.kind, spec, tangent.refs)];
            }
            case "PointOn": {
                needPoints(1);
                need(1, "the target entity");
                const [target] = entities;
                const type = typeOf(target);
                if (type === "line")
                    return [
                        this.withDatums(ConstraintKind.PointOnLine, spec, [points[0], ...lineRefs(target)]),
                    ];
                if (type === "circle")
                    return [
                        this.withDatums(ConstraintKind.PointOnCircle, spec, [points[0], centerRef(target)]),
                    ];
                if (type === "arc")
                    return [
                        this.withDatums(ConstraintKind.PointOnArc, spec, [
                            points[0],
                            centerRef(target),
                            arcStartRef(target),
                        ]),
                    ];
                throw new Error('"PointOn" targets a line, circle or arc');
            }
            case "PointOnLine":
            case "Midpoint":
            case "P2LDistance":
                needPoints(1);
                need(1, "a line");
                return [
                    this.withDatums(parseConstraintKind(alias), spec, [points[0], ...lineRefs(entities[0])]),
                ];
            case "Symmetric":
                needPoints(2);
                need(1, "the symmetry line");
                return [
                    this.withDatums(ConstraintKind.Symmetric, spec, [
                        points[0],
                        points[1],
                        ...lineRefs(entities[0]),
                    ]),
                ];
            case "Radius":
            case "EqualRadius":
                need(alias === "Radius" ? 1 : 2, alias === "Radius" ? "a circle or arc" : "two circles");
                return [this.withDatums(parseConstraintKind(alias), spec, entities.map(centerRef))];
            case "Fix":
                needPoints(1);
                return points.map((ref) =>
                    this.withDatums(
                        ConstraintKind.Fix,
                        { ...spec, datums: spec.datums ?? [...this.pointOf(ref)] },
                        [ref],
                    ),
                );
            case "Block":
                need(1, "an entity");
                return entities.map((id) => {
                    if (id < 1) throw new Error("reference geometry cannot be blocked");
                    return { kind: ConstraintKind.Block, refs: [centerRef(id)] };
                });
            case "Collinear": {
                const refs = entities.flatMap((id) => {
                    const type = typeOf(id);
                    return type === "line" ? lineRefs(id) : type === "point" ? [centerRef(id)] : [];
                });
                refs.push(...points);
                if (refs.length < 3) throw new Error('"Collinear" needs two lines, or a line and points');
                // the first two refs are the baseline — they must be distinct
                const a = this.pointOf(refs[0]);
                const second = refs.findIndex((r) => {
                    const b = this.pointOf(r);
                    return Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9;
                });
                if (second < 0) throw new Error('"Collinear" needs two distinct points');
                [refs[1], refs[second]] = [refs[second], refs[1]];
                return [{ kind: ConstraintKind.Collinear, refs }];
            }
            default:
                throw new Error(
                    `constraint "${spec.kind}" needs explicit "refs" (valid kinds: ${constraintKindNames().join(", ")}, plus Tangent, Equal, PointOn, Coincident, Distance)`,
                );
        }
    }

    private withDatums(
        kind: ConstraintKind,
        spec: SketchConstraintSpec,
        refs: SketchPointRef[],
    ): Omit<SketchConstraintData, "id"> {
        const constraint: Omit<SketchConstraintData, "id"> = { kind, refs };
        if (spec.datum !== undefined) constraint.datum = toDatumSource(kind, spec.datum);
        if (spec.datums !== undefined) constraint.datums = spec.datums.map((d) => toDatumSource(kind, d));
        if (spec.direction !== undefined) {
            const [x, y] = uv(spec.direction, "direction");
            const length = Math.hypot(x, y);
            if (length < 1e-12) throw new Error('"direction" must be non-zero');
            constraint.direction = [x / length, y / length];
        }
        return constraint;
    }

    // ------------------------------------------------------------------ References

    private nameEntity(name: string, id: number): void {
        this.names.entities.set(name, id);
        this.report.names[name] = id;
    }

    private entityId(key: SketchEntityKey): number {
        if (typeof key === "number" && Number.isInteger(key)) return key;
        const name = String(key);
        const id = DATUM_NAMES[name] ?? this.names.entities.get(name);
        if (id === undefined) {
            throw new Error(
                `unknown sketch entity "${name}" — use an entity id, "origin"/"xAxis"/"yAxis", or a name given earlier in this program`,
            );
        }
        return id;
    }

    private constraintId(key: number | string): number {
        const id = typeof key === "number" ? key : this.names.constraints.get(String(key));
        if (id === undefined || !this.solver.toData().constraints.some((c) => c.id === id)) {
            throw new Error(`unknown constraint ${String(key)}`);
        }
        return id;
    }

    private pointRef(spec: SketchPointSpec): SketchPointRef {
        const entityId = this.entityId(spec?.entity);
        const pointIndex = spec.point ?? 0;
        const type = isDatumEntityId(entityId)
            ? entityId === SKETCH_ORIGIN_ID
                ? "point"
                : "line"
            : (this.solver.entity(entityId)?.type ??
              this.solver.externalEntitiesData().find((e) => e.id === entityId)?.type);
        if (type === undefined) throw new Error(`unknown sketch entity ${entityId}`);
        if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= entityPointCount(type)) {
            throw new Error(`point ${pointIndex} does not exist on ${type} ${entityId}`);
        }
        return { entityId, pointIndex };
    }

    private pointOf(ref: SketchPointRef): [number, number] {
        return isDatumEntityId(ref.entityId) ? datumPoint(ref) : this.solver.pointOf(ref);
    }

    private editableEntity(key: SketchEntityKey): SketchEntityData {
        const id = this.entityId(key);
        const entity = id > 0 ? this.solver.entity(id) : undefined;
        if (entity === undefined) throw new Error(`${String(key)} is not an editable sketch entity`);
        return entity;
    }

    private editableCurveOf(key: SketchEntityKey): SketchEntityData {
        const entity = this.editableEntity(key);
        if (!editableCurve(entity)) throw new Error(`entity ${entity.id} is not a line, arc or circle`);
        return entity;
    }
}

/** UI names for the constraint kinds whose solver name differs. */
const CONSTRAINT_ALIASES: Record<string, string> = {
    Coincident: "P2PCoincident",
    Distance: "P2PDistance",
    Length: "P2PDistance",
    PointLineDistance: "P2LDistance",
};

export function parseConstraintKind(kind: unknown): ConstraintKind {
    if (typeof kind === "number" && ConstraintKind[kind] !== undefined) return kind as ConstraintKind;
    const name = CONSTRAINT_ALIASES[String(kind)] ?? String(kind);
    const resolved = (ConstraintKind as unknown as Record<string, ConstraintKind | undefined>)[name];
    if (resolved !== undefined) return resolved;
    throw new Error(
        `unknown constraint kind "${String(kind)}" — valid kinds: ${constraintKindNames().join(", ")}`,
    );
}

function constraintKindNames(): string[] {
    return Object.keys(ConstraintKind).filter((key) => Number.isNaN(Number(key)));
}

function sameSource(a: ExternalRefData, b: ExternalRefData): boolean {
    if (a.nodeId !== b.nodeId) return false;
    if (a.edge.edgeId !== undefined && b.edge.edgeId !== undefined) return a.edge.edgeId === b.edge.edgeId;
    return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot);
}

function finite(value: unknown, what: string): number {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`"${what}" must be a finite number`);
    return value;
}

function uv(value: unknown, what: string): [number, number] {
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
        throw new Error(`"${what}" must be [u, v] with finite numbers`);
    }
    return [value[0], value[1]];
}

function evenParams(params: readonly number[], what: string): readonly number[] {
    if (params.length < 4 || params.length % 2 !== 0 || !params.every(Number.isFinite)) {
        throw new Error(`${what} must be an even list of at least 4 finite numbers`);
    }
    return params;
}

// ------------------------------------------------------------------ Reading a sketch back

export interface SketchInfo {
    nodeId: string;
    name: string;
    plane: { origin: number[]; normal: number[]; xvec: number[] };
    planeSource: string;
    entities: (SketchEntityData & { points: [number, number][] })[];
    constraints: {
        id: number;
        kind: string;
        refs: { entity: number; point: number }[];
        datum?: ParameterValue;
        datums?: ParameterValue[];
        structural?: boolean;
        direction?: [number, number];
    }[];
    externals: {
        id: number;
        nodeId: string;
        type: SketchEntityType;
        params: number[];
        role: "reference" | "profile";
        dangling?: boolean;
    }[];
    dofs: number;
    solve: string;
    conflicting: number[];
    redundant: number[];
    /** Size dimensions `autoDimension` would add. */
    suggestedDimensions: string[];
    warning?: string;
}

/** A sketch as plain data: entities with their addressable points, constraints in display units. */
export function describeSketch(node: SketchNode, scope: Scope): SketchInfo {
    const data = node.data;
    const solver = new SketchSolver(node.plane, data, scope);
    try {
        const outcome = solver.solve(true);
        const diagnosis = solver.diagnose();
        const plane = node.plane;
        const vec = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z];
        const info: SketchInfo = {
            nodeId: node.id,
            name: node.name,
            plane: { origin: vec(plane.origin), normal: vec(plane.normal), xvec: vec(plane.xvec) },
            planeSource: node.constructionPlaneRef
                ? `construction ${JSON.stringify(node.constructionPlaneRef)}`
                : node.planeRef
                  ? `face of node ${node.planeRef.nodeId}`
                  : "fixed",
            entities: data.entities.map((entity) => ({
                ...entity,
                points: Array.from({ length: entityPointCount(entity.type) }, (_, pointIndex) =>
                    solver.pointOf({ entityId: entity.id, pointIndex }),
                ),
            })),
            constraints: data.constraints.map((c) => {
                const row: SketchInfo["constraints"][number] = {
                    id: c.id,
                    kind: ConstraintKind[c.kind],
                    refs: c.refs.map((r) => ({ entity: r.entityId, point: r.pointIndex })),
                };
                if (c.datum !== undefined)
                    row.datum = typeof c.datum === "number" ? toDisplayDatum(c.kind, c.datum) : c.datum;
                if (c.datums !== undefined)
                    row.datums = c.datums.map((d) => (typeof d === "number" ? toDisplayDatum(c.kind, d) : d));
                if (c.direction !== undefined) row.direction = c.direction;
                if (isStructuralConstraint(c, data.entities)) row.structural = true;
                return row;
            }),
            externals: (data.externalRefs ?? []).map((ref) => ({
                id: ref.entityId,
                nodeId: ref.nodeId,
                type: ref.type,
                params: ref.snapshot,
                role: ref.role,
                ...(ref.dangling ? { dangling: true } : {}),
            })),
            dofs: outcome.dofs,
            solve: outcome.result,
            conflicting: diagnosis.conflicting,
            redundant: diagnosis.redundant,
            suggestedDimensions: suggestDimensions(solver).map((s) => s.label),
        };
        if (node.warningCount > 0)
            info.warning = String(node.constructionPlaneError ?? "dangling profile reference");
        return info;
    } finally {
        solver.dispose();
    }
}
