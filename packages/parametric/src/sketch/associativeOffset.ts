// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ConstraintKind, isStructuralConstraint, type SketchData } from "./sketchModel";

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
                    !isStructuralConstraint(other, data.entities),
            )
        )
            fail("detach the relation before constraining its target");
    }
    for (const c of offsets)
        if (targets.has(c.refs[0].entityId))
            throw new Error(`Offset constraint ${c.id}: associative offset chains are not supported`);
}
