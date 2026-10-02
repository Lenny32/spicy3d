// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@spicy3d/core";
import {
    bsplineEndIndexes,
    ConstraintKind,
    isExternalEntityId,
    type SketchEntityData,
    type SketchEntityType,
    type SketchPointRef,
} from "./sketchModel";
import type { SketchSolver } from "./solver";

/**
 * Every entity a constraint or snap can target: the real sketch entities plus
 * the seeded external references. Externals are pinned (never draggable or
 * deletable), so a constraint snapped onto one is always satisfiable from the
 * sketch side.
 */
export function constraintTargetEntities(solver: SketchSolver): SketchEntityData[] {
    return [...solver.entities().filter((e) => e.derivation !== "offset"), ...solver.externalEntitiesData()];
}

/**
 * Kinds that may reference an external entity: they relate real geometry to the
 * external (which never moves), so the real side follows it. Rigid or datum
 * kinds (Horizontal/Vertical, Fix, distances, angles, Radius) would only fight
 * the external's structural pins — redundant at best, an unsatisfiable conflict
 * at worst.
 */
const ASSOCIATIVE_KINDS: readonly ConstraintKind[] = [
    ConstraintKind.Collinear,
    ConstraintKind.EqualAngle,
    ConstraintKind.Scale,
    ConstraintKind.P2PCoincident,
    ConstraintKind.PointOnLine,
    ConstraintKind.PointOnCircle,
    ConstraintKind.PointOnArc,
    ConstraintKind.Parallel,
    ConstraintKind.Perpendicular,
    ConstraintKind.EqualLength,
    ConstraintKind.EqualRadius,
    ConstraintKind.EqualArcRadius,
    ConstraintKind.TangentLineCircle,
    ConstraintKind.TangentCircleCircle,
    ConstraintKind.TangentLineArc,
    ConstraintKind.TangentArcArc,
    ConstraintKind.TangentCircleArc,
    ConstraintKind.PointOnBSpline,
    ConstraintKind.TangentLineBSpline,
];

export function isAssociativeConstraintKind(kind: ConstraintKind): boolean {
    return ASSOCIATIVE_KINDS.includes(kind);
}

/**
 * Whether `kind` may target the picked entity: an external entity accepts only
 * associative kinds. A rejected pick pubs a status-bar tip and returns false.
 */
export function allowsConstraintOnEntity(kind: ConstraintKind, entityId: number): boolean {
    if (!isExternalEntityId(entityId) || isAssociativeConstraintKind(kind)) return true;
    PubSub.default.pub("statusBarTip", "sketch.externalRefAssociativeOnly");
    return false;
}

/** Point refs addressing an entity as a line (pointIndex 0/1). */
export function lineRefs(entityId: number): SketchPointRef[] {
    return [
        { entityId, pointIndex: 0 },
        { entityId, pointIndex: 1 },
    ];
}

/** Point ref of an entity's center (pointIndex 0 of a circle or an arc). */
export function centerRef(entityId: number): SketchPointRef {
    return { entityId, pointIndex: 0 };
}

/** Point ref of an arc's start (pointIndex 1), the point that fixes its radius. */
export function arcStartRef(entityId: number): SketchPointRef {
    return { entityId, pointIndex: 1 };
}

/** Keyed by the sorted type pair (`[type1, type2].sort().join("+")`). */
const TANGENT_KINDS = new Map<string, ConstraintKind>([
    ["circle+line", ConstraintKind.TangentLineCircle],
    ["arc+line", ConstraintKind.TangentLineArc],
    ["circle+circle", ConstraintKind.TangentCircleCircle],
    ["arc+arc", ConstraintKind.TangentArcArc],
    ["arc+circle", ConstraintKind.TangentCircleArc],
]);

/** The tangency kind relating two entity types, or `undefined` for a pair that is never tangent: two lines. */
export function tangentKindFor(
    type1: SketchEntityType | undefined,
    type2: SketchEntityType | undefined,
): ConstraintKind | undefined {
    return TANGENT_KINDS.get([type1, type2].sort().join("+"));
}

/**
 * The tangent constraint relating two entities, refs in the solver params layout
 * (line endpoints first, then a circle's center, then an arc's center and start).
 * Argument order is irrelevant; `undefined` for a pair that cannot be tangent:
 * two lines.
 */
export function tangentConstraintFor(
    type1: SketchEntityType | undefined,
    entityId1: number,
    type2: SketchEntityType | undefined,
    entityId2: number,
): { kind: ConstraintKind; refs: SketchPointRef[] } | undefined {
    switch (tangentKindFor(type1, type2)) {
        case ConstraintKind.TangentLineCircle: {
            // the line leads the params layout, whichever way round the pair came in
            const [line, circle] = type1 === "line" ? [entityId1, entityId2] : [entityId2, entityId1];
            return { kind: ConstraintKind.TangentLineCircle, refs: [...lineRefs(line), centerRef(circle)] };
        }
        case ConstraintKind.TangentLineArc: {
            const [line, arc] = type1 === "line" ? [entityId1, entityId2] : [entityId2, entityId1];
            return {
                kind: ConstraintKind.TangentLineArc,
                refs: [...lineRefs(line), centerRef(arc), arcStartRef(arc)],
            };
        }
        case ConstraintKind.TangentCircleCircle:
            return {
                kind: ConstraintKind.TangentCircleCircle,
                refs: [centerRef(entityId1), centerRef(entityId2)],
            };
        case ConstraintKind.TangentArcArc:
            return {
                kind: ConstraintKind.TangentArcArc,
                refs: [
                    centerRef(entityId1),
                    arcStartRef(entityId1),
                    centerRef(entityId2),
                    arcStartRef(entityId2),
                ],
            };
        case ConstraintKind.TangentCircleArc: {
            // the circle leads the params layout here too
            const [circle, arc] = type1 === "circle" ? [entityId1, entityId2] : [entityId2, entityId1];
            return {
                kind: ConstraintKind.TangentCircleArc,
                refs: [centerRef(circle), centerRef(arc), arcStartRef(arc)],
            };
        }
        default:
            return undefined;
    }
}

/**
 * The end tangent relating a line and an open bspline (`TangentLineBSpline`): the line runs along
 * the curve's tangent at whichever end is closer to it (measured from the line's endpoints).
 * `undefined` when the pair is not a line and an open bspline — a periodic bspline has no end.
 */
export function bsplineTangentConstraintFor(
    solver: SketchSolver,
    entityId1: number,
    entityId2: number,
): { kind: ConstraintKind; refs: SketchPointRef[] } | undefined {
    const [e1, e2] = [solver.entity(entityId1), solver.entity(entityId2)];
    if (e1 === undefined || e2 === undefined) return undefined;
    const [line, bspline] = e1.type === "line" ? [e1, e2] : [e2, e1];
    if (line.type !== "line" || bspline.type !== "bspline") return undefined;
    const ends = bsplineEndIndexes(bspline);
    if (ends === undefined) return undefined;
    const lineEnds = lineRefs(line.id).map((ref) => solver.pointOf(ref));
    const gap = (pointIndex: number) => {
        const [u, v] = solver.pointOf({ entityId: bspline.id, pointIndex });
        return Math.min(...lineEnds.map(([x, y]) => Math.hypot(x - u, y - v)));
    };
    const end = gap(ends[0]) <= gap(ends[1]) ? ends[0] : ends[1];
    return {
        kind: ConstraintKind.TangentLineBSpline,
        refs: [...lineRefs(line.id), { entityId: bspline.id, pointIndex: end }],
    };
}
