// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Precision, Result } from "@spicy3d/core";
import { arcAngles, entityRadius, type SketchEntityData } from "./sketchModel";

type UV = [number, number];
const TAU = 2 * Math.PI;
const EPS = Precision.Distance;
const mod = (a: number) => ((a % TAU) + TAU) % TAU;

/** A pure edit proposal. IDs are assigned only when the solver applies it. */
export interface GeometryEdit {
    source: SketchEntityData;
    pieces: SketchEntityData[];
    preview: SketchEntityData[];
    copy?: boolean;
}

export function editableCurve(entity: SketchEntityData): boolean {
    const count = entity.type === "line" ? 4 : entity.type === "arc" ? 6 : 3;
    return (
        ["line", "arc", "circle"].includes(entity.type) &&
        entity.params.length === count &&
        entity.params.every(Number.isFinite) &&
        Number.isFinite(curveLength(entity)) &&
        curveLength(entity) > EPS
    );
}

function curveLength(e: SketchEntityData): number {
    if (e.type === "line") return Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1]);
    return entityRadius(e) * (e.type === "arc" ? arcAngles(e.params)[1] : TAU);
}

/** Lines use [0,1]; circular curves use counter-clockwise radians from their start. */
function endParameter(e: SketchEntityData): number {
    return e.type === "line" ? 1 : e.type === "arc" ? arcAngles(e.params)[1] : TAU;
}

function parameter(e: SketchEntityData, p: UV): number {
    const [x, y, sx, sy] = e.params;
    if (e.type === "line") {
        const dx = sx - x;
        const dy = sy - y;
        return ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    }
    return mod(Math.atan2(p[1] - y, p[0] - x) - (e.type === "arc" ? arcAngles(e.params)[0] : 0));
}

function point(e: SketchEntityData, t: number): UV {
    const [x, y, sx, sy] = e.params;
    if (e.type === "line") return [x + t * (sx - x), y + t * (sy - y)];
    const angle = t + (e.type === "arc" ? arcAngles(e.params)[0] : 0);
    const radius = entityRadius(e);
    return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
}

function piece(e: SketchEntityData, start: number, end: number): SketchEntityData {
    return {
        ...e,
        type: e.type === "line" ? "line" : "arc",
        params:
            e.type === "line"
                ? [...point(e, start), ...point(e, end)]
                : [...e.params.slice(0, 2), ...point(e, start), ...point(e, end)],
    };
}

function contains(e: SketchEntityData, p: UV): boolean {
    const t = parameter(e, p);
    const tolerance = (EPS * endParameter(e)) / curveLength(e);
    return t >= -tolerance && (t <= endParameter(e) + tolerance || (e.type === "arc" && TAU - t < tolerance));
}

