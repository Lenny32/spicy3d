// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type IView,
    LENGTH_UNITS,
    type ParameterValue,
    type Plane,
    Precision,
    Result,
    resolveUnitSpec,
    type Scope,
    UNITLESS,
    type UnitSpec,
    type XYZ,
} from "@spicy3d/core";
import type { EdgeRef } from "../features/edgeRef";
import { bsplineEdgeCount } from "./bsplineEdges";
import type { BSplineParametrization } from "./bsplineGeometry";
import type { ControlBSplineDefinition } from "./controlBSplineGeometry";
import { ConstraintKind } from "./planegcs";
import type { SketchTextData } from "./sketchText";
import { textContours } from "./textGeometry";

export { ConstraintKind };

/** Screen-pixel line width of sketch geometry (entity edges, in and out of the editor). */
export const SKETCH_EDGE_LINE_WIDTH = 2;
/** Profile faces are shaded translucent so a sketch reads as curves, not a solid disc. */
export const SKETCH_PROFILE_OPACITY = 0.2;

export type SketchEntityType = "line" | "circle" | "arc" | "point" | "ellipse" | "spline" | "bspline";

/**
 * line: params = [x1, y1, x2, y2]; circle: params = [cx, cy, r];
 * arc: params = [cx, cy, sx, sy, ex, ey] (center, start, end; radius = ‖s−c‖,
 * counter-clockwise sweep from start to end) — all in sketch (u, v) coordinates.
 * point: [x, y]; ellipse: [cx, cy, ax, ay, bx, by] (center and two
 * perpendicular axis endpoints; radii are the distances from the center).
 * spline: [sx, sy, ex, ey, ...fixedInteriorPoints] — uniform Catmull–Rom through the points
 * (the end points' neighbours duplicated), built as one cubic Bezier edge per pair of neighbouring
 * points; always open. Kept exactly as it is: saved fillets on its edges must keep resolving.
 * bspline: [x0, y0, x1, y1, ...] — the fit points in curve order, ONE interpolating B-spline edge
 * through all of them (`bsplineGeometry.ts`), with `parametrization` and `periodic` below.
 * With `control`, the same params are poles of a polynomial/rational curve, not fit points.
 */
export interface SketchEntityData {
    id: number;
    type: SketchEntityType;
    params: number[];
    /** Construction geometry is editable but never contributes profile edges. */
    construction?: boolean;
    /** Derived cache marker for merge; present only while an Offset constraint owns this entity. */
    derivation?: "offset";
    /** bspline only: where the fit points sit on the curve parameter (the tools always write it; absent reads `chord`). */
    parametrization?: BSplineParametrization;
    /** Control mode: params are editable poles; absent preserves interpolating fit points. */
    control?: ControlBSplineDefinition;
    /** bspline only: a closed, C2 curve — the first fit point is not repeated as the last. */
    periodic?: boolean;
}

/**
 * line: pointIndex 0 = start, 1 = end; circle: pointIndex 0 = center;
 * arc: pointIndex 0 = center, 1 = start, 2 = end.
 * spline: pointIndex 0 = start, 1 = end; interior points are not solver parameters.
 * bspline: pointIndex i = fit point i, or control pole i when control is present.
 * point: pointIndex 0 = location; ellipse: 0 = center, 1/2 = axis endpoints.
 */
export interface SketchPointRef {
    entityId: number;
    pointIndex: number;
}

/** Addressable points per entity type (the `pointIndex` layout of `SketchPointRef`); a bspline has one per fit point. */
const ENTITY_POINT_COUNTS: Record<Exclude<SketchEntityType, "bspline">, number> = {
    circle: 1,
    line: 2,
    arc: 3,
    point: 1,
    ellipse: 3,
    spline: 2,
};

/**
 * Number of point refs an entity of `type` exposes (`pointIndex` runs 0..n−1). A bspline's count
 * follows its fit points, so it needs the entity's `params`.
 */
export function entityPointCount(type: SketchEntityType, params?: readonly number[]): number {
    if (type !== "bspline") return ENTITY_POINT_COUNTS[type];
    if (params === undefined) throw new Error("A B-spline's point count follows its params");
    return Math.floor(params.length / 2);
}

/** The point indexes of a bspline's two ends, undefined for a periodic one (it has none). */
export function bsplineEndIndexes(entity: SketchEntityData): [number, number] | undefined {
    if (entity.type !== "bspline" || entity.periodic === true) return undefined;
    return [0, entityPointCount("bspline", entity.params) - 1];
}

