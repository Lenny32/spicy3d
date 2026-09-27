// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";
import {
    axisLineRefs,
    blockParamIndices,
    ConstraintKind,
    cloneSketchData,
    entityPointCount,
    nextSketchId,
    type SketchClipboard,
    type SketchConstraintData,
    type SketchData,
    type SketchEntityData,
    type SketchPointRef,
} from "./sketchModel";

export type SketchTransform =
    | { kind: "move"; delta: [number, number] }
    | { kind: "rotate"; center: [number, number]; angle: number }
    | { kind: "mirror"; axis: SketchEntityData };

export function transformPoint(x: number, y: number, transform: SketchTransform): [number, number] {
    if (transform.kind === "move") return [x + transform.delta[0], y + transform.delta[1]];
    if (transform.kind === "rotate") {
        const [cx, cy] = transform.center;
        const c = Math.cos(transform.angle),
            s = Math.sin(transform.angle);
        return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
    }
    const [ax, ay, bx, by] = transform.axis.params;
    const dx = bx - ax,
        dy = by - ay;
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    return [2 * (ax + t * dx) - x, 2 * (ay + t * dy) - y];
}

export function transformEntity(entity: SketchEntityData, transform: SketchTransform): SketchEntityData {
    const params = [...entity.params];
    const count = entity.type === "circle" ? 2 : params.length;
    for (let i = 0; i < count; i += 2) {
        [params[i], params[i + 1]] = transformPoint(params[i], params[i + 1], transform);
    }
    // Arc storage is counter-clockwise: a reflection reverses the endpoint roles.
    if (entity.type === "arc" && transform.kind === "mirror") {
        [params[2], params[3], params[4], params[5]] = [params[4], params[5], params[2], params[3]];
    }
    return { ...entity, params };
}

export function selectionCenter(entities: SketchEntityData[]): [number, number] {
    const points = entities.flatMap((e) => {
        if (e.type === "circle") {
            const [x, y, r] = e.params;
            return [
                [x - r, y - r],
                [x + r, y + r],
            ];
        }
        return Array.from({ length: e.params.length / 2 }, (_, i) => e.params.slice(2 * i, 2 * i + 2));
    });
    if (points.length === 0) return [0, 0];
    return [0, 1].map(
        (i) => (Math.min(...points.map((p) => p[i])) + Math.max(...points.map((p) => p[i]))) / 2,
    ) as [number, number];
}

export function copySketchSelection(data: SketchData, ids: readonly number[]): Result<SketchClipboard> {
    const selected = new Set(ids);
    const snapshot = cloneSketchData(data);
    const entities = snapshot.entities.filter((e) => selected.has(e.id));
    if (entities.length === 0 || entities.length !== selected.size)
        return Result.err("Select editable sketch entities");
    return Result.ok({
        entities,
        constraints: snapshot.constraints.filter(
            (c) => c.refs.length > 0 && c.refs.every((r) => selected.has(r.entityId)),
        ),
        origin: selectionCenter(entities),
    });
}