/** Intersections of supporting lines/circles, optionally clipped to either curve. */
export function curveIntersections(a: SketchEntityData, b: SketchEntityData, extendA = false): UV[] {
    if (!editableCurve(a) || !editableCurve(b)) return [];
    const p = a.params;
    const q = b.params;
    let hits: UV[] = [];
    if (a.type === "line" && b.type === "line") {
        const dx = p[2] - p[0],
            dy = p[3] - p[1];
        const ex = q[2] - q[0],
            ey = q[3] - q[1];
        const cross = dx * ey - dy * ex;
        if (Math.abs(cross) > 1e-12 * Math.hypot(dx, dy) * Math.hypot(ex, ey)) {
            const t = ((q[0] - p[0]) * ey - (q[1] - p[1]) * ex) / cross;
            hits = [point(a, t)];
        }
    } else if (a.type === "line" || b.type === "line") {
        const line = a.type === "line" ? a : b;
        const circle = a.type === "line" ? b : a;
        const [x, y, x2, y2] = line.params;
        const dx = x2 - x,
            dy = y2 - y;
        const cx = circle.params[0],
            cy = circle.params[1];
        const length2 = dx * dx + dy * dy;
        const foot = ((cx - x) * dx + (cy - y) * dy) / length2;
        const closest = point(line, foot);
        const h2 = entityRadius(circle) ** 2 - (closest[0] - cx) ** 2 - (closest[1] - cy) ** 2;
        if (h2 >= -EPS * EPS) {
            const dt = Math.sqrt(Math.max(0, h2) / length2);
            hits = [point(line, foot - dt), point(line, foot + dt)];
        }
    } else {
        const dx = q[0] - p[0],
            dy = q[1] - p[1];
        const d = Math.hypot(dx, dy),
            r = entityRadius(a),
            s = entityRadius(b);
        if (d > EPS && d <= r + s + EPS && d >= Math.abs(r - s) - EPS) {
            const along = (r * r - s * s + d * d) / (2 * d);
            const h = Math.sqrt(Math.max(0, r * r - along * along));
            const x = p[0] + (along * dx) / d,
                y = p[1] + (along * dy) / d;
            hits = [
                [x - (h * dy) / d, y + (h * dx) / d],
                [x + (h * dy) / d, y - (h * dx) / d],
            ];
        }
    }
    return hits.filter(
        (p, i) =>
            (extendA || contains(a, p)) &&
            contains(b, p) &&
            hits.findIndex((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < EPS) === i,
    );
}

export function trimCurve(
    source: SketchEntityData,
    others: SketchEntityData[],
    at: UV,
): Result<GeometryEdit> {
    if (!editableCurve(source) || !at.every(Number.isFinite))
        return Result.err("Select a line, arc or circle");
    const end = endParameter(source);
    const tolerance = (EPS * end) / curveLength(source);
    const cuts = others
        .filter((e) => e.id !== source.id)
        .flatMap((e) => curveIntersections(source, e))
        .map((p) => parameter(source, p))
        .sort((a, b) => a - b)
        .filter((v, i, a) => i === 0 || v - a[i - 1] > tolerance);
    const t = parameter(source, at);
    if (source.type === "circle") {
        if (cuts.length < 2) return Result.err("A circle needs two distinct intersections to trim");
        const lo = cuts.filter((c) => c <= t).at(-1) ?? cuts[cuts.length - 1] - TAU;
        const hi = cuts.find((c) => c > t) ?? cuts[0] + TAU;
        return Result.ok({ source, pieces: [piece(source, hi, lo + TAU)], preview: [piece(source, lo, hi)] });
    }
    const boundaries = [0, ...cuts.filter((c) => c > tolerance && c < end - tolerance), end];
    // An endpoint hover still trims the adjacent interval; it must not create a zero-length preview.
    const projected = source.type === "arc" && t > end && TAU - t < t - end ? 0 : t;
    const inside = Math.max(0, Math.min(end - tolerance, projected));
    const lo = boundaries.filter((c) => c <= inside).at(-1) ?? 0;
    const hi = boundaries.find((c) => c > inside) ?? end;
    const pieces: SketchEntityData[] = [];
    if (lo > tolerance) pieces.push(piece(source, 0, lo));
    if (hi < end - tolerance) pieces.push(piece(source, hi, end));
    return Result.ok({ source, pieces, preview: [piece(source, lo, hi)] });
}

/** A circle is broken at the pick and its antipode, giving two nondegenerate arcs. */
export function splitCurve(
    source: SketchEntityData,
    at: UV,
    others: SketchEntityData[] = [],
    tolerance = EPS,
): Result<GeometryEdit> {
    if (!editableCurve(source) || !at.every(Number.isFinite))
        return Result.err("Select a line, arc or circle");
    const snap = others
        .filter((e) => e.id !== source.id)
        .flatMap((e) => curveIntersections(source, e))
        .sort((a, b) => Math.hypot(a[0] - at[0], a[1] - at[1]) - Math.hypot(b[0] - at[0], b[1] - at[1]))[0];
    const t = parameter(
        source,
        snap && Math.hypot(snap[0] - at[0], snap[1] - at[1]) <= tolerance ? snap : at,
    );
    const end = endParameter(source);
    const eps = (EPS * end) / curveLength(source);
    if (source.type !== "circle" && (t <= eps || t >= end - eps)) return Result.err("Pick inside the curve");
    const pieces =
        source.type === "circle"
            ? [piece(source, t, t + Math.PI), piece(source, t + Math.PI, t + TAU)]
            : [piece(source, 0, t), piece(source, t, end)];
    return Result.ok({ source, pieces, preview: pieces });
}

export function extendCurve(
    source: SketchEntityData,
    target: SketchEntityData,
    at: UV,
): Result<GeometryEdit> {
    if (
        !editableCurve(source) ||
        !at.every(Number.isFinite) ||
        source.type === "circle" ||
        source.id === target.id
    )
        return Result.err("Select a line or arc to extend");
    const end = endParameter(source);
    const startPoint = point(source, 0),
        endPoint = point(source, end);
    const start =
        Math.hypot(at[0] - startPoint[0], at[1] - startPoint[1]) <
        Math.hypot(at[0] - endPoint[0], at[1] - endPoint[1]);
    const eps = (EPS * end) / curveLength(source);
    const candidates = curveIntersections(source, target, true)
        .map((p) => parameter(source, p))
        .map((t) => (source.type === "arc" && start ? t - TAU : t))
        .filter((t) =>
            start
                ? t < -eps && (source.type === "line" || end - t < TAU - eps)
                : t > end + eps && (source.type === "line" || t < TAU - eps),
        )
        .sort((a, b) => (start ? b - a : a - b));
    if (!candidates.length) return Result.err("No intersection in the extension direction");
    const t = candidates[0];
    const pieces = [piece(source, start ? t : 0, start ? end : t)];
    return Result.ok({ source, pieces, preview: pieces });
}

/** Positive distance is left of a line, outward from a circular curve. */
export function offsetCurve(source: SketchEntityData, distance: number): Result<GeometryEdit> {
    if (!editableCurve(source) || !Number.isFinite(distance) || Math.abs(distance) < EPS)
        return Result.err("Offset must be a finite nonzero distance");
    const p = source.params;
    let params: number[];
    if (source.type === "line") {
        const length = curveLength(source);
        const dx = (-(p[3] - p[1]) * distance) / length,
            dy = ((p[2] - p[0]) * distance) / length;
        params = [p[0] + dx, p[1] + dy, p[2] + dx, p[3] + dy];
    } else {
        const radius = entityRadius(source),
            next = radius + distance;
        if (next <= EPS) return Result.err("Offset would collapse or invert the curve");
        params =
            source.type === "circle"
                ? [p[0], p[1], next]
                : [
                      p[0],
                      p[1],
                      p[0] + ((p[2] - p[0]) * next) / radius,
                      p[1] + ((p[3] - p[1]) * next) / radius,
                      p[0] + ((p[4] - p[0]) * next) / radius,
                      p[1] + ((p[5] - p[1]) * next) / radius,
                  ];
    }
    if (!params.every(Number.isFinite)) return Result.err("Offset is outside the supported range");
    const pieces = [{ ...source, params }];
    return Result.ok({ source, pieces, preview: pieces, copy: true });
}