export interface SketchConstraintData {
    id: number;
    kind: ConstraintKind;
    refs: SketchPointRef[];
    /**
     * A literal in solver-storage units, or an expression written in display units
     * that resolves against the document's parameters (`resolveDatumSource`).
     */
    datum?: ParameterValue;
    /** 1: signed datum (CCW positive); -1: migrated clockwise magnitude, including expressions. */
    angleSide?: -1 | 1;
    /** Datum values for multi-datum kinds (Fix = [x, y]); mutually exclusive with `datum`. */
    datums?: ParameterValue[];
    /** Independent entity parameter indexes pinned by Block; stable across reloads. */
    blockedParams?: number[];
    /** Transformed axis for horizontal/vertical relations and projected dimensions. Unit vector in UV. */
    direction?: [number, number];
}

/**
 * The unit a dimension of `kind` measures — what an expression driving it must
 * resolve to, and what `toDatumSource`/`resolveDatumSource` convert between.
 */
export function datumUnitSpec(kind: ConstraintKind): UnitSpec {
    if (kind === ConstraintKind.Scale) return UNITLESS;
    return kind === ConstraintKind.Angle ? ANGLE_UNITS : LENGTH_UNITS;
}

/**
 * Datum value shown in the UI: angles store the signed sweep from the first
 * directed line to the second (CCW positive) and display signed degrees, point-line
 * distances flip sign (UI: positive = left of the line direction; the solver stores
 * the negated signed distance), everything else as stored.
 */
export function toDisplayDatum(kind: ConstraintKind, value: number): number {
    if (kind === ConstraintKind.Angle) return (value * 180) / Math.PI;
    if (kind === ConstraintKind.P2LDistance) return -value;
    return value;
}

/**
 * Datum value for the solver: inverse of `toDisplayDatum`, preserving the angle sign.
 */
export function toStorageDatum(kind: ConstraintKind, value: number): number {
    if (kind === ConstraintKind.Angle) return (value * Math.PI) / 180;
    if (kind === ConstraintKind.P2LDistance) return -value;
    return value;
}

/**
 * The user's input as stored: a literal is converted into storage units right away,
 * an expression is kept verbatim — it is written in display units, and converting it
 * before it resolves would mean re-parsing the conversion on every rebuild.
 */
export function toDatumSource(kind: ConstraintKind, input: ParameterValue): ParameterValue {
    return typeof input === "number" ? toStorageDatum(kind, input) : input;
}

/**
 * A stored datum as the number the solver takes: a literal is already in storage
 * units, an expression resolves against `scope` (in display units, checked against
 * the kind's unit) and is converted afterwards.
 */
export function resolveDatumSource(
    kind: ConstraintKind,
    source: ParameterValue,
    scope: Scope,
): Result<number> {
    if (typeof source === "number") {
        if (kind === ConstraintKind.Scale && (!Number.isFinite(source) || source <= 0)) {
            return Result.err("Length ratio must be finite and positive");
        }
        return Result.ok(source);
    }
    const resolved = resolveUnitSpec(source, scope, datumUnitSpec(kind));
    if (!resolved.isOk) return Result.err(resolved.error);
    if (kind === ConstraintKind.Scale && (!Number.isFinite(resolved.value) || resolved.value <= 0)) {
        return Result.err("Length ratio must be finite and positive");
    }
    return Result.ok(toStorageDatum(kind, resolved.value));
}

/** Where the label of a datum constraint is anchored, relative to its references. */
export type DimensionAnchor =
    /** Signed perpendicular offset from the measured segment (P2PDistance). */
    | { readonly kind: "offset"; readonly offset: number }
    /** Label vector from the circle center (Radius). */
    | { readonly kind: "vector"; readonly dx: number; readonly dy: number };

/** Datum label anchor bound to a constraint id (ids are stable across sessions). */
export interface SketchDimensionAnchor {
    id: number;
    anchor: DimensionAnchor;
}

/**
 * An edge of another node projected onto the sketch plane as construction
 * geometry. The edge is re-matched on the source node's current shape via the
 * stored `EdgeRef` fingerprint (exact `edgeId` hit when the source tracks
 * edges); the last successfully resolved geometry is kept in `snapshot` (sketch
 * UV params in the layout of `type`), so constraints keep solving against stale
 * geometry when resolution fails (`dangling`). Constraints reference external
 * entities as ordinary `{ entityId, pointIndex }` refs — no format change.
 */