/** Pure proposal, shared by previews and the solver's atomic commit path. */
export function transformSketchSelection(
    data: SketchData,
    ids: readonly number[],
    transform: SketchTransform,
    clipboard?: SketchClipboard,
    copy = false,
): Result<{ data: SketchData; ids: number[] }> {
    if (
        transform.kind === "mirror" &&
        (transform.axis.type !== "line" ||
            Math.hypot(
                transform.axis.params[2] - transform.axis.params[0],
                transform.axis.params[3] - transform.axis.params[1],
            ) < 1e-8)
    ) {
        return Result.err("Choose a non-degenerate mirror line");
    }
    const selection = clipboard ? Result.ok(clipboard) : copySketchSelection(data, ids);
    if (!selection.isOk) return Result.err(selection.error);
    const source = selection.value;
    const selected = new Set(source.entities.map((e) => e.id));
    if (transform.kind === "mirror" && selected.has(transform.axis.id))
        return Result.err("The mirror axis must be outside the selection");
    const duplicate = copy || clipboard !== undefined;
    const result = cloneSketchData(data);
    let entityId = Math.max(data.entityIdSeq ?? 1, nextSketchId(data.entities));
    const mapping = new Map(source.entities.map((e) => [e.id, duplicate ? entityId++ : e.id]));
    const entities = source.entities.map((e) => ({
        ...transformEntity(e, transform),
        id: mapping.get(e.id)!,
    }));
    if (entities.some((e) => e.params.some((p) => !Number.isFinite(p))))
        return Result.err("Transform values must be finite");
    const remap = (ref: SketchPointRef): SketchPointRef => ({
        entityId: mapping.get(ref.entityId) ?? ref.entityId,
        pointIndex:
            transform.kind === "mirror" &&
            source.entities.find((e) => e.id === ref.entityId)?.type === "arc" &&
            ref.pointIndex > 0
                ? 3 - ref.pointIndex
                : ref.pointIndex,
    });
    const constraints: SketchConstraintData[] = [];
    // Symmetry already transfers the originals' relationships. Duplicating Fix or
    // axis constraints would freeze the copies when the source or mirror axis moves.
    for (const original of copy && transform.kind === "mirror" ? [] : source.constraints) {
        const constraint = { ...original, refs: original.refs.map(remap) };
        const transformed = transformConstraint(constraint, transform, entities);
        if (!transformed.isOk) return Result.err(transformed.error);
        constraints.push(transformed.value);
    }
    if (!duplicate) {
        result.entities = result.entities.map(
            (e) => entities.find((transformed) => transformed.id === e.id) ?? e,
        );
        // Any relationship crossing the selection boundary is detached.
        result.constraints = result.constraints.filter((c) => !c.refs.some((r) => selected.has(r.entityId)));
    }
    if (duplicate) result.entities.push(...entities);
    let constraintId = nextSketchId(data.constraints);
    result.constraints.push(...constraints.map((c) => ({ ...c, id: duplicate ? constraintId++ : c.id })));
    if (copy && transform.kind === "mirror") {
        for (const e of source.entities) {
            for (let pointIndex = 0; pointIndex < entityPointCount(e.type); pointIndex++) {
                const original = { entityId: e.id, pointIndex };
                result.constraints.push({
                    id: constraintId++,
                    kind: ConstraintKind.Symmetric,
                    refs: [original, remap(original), ...axisLineRefs(transform.axis.id)],
                });
            }
            if (e.type === "circle")
                result.constraints.push({
                    id: constraintId++,
                    kind: ConstraintKind.EqualRadius,
                    refs: [
                        { entityId: e.id, pointIndex: 0 },
                        { entityId: mapping.get(e.id)!, pointIndex: 0 },
                    ],
                });
        }
    }
    result.entityIdSeq = entityId;
    const retained = new Set(result.constraints.map((c) => c.id));
    if (result.anchors) result.anchors = result.anchors.filter((a) => retained.has(a.id));
    return Result.ok({ data: result, ids: entities.map((e) => e.id) });
}

function transformConstraint(
    c: SketchConstraintData,
    t: SketchTransform,
    entities: SketchEntityData[],
): Result<SketchConstraintData> {
    const point = (ref: SketchPointRef) => {
        const e = entities.find((e) => e.id === ref.entityId)!;
        return e.params.slice(ref.pointIndex * 2, ref.pointIndex * 2 + 2);
    };
    if (c.kind === ConstraintKind.Block) {
        const entity = entities.find((e) => e.id === c.refs[0].entityId)!;
        return Result.ok({
            ...c,
            datums: blockParamIndices(entity).map((i) => entity.params[i]),
            blockedParams: blockParamIndices(entity),
        });
    }
    if (c.kind === ConstraintKind.Fix) {
        // Fix follows the transformed point, including parameter-driven coordinates.
        if (!c.datums?.some((d) => typeof d === "string"))
            return Result.ok({ ...c, datums: point(c.refs[0]) });
        const origin = transformPoint(0, 0, t);
        const x = transformPoint(1, 0, t),
            y = transformPoint(0, 1, t);
        const datums = [0, 1].map((i) => {
            const terms = [x[i] - origin[i], y[i] - origin[i]].flatMap((coefficient, j) => {
                if (Math.abs(coefficient) < 1e-12) return [];
                const source = c.datums![j];
                return [`(${source}) * (${coefficient})`];
            });
            terms.push(`(${origin[i]})`);
            return terms.join(" + ");
        });
        return Result.ok({ ...c, datums });
    }
    if (t.kind === "move") return Result.ok(c);
    const horizontal = c.kind === ConstraintKind.Horizontal || c.kind === ConstraintKind.HorizontalAlign;
    const vertical = c.kind === ConstraintKind.Vertical || c.kind === ConstraintKind.VerticalAlign;
    if (
        horizontal ||
        vertical ||
        c.kind === ConstraintKind.HorizontalDistance ||
        c.kind === ConstraintKind.VerticalDistance
    ) {
        const direction =
            c.direction ?? (vertical || c.kind === ConstraintKind.VerticalDistance ? [0, 1] : [1, 0]);
        const origin = transformPoint(0, 0, t);
        const end = transformPoint(direction[0], direction[1], t);
        return Result.ok({ ...c, direction: [end[0] - origin[0], end[1] - origin[1]] });
    }
    if (
        t.kind === "mirror" &&
        (c.kind === ConstraintKind.Angle || c.kind === ConstraintKind.P2LDistance) &&
        c.datum !== undefined
    ) {
        return Result.ok({ ...c, datum: typeof c.datum === "number" ? -c.datum : `-(${c.datum})` });
    }
    return Result.ok(c);
}
