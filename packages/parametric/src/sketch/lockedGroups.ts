// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ConstraintKind, entityRadius, type SketchData, type SketchEntityData } from "./sketchModel";

/** Bounds within this distance (mm) of each other count as touching. */
const TOUCH_TOLERANCE = 1e-6;

type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** Entities carrying a Block (Lock) constraint. */
export function lockedEntityIds(data: Pick<SketchData, "constraints">): Set<number> {
    return new Set(
        data.constraints.filter((c) => c.kind === ConstraintKind.Block).map((c) => c.refs[0].entityId),
    );
}

/**
 * The locked drawing `entityId` belongs to, without anything stored about it: locked pieces whose
 * bounds touch form outlines (their pieces share endpoints), then outlines whose extents touch
 * join — holes and inner outlines lie inside their outline. A drawing imported as one piece
 * (`SvgSketchOptions.lock`) so selects and moves as a whole. Undefined when the entity is not locked.
 */
export function lockedGroupOf(
    data: Pick<SketchData, "entities" | "constraints">,
    entityId: number,
): number[] | undefined {
    const locked = lockedEntityIds(data);
    const pieces = data.entities.filter((e) => locked.has(e.id));
    const index = pieces.findIndex((e) => e.id === entityId);
    if (index < 0) return undefined;
    const bounds = pieces.map(entityBounds);
    const outlines = connect(bounds);
    const extents = new Map<number, Bounds>();
    for (const [i, b] of bounds.entries()) {
        const root = outlines(i);
        const extent = extents.get(root);
        extents.set(root, extent ? union(extent, b) : [...b]);
    }
    const roots = [...extents.keys()];
    const drawings = connect(roots.map((root) => extents.get(root)!));
    const drawing = drawings(roots.indexOf(outlines(index)));
    return pieces.filter((_, i) => drawings(roots.indexOf(outlines(i))) === drawing).map((e) => e.id);
}

/** Groups boxes that touch, directly or through others: the group's representative of each index. */
function connect(boxes: Bounds[]): (index: number) => number {
    const parent = boxes.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
    };
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            if (touching(boxes[i], boxes[j])) parent[find(j)] = find(i);
        }
    }
    return find;
}

function union(a: Bounds, b: Bounds): Bounds {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function touching(a: Bounds, b: Bounds): boolean {
    return (
        a[0] <= b[2] + TOUCH_TOLERANCE &&
        b[0] <= a[2] + TOUCH_TOLERANCE &&
        a[1] <= b[3] + TOUCH_TOLERANCE &&
        b[1] <= a[3] + TOUCH_TOLERANCE
    );
}

/** A box holding the whole curve: B-splines lie in their control polygon's hull, arcs in their circle. */
function entityBounds(entity: SketchEntityData): Bounds {
    const p = entity.params;
    if (entity.type === "circle" || entity.type === "arc" || entity.type === "ellipse") {
        let radius = 0;
        if (entity.type === "ellipse") {
            for (let i = 2; i + 1 < p.length; i += 2)
                radius = Math.max(radius, Math.hypot(p[i] - p[0], p[i + 1] - p[1]));
        } else radius = entityRadius(entity);
        return [p[0] - radius, p[1] - radius, p[0] + radius, p[1] + radius];
    }
    const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < p.length; i += 2) {
        bounds[0] = Math.min(bounds[0], p[i]);
        bounds[1] = Math.min(bounds[1], p[i + 1]);
        bounds[2] = Math.max(bounds[2], p[i]);
        bounds[3] = Math.max(bounds[3], p[i + 1]);
    }
    return bounds;
}