export interface ExternalRefData {
    /** Reserved negative id (`<= FIRST_EXTERNAL_ENTITY_ID`), allocated by `sketchIds.ts`. */
    entityId: number;
    /** Source node (the part) the edge lives on. */
    nodeId: string;
    /** Edge fingerprint, with the kernel edgeId when the source provides one. */
    edge: EdgeRef;
    /** "profile" externals join profile building; "reference" ones never do. */
    role: "reference" | "profile";
    /**
     * Set by an explicit profile-role choice: the profile role option when
     * projecting edges, and every `sketch.toggleExternal` flip. Auto-derivation
     * never overrides a pinned ref (see `syncExternalRoles`). An explicit REFERENCE
     * pick (the default role option) stays unpinned — a promotable default: when a
     * constraint later references the edge, derivation promotes it to profile.
     * That is deliberate: reference-role edges never enter `generateShape`, so
     * promotion is the only way a referenced edge can close loops into faces.
     */
    pinned?: boolean;
    /** Last resolved params in sketch UV (line/circle/arc layout matching `type`). */
    snapshot: number[];
    /** Resolved sketch entity type. */
    type: SketchEntityType;
    /** Resolution failed at the last rebuild; `snapshot` is stale (but still builds profiles). */
    dangling?: boolean;
}

export interface SketchData {
    texts?: SketchTextData[];
    entities: SketchEntityData[];
    constraints: SketchConstraintData[];
    /** Datum label positions chosen by the user; absent when never placed. */
    anchors?: SketchDimensionAnchor[];
    /** Edges of other nodes usable as constraint targets (and optionally profiles). */
    externalRefs?: ExternalRefData[];
    /**
     * Timeline anchor per referenced parametric body (nodeId → feature count when
     * the sketch first referenced it). The sketch editor rolls each such body back
     * to this position for the session (see `computeSketchRollback`), so the plane
     * and external references resolve against the geometry they were captured from
     * and features added later are hidden while editing. Recorded only at capture
     * time (sketch creation on a face, `sketch.projectEdges`), never on the
     * resolution/generateShape path.
     */
    refPositions?: Record<string, number>;
    /**
     * Legacy: the next real entity id of the counter ids were once allocated from. Ids are
     * now random and collision-checked (`sketchIds.ts`) so two devices never hand out the
     * same one; a document that has the field keeps it verbatim (the solver never reads nor
     * advances it), new sketches never write it. The merge takes the larger value.
     */
    entityIdSeq?: number;
    /** Legacy, like `entityIdSeq`: the next external entity id of the old downward counter. */
    externalIdSeq?: number;
}

/** Detached, sketch-agnostic clipboard; only relationships wholly inside the selection travel. */
export interface SketchClipboard {
    texts?: SketchTextData[];
    entities: SketchEntityData[];
    constraints: SketchConstraintData[];
    origin: [number, number];
}

export function emptySketchData(): SketchData {
    return { entities: [], constraints: [] };
}

/**
 * Derives unpinned external-ref roles from the constraints referencing them: a ref
 * any constraint (of any kind, dimensions included) points at is "profile", one no
 * constraint references is "reference". Refs with `pinned` keep their stored role —
 * an explicit user choice. Mutates in place; returns whether any role changed.
 * Applied when SketchData is finalized (solver `toData`, `loadData`), never on the
 * resolution/generateShape path.
 */
export function syncExternalRoles(data: Pick<SketchData, "constraints" | "externalRefs">): boolean {
    const refs = data.externalRefs;
    if (refs === undefined || refs.length === 0) return false;
    const referenced = new Set(data.constraints.flatMap((c) => c.refs.map((r) => r.entityId)));
    let changed = false;
    for (const ref of refs) {
        if (ref.pinned === true) continue;
        const role = referenced.has(ref.entityId) ? "profile" : "reference";
        if (ref.role !== role) {
            ref.role = role;
            changed = true;
        }
    }
    return changed;
}

/**
 * Reserved entity ids for the sketch datum: the origin point and the X/Y axis
 * lines. Real entity ids are positive (`sketchIds.ts`), so negatives never clash. Datum entities live only in the solver —
 * never serialized as entities, never rendered as sketch geometry — but
 * constraints may reference them and are serialized as ordinary
 * `SketchConstraintData`.
 */
export const SKETCH_ORIGIN_ID = -1;
export const SKETCH_X_AXIS_ID = -2;
export const SKETCH_Y_AXIS_ID = -3;

export function isDatumEntityId(id: number): boolean {
    return id === SKETCH_ORIGIN_ID || id === SKETCH_X_AXIS_ID || id === SKETCH_Y_AXIS_ID;
}

