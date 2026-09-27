// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, command, type I18nKeys, type ParameterValue } from "@spicy3d/core";
import {
    type DimensionAnchor,
    lineIntersection,
    pointLineFoot,
    pointLineSignedDistance,
    segmentOffset,
    toDisplayDatum,
    toStorageDatum,
} from "../editor/dimensionLayout";
import type { DimensionPreview } from "../editor/sketchAnnotations";
import type { SketchEditor, SketchPickTarget } from "../editor/sketchEditor";
import {
    ConstraintKind,
    datumUnitSpec,
    entityRadius,
    pointRefKey,
    SKETCH_X_AXIS_ID,
    SKETCH_Y_AXIS_ID,
    type SketchConstraintData,
    type SketchPointRef,
} from "../sketchModel";
import type { SketchSolver } from "../solver";
import { allowsConstraintOnEntity, centerRef, lineRefs } from "../solverEntities";
import { SketchConstraintCommand } from "./sketchConstraints";

/**
 * A dimension waiting for its label: previewed while the cursor moves, created on the click
 * that places it. Built from the picked geometry, so the smart dimension can keep one around
 * while it waits to learn whether the next click places it or picks a second item.
 */
interface DimensionCandidate {
    preview(position: [number, number]): DimensionPreview;
    commit(position: [number, number]): void;
}

/** What a smart-dimension click picked — a `SketchPickTarget` that is not a plain position. */
type DimensionSelection = { point: SketchPointRef } | { entityId: number };

/** Point-to-point distance between two picked points. */
function distanceCandidate(
    editor: SketchEditor,
    p1: SketchPointRef,
    p2: SketchPointRef,
): DimensionCandidate | undefined {
    if (!allowsConstraintOnEntity(ConstraintKind.P2PDistance, p1.entityId)) return undefined;
    if (!allowsConstraintOnEntity(ConstraintKind.P2PDistance, p2.entityId)) return undefined;
    const uv1 = editor.solver.pointOf(p1);
    const uv2 = editor.solver.pointOf(p2);
    return {
        preview: (position) => ({ kind: "distance", p1: uv1, p2: uv2, position }),
        commit: (position) => {
            // anchor the label relative to the segment so it follows the geometry
            const offset = segmentOffset(uv1, uv2, position);
            const initial = currentDistance(editor.solver, p1, p2);
            commitDimension(
                editor,
                {
                    kind: ConstraintKind.P2PDistance,
                    refs: normalizeLineRefs(editor.solver, p1, p2),
                    datum: initial,
                },
                { kind: "offset", offset },
                initial,
            );
        },
    };
}

/** Radius of a picked circle or arc. */
function radiusCandidate(editor: SketchEditor, entityId: number): DimensionCandidate | undefined {
    if (!allowsConstraintOnEntity(ConstraintKind.Radius, entityId)) return undefined;
    const entity = editor.solver.entity(entityId);
    if (entity === undefined) return undefined;
    const center: [number, number] = [entity.params[0], entity.params[1]];
    const radius = entityRadius(entity);
    return {
        preview: (position) => ({ kind: "radius", center, radius, position }),
        // anchor the label as a vector from the center so it follows the geometry
        commit: (position) =>
            commitDimension(
                editor,
                {
                    kind: ConstraintKind.Radius,
                    refs: [{ entityId, pointIndex: 0 }],
                    datum: radius,
                },
                { kind: "vector", dx: position[0] - center[0], dy: position[1] - center[1] },
                radius,
            ),
    };
}

/** Signed distance from a picked point to a picked line (or datum axis). */
function pointLineCandidate(
    editor: SketchEditor,
    p: SketchPointRef,
    lineId: number,
): DimensionCandidate | undefined {
    if (!allowsConstraintOnEntity(ConstraintKind.P2LDistance, p.entityId)) return undefined;
    if (!allowsConstraintOnEntity(ConstraintKind.P2LDistance, lineId)) return undefined;
    const l1: SketchPointRef = { entityId: lineId, pointIndex: 0 };
    const l2: SketchPointRef = { entityId: lineId, pointIndex: 1 };
    const uvP = editor.solver.pointOf(p);
    const uv1 = editor.solver.pointOf(l1);
    const uv2 = editor.solver.pointOf(l2);
    return {
        preview: (position) => ({ kind: "pointLine", p: uvP, l1: uv1, l2: uv2, position }),
        commit: (position) => {
            // anchor the label perpendicular to the point→foot segment so it follows the geometry
            const foot = pointLineFoot(uvP, uv1, uv2) ?? uv1;
            // signed datum (display convention: positive = left of the line direction);
            // a signed value keeps the point on its current side instead of mirroring it
            const initial = pointLineSignedDistance(uvP, uv1, uv2);
            commitDimension(
                editor,
                {
                    kind: ConstraintKind.P2LDistance,
                    refs: [p, l1, l2],
                    datum: toStorageDatum(ConstraintKind.P2LDistance, initial),
                },
                { kind: "offset", offset: segmentOffset(uvP, foot, position) },
                initial,
                { positiveOnly: false },
            );
        },
    };
}

