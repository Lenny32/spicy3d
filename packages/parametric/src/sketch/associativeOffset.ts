// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    bsplineEndIndexes,
    ConstraintKind,
    isStructuralConstraint,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
} from "./sketchModel";

/** Only actual open-curve endpoints can drive connectors; centers/interior poles cannot. */
export function offsetEndpointIndexes(entity: SketchEntityData): readonly number[] {
    if (entity.type === "line") return [0, 1];
    if (entity.type === "arc") return [1, 2];
    if (entity.type === "bspline") return bsplineEndIndexes(entity) ?? [];
    return [];
}

/** A connector cannot also feed an offset: that would create a regeneration feedback loop. */
export function allowsOffsetEndpointJoin(
    constraint: Pick<SketchConstraintData, "kind" | "refs">,
    targetId: number,
    data: Pick<SketchData, "entities" | "constraints">,
): boolean {
    if (constraint.kind !== ConstraintKind.P2PCoincident || constraint.refs.length !== 2) return false;
    const targetRefs = constraint.refs.filter((r) => r.entityId === targetId);
    if (targetRefs.length !== 1) return false;
    const target = data.entities.find((e) => e.id === targetId);
    const other = constraint.refs.find((r) => r.entityId !== targetId)!;
    const connector = data.entities.find((e) => e.id === other.entityId);
    return (
        !!target &&
        !!connector &&
        offsetEndpointIndexes(target).includes(targetRefs[0].pointIndex) &&
        ["line", "arc"].includes(connector.type) &&
        offsetEndpointIndexes(connector).includes(other.pointIndex) &&
        !data.constraints.some(
            (c) =>
                (c.kind === ConstraintKind.Offset && c.refs.some((r) => r.entityId === connector.id)) ||
                (c.kind === ConstraintKind.Block && c.refs.some((r) => r.entityId === connector.id)) ||
                (c.kind === ConstraintKind.Fix &&
                    c.refs.some((r) => r.entityId === connector.id && r.pointIndex === other.pointIndex)),
        )
    );
}

export const OFFSET_TARGET_CONSTRAINT_ERROR =
    "only endpoint Coincident with a connecting line or arc is supported; the connector endpoint must be movable and must not belong to an offset source or target. Detach the relation before adding other constraints";

/** Validate persisted relations before allocating solver state; references stay entity-id based. */
export function validateOffsetRelations(data: SketchData): void {
    const offsets = data.constraints.filter((c) => c.kind === ConstraintKind.Offset);
    const targets = new Set<number>();
    for (const c of offsets) {
        const fail = (message: string): never => {
            throw new Error(`Offset constraint ${c.id}: ${message}`);
        };
        if (c.refs.length !== 2 || c.refs.some((r) => r.pointIndex !== 0))
            fail("expected source and target entity references");
        const [sourceRef, targetRef] = c.refs;
        const source = data.entities.find((e) => e.id === sourceRef.entityId);
        const target = data.entities.find((e) => e.id === targetRef.entityId);
        if (!source || !target) fail("source or target entity is missing");
        if (source!.id === target!.id || targets.has(target!.id))
            fail("target must have one distinct source");
        if (!["line", "arc", "circle", "bspline"].includes(source!.type) || source!.type !== target!.type)
            fail("source and target must be matching supported curve types");
        if (
            !(typeof c.datum === "number" && Number.isFinite(c.datum)) &&
            !(typeof c.datum === "string" && c.datum.trim())
        )
            fail("distance must be a finite number or expression");
        targets.add(target!.id);
        if (
            data.constraints.some(
                (other) =>
                    other.id !== c.id &&
                    other.kind !== ConstraintKind.Offset &&
                    other.refs.some((r) => r.entityId === target!.id) &&
                    !isStructuralConstraint(other, data.entities) &&
                    !allowsOffsetEndpointJoin(other, target!.id, data),
            )
        )
            fail(OFFSET_TARGET_CONSTRAINT_ERROR);
    }
    for (const c of offsets)
        if (targets.has(c.refs[0].entityId))
            throw new Error(`Offset constraint ${c.id}: associative offset chains are not supported`);
}