/**
 * Reserved entity ids for external references are -100 and below, so they never
 * collide with the datum ids (-1..-3) or real entity ids (1+). They are allocated by
 * `sketchIds.ts` (random, collision-checked — a freed id is not reissued either, so a
 * stale `ProfileRef` entity-id set cannot hit a new, unrelated ref).
 * Like the datum, external entities live only in the solver (never serialized as
 * entities); their persistent state is `SketchData.externalRefs`.
 */
export const FIRST_EXTERNAL_ENTITY_ID = -100;

export function isExternalEntityId(id: number): boolean {
    return id <= FIRST_EXTERNAL_ENTITY_ID;
}

/**
 * External refs that participate in profile building: every profile-role ref,
 * including dangling ones — a ref whose source edge is (temporarily) gone keeps
 * contributing its last-known `snapshot`, so the sketch degrades to frozen
 * geometry (drawn red in the editor) instead of failing dependent features with
 * "not closed" errors. A later rebuild that re-matches the edge clears `dangling`
 * and the profile follows the freshened snapshot.
 */
export function profileExternalRefs(data: SketchData): ExternalRefData[] {
    return (data.externalRefs ?? []).filter((ref) => ref.role === "profile");
}

/**
 * Entity ids parallel to the edges `SketchNode.generateShape` emits: the sketch's
 * own entities first, then the profile-role external refs. `sketchProfiles` maps
 * the kernel's source edge indexes through this list on the crossing path. A spline
 * repeats its id once per cubic edge; a bspline once per edge it produced on the
 * loaded kernel — 1 with the kernel's B-spline binding, one per polynomial span on
 * builds without it (`bsplineEdgeCount`).
 */
export function shapeEntityIds(data: SketchData): number[] {
    return [
        ...data.entities
            .filter(isProfileEntity)
            .flatMap((entity) => Array(entityEdgeCount(entity)).fill(entity.id) as number[]),
        ...profileExternalRefs(data).map((r) => r.entityId),
        ...(data.texts ?? []).flatMap((text) => {
            const contours = textContours(text);
            return contours.isOk
                ? contours.value.flatMap((contour, index) => contour.map(() => text.profileIds[index]))
                : [];
        }),
    ];
}

/** Edges a profile entity contributes to the sketch shape. */
function entityEdgeCount(entity: SketchEntityData): number {
    if (entity.type === "spline") return entity.params.length / 2 - 1;
    if (entity.type === "bspline")
        return bsplineEdgeCount(entity.params, entity.periodic === true, entity.control);
    return 1;
}

export function isProfileEntity(entity: SketchEntityData): boolean {
    return entity.type !== "point" && !entity.construction;
}

/** Ellipse params: center, first axis endpoint, second axis endpoint (perpendicular). */
export function ellipsePoint(params: readonly number[], angle: number): [number, number] {
    const [cx, cy, ax, ay, bx, by] = params;
    return [
        cx + (ax - cx) * Math.cos(angle) + (bx - cx) * Math.sin(angle),
        cy + (ay - cy) * Math.cos(angle) + (by - cy) * Math.sin(angle),
    ];
}

/** Point ref of the sketch origin (0, 0). */
export function originRef(): SketchPointRef {
    return { entityId: SKETCH_ORIGIN_ID, pointIndex: 0 };
}

/** The two point refs addressing a datum axis as a line (pointIndex 0/1). */
export function axisLineRefs(axisId: number): [SketchPointRef, SketchPointRef] {
    return [
        { entityId: axisId, pointIndex: 0 },
        { entityId: axisId, pointIndex: 1 },
    ];
}

/** Fixed (u, v) coordinates of a datum point ref. */
export function datumPoint(ref: SketchPointRef): [number, number] {
    if (ref.entityId === SKETCH_ORIGIN_ID) return [0, 0];
    if (ref.entityId === SKETCH_X_AXIS_ID) return ref.pointIndex === 0 ? [0, 0] : [1, 0];
    if (ref.entityId === SKETCH_Y_AXIS_ID) return ref.pointIndex === 0 ? [0, 0] : [0, 1];
    throw new Error(`Not a datum entity: ${ref.entityId}`);
}

/** Synthetic entity data of a datum axis line, for meshes and type checks. */
export function datumEntityData(id: number): SketchEntityData {
    if (id === SKETCH_X_AXIS_ID) return { id, type: "line", params: [0, 0, 1, 0] };
    if (id === SKETCH_Y_AXIS_ID) return { id, type: "line", params: [0, 0, 0, 1] };
    throw new Error(`Not a datum axis: ${id}`);
}