/**
 * The angle refs of two lines, each line's endpoints ordered so the measured sector is the
 * one containing `position`. Two crossing lines make four sectors, and reversing one line's
 * direction moves the measurement to the neighbouring sector (θ ↔ 180° − θ) — so, as in
 * Fusion, the angle dimensioned is the one the cursor sits in, not whichever sector the
 * lines' drawing directions happen to span.
 */
function sectorAngleRefs(
    solver: SketchSolver,
    l1Id: number,
    l2Id: number,
    position: [number, number],
): SketchPointRef[] {
    const [r1, r2] = [lineRefs(l1Id), lineRefs(l2Id)];
    const [a1, a2, b1, b2] = [...r1, ...r2].map((r) => solver.pointOf(r));
    const vertex = lineIntersection(a1, a2, b1, b2);
    if (vertex === undefined) return [...r1, ...r2];
    const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
    const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
    const p = [position[0] - vertex[0], position[1] - vertex[1]];
    // p = s·d1 + t·d2: the signs of s and t say which way along each line the sector opens
    const det = d1[0] * d2[1] - d1[1] * d2[0];
    const s = (p[0] * d2[1] - p[1] * d2[0]) / det;
    const t = (d1[0] * p[1] - d1[1] * p[0]) / det;
    return [...(s < 0 ? r1.reverse() : r1), ...(t < 0 ? r2.reverse() : r2)];
}

/** Angle between two picked lines (or datum axes), in the sector the label is placed in. */
function angleCandidate(editor: SketchEditor, l1Id: number, l2Id: number): DimensionCandidate | undefined {
    if (!allowsConstraintOnEntity(ConstraintKind.Angle, l1Id)) return undefined;
    if (!allowsConstraintOnEntity(ConstraintKind.Angle, l2Id)) return undefined;
    const sector = (position: [number, number]) => {
        const refs = sectorAngleRefs(editor.solver, l1Id, l2Id, position);
        return { refs, points: refs.map((r) => editor.solver.pointOf(r)) };
    };
    return {
        preview: (position) => {
            const [a1, a2, b1, b2] = sector(position).points;
            return { kind: "angle", a1, a2, b1, b2, position };
        },
        commit: (position) => {
            const { refs, points } = sector(position);
            const [a1, a2, b1, b2] = points;
            // vertex = line intersection; parallel lines fall back to the centroid so the
            // label anchor still has a sensible reference point
            const vertex = lineIntersection(a1, a2, b1, b2) ?? [
                (a1[0] + a2[0] + b1[0] + b2[0]) / 4,
                (a1[1] + a2[1] + b1[1] + b2[1]) / 4,
            ];
            const d1: [number, number] = [a2[0] - a1[0], a2[1] - a1[1]];
            const d2: [number, number] = [b2[0] - b1[0], b2[1] - b1[1]];
            // signed sweep from d1 to d2: the sign records which side of the first
            // line the second line sits on, so later magnitude edits keep the angle
            // in place instead of flipping the line across its reference
            const initialRad = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
            commitDimension(
                editor,
                { kind: ConstraintKind.Angle, refs, datum: initialRad },
                { kind: "vector", dx: position[0] - vertex[0], dy: position[1] - vertex[1] },
                toDisplayDatum(ConstraintKind.Angle, initialRad),
            );
        },
    };
}

/** The picked item as a line: a sketch line, an external line or a datum axis. */
function selectedLine(editor: SketchEditor, selection: DimensionSelection): number | undefined {
    if (!("entityId" in selection)) return undefined;
    const id = selection.entityId;
    if (id === SKETCH_X_AXIS_ID || id === SKETCH_Y_AXIS_ID) return id;
    return editor.solver.entity(id)?.type === "line" ? id : undefined;
}

/** The picked item as a point: the point itself, or the center of a circle or arc. */
function selectedPoint(editor: SketchEditor, selection: DimensionSelection): SketchPointRef | undefined {
    if ("point" in selection) return selection.point;
    const type = editor.solver.entity(selection.entityId)?.type;
    return type === "circle" || type === "arc" ? centerRef(selection.entityId) : undefined;
}

function isParallel(editor: SketchEditor, l1Id: number, l2Id: number): boolean {
    const [a1, a2, b1, b2] = [...lineRefs(l1Id), ...lineRefs(l2Id)].map((r) => editor.solver.pointOf(r));
    const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
    const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    return Math.abs(cross) <= 1e-9 * Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
}

/** The dimension one item gives on its own: a line its length, a circle or arc its radius. */
function singleCandidate(
    editor: SketchEditor,
    selection: DimensionSelection,
): DimensionCandidate | undefined {
    if (!("entityId" in selection)) return undefined;
    const entity = editor.solver.entity(selection.entityId);
    if (entity?.type === "line")
        return distanceCandidate(editor, ...(lineRefs(entity.id) as [SketchPointRef, SketchPointRef]));
    if (entity?.type === "circle" || entity?.type === "arc") return radiusCandidate(editor, entity.id);
    return undefined;
}

/**
 * The dimension two items give together: two lines their angle (or their distance when
 * parallel), a line and a point — or a circle, by its center — their distance, and two
 * points or centers the distance between them.
 */
function pairCandidate(
    editor: SketchEditor,
    first: DimensionSelection,
    second: DimensionSelection,
): DimensionCandidate | undefined {
    const [line1, line2] = [selectedLine(editor, first), selectedLine(editor, second)];
    const [point1, point2] = [selectedPoint(editor, first), selectedPoint(editor, second)];
    if (line1 !== undefined && line2 !== undefined) {
        return isParallel(editor, line1, line2)
            ? pointLineCandidate(editor, { entityId: line2, pointIndex: 0 }, line1)
            : angleCandidate(editor, line1, line2);
    }
    if (line1 !== undefined && point2 !== undefined) return pointLineCandidate(editor, point2, line1);
    if (point1 !== undefined && line2 !== undefined) return pointLineCandidate(editor, point1, line2);
    if (point1 !== undefined && point2 !== undefined) return distanceCandidate(editor, point1, point2);
    return undefined;
}

/**
 * The sketch selection as smart-dimension picks — a point entity as its point, lines, circles
 * and arcs as themselves. Undefined when any selected item cannot be dimensioned.
 */
function preselection(editor: SketchEditor): DimensionSelection[] | undefined {
    const selections: DimensionSelection[] = [];
    for (const id of editor.selectedEntityIds) {
        const type = editor.solver.entity(id)?.type;
        if (type === "point") selections.push({ point: centerRef(id) });
        else if ((SMART_DIMENSION_TYPES as readonly string[]).includes(type ?? ""))
            selections.push({ entityId: id });
        else return undefined;
    }
    return selections;
}

function isSameSelection(a: DimensionSelection, b: DimensionSelection): boolean {
    if ("point" in a) return "point" in b && pointRefKey(a.point) === pointRefKey(b.point);
    return "entityId" in b && a.entityId === b.entityId;
}

abstract class DimensionCommand extends SketchConstraintCommand {
    /** A fresh controller in the command's slot, so `cancel()` aborts whichever pick is running. */
    protected nextController(): AsyncController {
        this.controller = new AsyncController();
        return this.controller;
    }

    /** Picks the label position with the candidate previewed, then creates it. */
    protected async place(editor: SketchEditor, candidate: DimensionCandidate | undefined): Promise<void> {
        if (candidate === undefined) return;
        const position = await pickDimensionPosition(editor, this.nextController(), (uv) =>
            uv === undefined ? undefined : candidate.preview(uv),
        );
        if (position !== undefined) candidate.commit(position);
    }
}

const SMART_DIMENSION_TYPES = ["line", "circle", "arc"] as const;

/**
 * The smart dimension (Fusion's D). Click a line and its length follows the cursor; click a
 * circle or arc and its radius does — a click on empty space then places it. Clicking a
 * second item instead combines the two: two lines give their angle, a point or center and a
 * line their distance, two points the distance between them. Items selected beforehand count
 * as those clicks.
 */