/** Stable string key of a point ref, for grouping/dedup. */
export function pointRefKey(ref: SketchPointRef): string {
    return `${ref.entityId}:${ref.pointIndex}`;
}

export function cloneSketchData(data: SketchData): SketchData {
    return JSON.parse(JSON.stringify(data)) as SketchData;
}

/**
 * Raw counter-clockwise sweep of an arc entity's params [cx, cy, sx, sy, ex, ey],
 * un-normalized, in (−2π, 2π): zero when start and end share a ray, negative when
 * the end ray sits clockwise of the start ray (a near-full-circle arc).
 * `arcAngles` normalizes this into (0, 2π].
 */
export function rawArcSweep(params: number[]): number {
    const [cx, cy, sx, sy, ex, ey] = params;
    return (Math.atan2(ey - cy, ex - cx) - Math.atan2(sy - cy, sx - cx)) % (Math.PI * 2);
}

/**
 * Start angle and counter-clockwise sweep (normalized to (0, 2π]) of an arc
 * entity's params [cx, cy, sx, sy, ex, ey]; the end point only fixes the angle,
 * the radius is always ‖s−c‖.
 */
export function arcAngles(params: number[]): [number, number] {
    const [cx, cy, sx, sy] = params;
    const a0 = Math.atan2(sy - cy, sx - cx);
    const sweep = rawArcSweep(params);
    return [a0, sweep > Precision.Angle ? sweep : sweep + Math.PI * 2];
}

/** Radius of a circle (params[2]) or arc (‖start−center‖) entity. */
export function entityRadius(entity: SketchEntityData): number {
    if (entity.type === "circle") return entity.params[2];
    if (entity.type === "arc") {
        return Math.hypot(entity.params[2] - entity.params[0], entity.params[3] - entity.params[1]);
    }
    throw new Error(`Entity ${entity.id} has no radius`);
}

/** Sketch (u, v) → world: origin + xvec * u + yvec * v. */
export function toWorld(plane: Plane, u: number, v: number): XYZ {
    return plane.origin.add(plane.xvec.multiply(u)).add(plane.yvec.multiply(v));
}

/**
 * World point → sketch (u, v): project onto the plane, then dot with xvec / yvec.
 */
export function toUV(plane: Plane, point: XYZ): [number, number] {
    const vector = plane.project(point).sub(plane.origin);
    return [vector.dot(plane.xvec), vector.dot(plane.yvec)];
}

/**
 * Sketch-plane units per screen pixel at viewport position (x, y), measured with
 * two rays — exact for both camera types, unlike `worldToScreen` which rounds to
 * whole pixels and collapses small spans at low zoom levels. Undefined when the
 * plane is off-ray or the span collapses.
 */
export function worldPerPixel(view: IView, plane: Plane, x: number, y: number): number | undefined {
    const p0 = plane.intersectRay(view.rayAt(x, y));
    const p1 = plane.intersectRay(view.rayAt(x + 1, y));
    if (p0 === undefined || p1 === undefined) return undefined;
    const size = p0.distanceTo(p1);
    return size < 1e-12 ? undefined : size;
}

/** Equations maintaining an entity's own representation must not be user-deletable. */
export function isStructuralConstraint(
    c: SketchConstraintData,
    entities: readonly SketchEntityData[],
): boolean {
    if (!c.refs.length || !c.refs.every((r) => r.entityId === c.refs[0].entityId)) return false;
    const type = entities.find((e) => e.id === c.refs[0].entityId)?.type;
    return (
        (type === "arc" && c.kind === ConstraintKind.PointOnArc) ||
        (type === "ellipse" && c.kind === ConstraintKind.Perpendicular)
    );
}

/** Independent coordinates to pin; arc/ellipse structural equations supply the omitted coordinate. */
export function blockParamIndices(entity: SketchEntityData): number[] {
    const count = entity.type === "spline" ? 4 : entity.params.length;
    let omitted = -1;
    const p = entity.params;
    if (entity.type === "arc") omitted = Math.abs(p[4] - p[0]) > Math.abs(p[5] - p[1]) ? 4 : 5;
    if (entity.type === "ellipse") omitted = Math.abs(p[2] - p[0]) > Math.abs(p[3] - p[1]) ? 4 : 5;
    return Array.from({ length: count }, (_, i) => i).filter((i) => i !== omitted);
}