@command({ key: "dimension.distance", icon: "icon-dDimension" })
export class DistanceDimensionCommand extends DimensionCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        // items selected before the command stand in for the picks: two go straight to
        // placement, one is the first pick; anything else starts from scratch
        const selected = preselection(editor) ?? [];
        const pair = selected.length === 2 ? pairCandidate(editor, selected[0], selected[1]) : undefined;
        if (pair !== undefined || selected.length === 1) editor.selectEntities([]);
        if (pair !== undefined) {
            await this.place(editor, pair);
            return;
        }
        const first =
            selected.length === 1
                ? selected[0]
                : await this.pickSelection(editor, "prompt.pickSketchPointOrEntity", false);
        // the default filter never lets a plain position through; the check narrows the type
        if (first === undefined || "position" in first) return;
        const single = singleCandidate(editor, first);
        // a lone point has no dimension yet: rubber-band from it to the cursor instead
        const anchor = "point" in first ? editor.solver.pointOf(first.point) : undefined;
        const preview = (uv: [number, number]): DimensionPreview | undefined =>
            single?.preview(uv) ??
            (anchor === undefined ? undefined : { kind: "segment", p1: anchor, p2: uv });

        const second = await this.pickSelection(
            editor,
            single === undefined ? "prompt.pickSketchPointOrLine" : "prompt.pickDimensionPositionOrEntity",
            true,
            preview,
            (target) => single !== undefined || !("position" in target),
            first,
        );
        if (second === undefined) return;
        if ("position" in second) {
            single?.commit(second.position);
            return;
        }
        await this.place(editor, pairCandidate(editor, first, second));
    }

    /**
     * Picks the next target, previewing `preview` at the cursor. Clicks `accept` rejects —
     * empty space while there is nothing to place yet, or the item already picked — are
     * ignored and the pick goes on.
     */
    private async pickSelection(
        editor: SketchEditor,
        prompt: I18nKeys,
        datum: boolean,
        preview?: (uv: [number, number]) => DimensionPreview | undefined,
        accept: (target: SketchPickTarget) => boolean = (target) => !("position" in target),
        previous?: DimensionSelection,
    ): Promise<SketchPickTarget | undefined> {
        const controller = this.nextController();
        return pickWithPreview(editor, async () => {
            for (;;) {
                const target = await editor.pickTarget(
                    prompt,
                    SMART_DIMENSION_TYPES,
                    {
                        datum,
                        preview: (uv) =>
                            editor.annotations.setDimensionPreview(
                                uv === undefined ? undefined : preview?.(uv),
                            ),
                    },
                    controller,
                );
                if (target === undefined) return undefined;
                const repeated =
                    previous !== undefined && !("position" in target) && isSameSelection(previous, target);
                if (accept(target) && !repeated) return target;
            }
        });
    }
}

@command({ key: "dimension.radius", icon: "icon-dRadius" })
export class RadiusDimensionCommand extends DimensionCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const entityId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            ["circle", "arc"],
            undefined,
            this.nextController(),
        );
        if (entityId !== undefined) await this.place(editor, radiusCandidate(editor, entityId));
    }
}

/** Runs a pick with a live dimension preview, always clearing the preview afterwards. */
async function pickWithPreview<T>(
    editor: SketchEditor,
    pick: () => Promise<T | undefined>,
): Promise<T | undefined> {
    try {
        return await pick();
    } finally {
        editor.annotations.setDimensionPreview(undefined);
    }
}

/**
 * Picks the dimension-label position with the dimension previewed live. The controller
 * takes the command's slot so `cancel()` aborts exactly this pick, and the preview is
 * cleared once it ends — the placement step the distance-dimension commands share.
 */
async function pickDimensionPosition(
    editor: SketchEditor,
    controller: AsyncController,
    preview: (uv: [number, number] | undefined) => DimensionPreview | undefined,
): Promise<[number, number] | undefined> {
    return pickWithPreview(editor, () =>
        editor.pickPosition(
            "prompt.pickDimensionPosition",
            (uv) => editor.annotations.setDimensionPreview(preview(uv)),
            controller,
        ),
    );
}

/**
 * Creates the constraint right away so the dimension stays visible while the
 * input is open, but commits only on confirm — creation + datum land in a
 * single undo step; cancelling rolls the constraint back from the solver.
 */
function commitDimension(
    editor: SketchEditor,
    constraint: Omit<SketchConstraintData, "id">,
    anchor: DimensionAnchor,
    initial: ParameterValue,
    options?: { apply?: (id: number, value: ParameterValue) => void; positiveOnly?: boolean },
): void {
    const id = editor.solver.addConstraint(constraint);
    editor.dimensionAnchors.set(id, anchor);
    editor.solve(true);
    editor.promptDatum(
        initial,
        (value) => (options?.apply ?? ((cid, v) => editor.solver.setDatumSource(cid, v)))(id, value),
        datumUnitSpec(constraint.kind),
        () => {
            editor.solver.removeConstraint(id);
            editor.dimensionAnchors.delete(id);
            editor.solve(true);
        },
        { positiveOnly: options?.positiveOnly },
    );
}

function currentDistance(solver: SketchSolver, p1: SketchPointRef, p2: SketchPointRef): number {
    const [x1, y1] = solver.pointOf(p1);
    const [x2, y2] = solver.pointOf(p2);
    return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Endpoints shared with neighbours through coincident constraints make the
 * picked refs point at different entities for what is one line. Rewrite such
 * refs to that line's own endpoints so the dimension — and its hover
 * highlight — belongs to the line the user sees.
 */
function normalizeLineRefs(
    solver: SketchSolver,
    p1: SketchPointRef,
    p2: SketchPointRef,
): [SketchPointRef, SketchPointRef] {
    if (p1.entityId === p2.entityId) return [p1, p2];
    const coincident = (a: SketchPointRef, b: SketchPointRef) =>
        solver.coincidentGroup(a).some((r) => pointRefKey(r) === pointRefKey(b));
    for (const entity of solver.entities()) {
        if (entity.type !== "line") continue;
        const start: SketchPointRef = { entityId: entity.id, pointIndex: 0 };
        const end: SketchPointRef = { entityId: entity.id, pointIndex: 1 };
        if (coincident(start, p1) && coincident(end, p2)) return [start, end];
        if (coincident(start, p2) && coincident(end, p1)) return [end, start];
    }
    return [p1, p2];
}

@command({ key: "dimension.pointLineDistance", icon: "icon-cPointLineDistance" })
export class PointLineDistanceCommand extends DimensionCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const p = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.nextController());
        if (p === undefined || !allowsConstraintOnEntity(ConstraintKind.P2LDistance, p.entityId)) return;
        const lineId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.nextController(),
        );
        if (lineId !== undefined) await this.place(editor, pointLineCandidate(editor, p, lineId));
    }
}

@command({ key: "dimension.angle", icon: "icon-dAngle" })
export class AngleDimensionCommand extends DimensionCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        // datum: true — angles against the X/Y axes are a common reference
        const l1Id = await editor.pickEntity(
            "prompt.pickSketchEntity",
            ["line", "spline"],
            { datum: true },
            this.nextController(),
        );
        if (l1Id === undefined || !allowsConstraintOnEntity(ConstraintKind.Angle, l1Id)) return;
        const l2Id = await editor.pickEntity(
            "prompt.pickSketchEntity",
            ["line", "spline"],
            { datum: true },
            this.nextController(),
        );
        if (l2Id !== undefined) await this.place(editor, angleCandidate(editor, l1Id, l2Id));
    }
}

abstract class AxisDistanceCommand extends SketchConstraintCommand {
    protected abstract readonly axis: "h" | "v";

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const kind = this.axis === "h" ? ConstraintKind.HorizontalDistance : ConstraintKind.VerticalDistance;
        this.controller = new AsyncController();
        const p1 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p1 === undefined || !allowsConstraintOnEntity(kind, p1.entityId)) return;
        this.controller = new AsyncController();
        const p2 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p2 === undefined || !allowsConstraintOnEntity(kind, p2.entityId)) return;

        const uv1 = editor.solver.pointOf(p1);
        const uv2 = editor.solver.pointOf(p2);
        const axis = this.axis;
        this.controller = new AsyncController();
        const position = await pickDimensionPosition(editor, this.controller, (uv) =>
            uv === undefined ? undefined : { kind: "axisDistance", p1: uv1, p2: uv2, axis, position: uv },
        );
        if (position === undefined) return;

        // offset along the cross axis from the points' midline
        const base = axis === "h" ? (uv1[1] + uv2[1]) / 2 : (uv1[0] + uv2[0]) / 2;
        const offset = (axis === "h" ? position[1] : position[0]) - base;
        const initial = axis === "h" ? uv2[0] - uv1[0] : uv2[1] - uv1[1];
        commitDimension(
            editor,
            {
                kind,
                refs: [p1, p2],
                datum: initial,
            },
            { kind: "offset", offset },
            initial,
            { positiveOnly: false },
        );
    }
}

@command({ key: "dimension.horizontalDistance", icon: "icon-dDimensionH" })
export class HorizontalDistanceCommand extends AxisDistanceCommand {
    protected readonly axis = "h";
}

@command({ key: "dimension.verticalDistance", icon: "icon-dDimensionV" })
export class VerticalDistanceCommand extends AxisDistanceCommand {
    protected readonly axis = "v";
}
