// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation";
import { Line, Plane, XYZ } from "../math";
import { CurveUtils, type IConicalSurface, type ICurve, type IElementarySurface } from "../shape";
import type {
    ConstructionDefinition,
    ConstructionGeometry,
    ConstructionRef,
    IConstructionResolver,
    PathPosition,
    ResolvedConstructionSource,
} from "./types";

const EPS = 1e-7;
type Source = ResolvedConstructionSource;
type Axis = Extract<ConstructionGeometry, { kind: "axis" }>;
type EvaluationFlow<T> = Generator<Result<unknown>, T, never>;

function* invalid<T>(message: string): EvaluationFlow<T> {
    yield Result.err(message);
    return undefined as never;
}

function* unit(vector: XYZ, message = "Direction has zero length"): EvaluationFlow<XYZ> {
    if (![vector.x, vector.y, vector.z].every(Number.isFinite)) return yield* invalid(message);
    const result = vector.normalize();
    if (!result || ![result.x, result.y, result.z].every(Number.isFinite)) return yield* invalid(message);
    return result;
}

function* source(resolver: IConstructionResolver, ref: ConstructionRef): EvaluationFlow<Source> {
    const resolved = resolver.resolve(ref);
    if (!resolved.isOk) return yield* invalid(resolved.error);
    return resolved.value;
}

function* asPoint(value: Source): EvaluationFlow<XYZ> {
    if (value.kind === "point" || value.kind === "vertex") return value.point;
    if (value.kind === "ucs" || value.kind === "axis") return value.origin;
    return yield* invalid("Select a point or vertex");
}

function* asPlane(value: Source): EvaluationFlow<Plane> {
    if (value.kind === "plane") return value.plane;
    if (value.kind === "face") {
        const surface = value.face.surface();
        if (!surface.isPlanar()) return yield* invalid("Select a planar face");
        const { u1, u2, v1, v2 } = surface.bounds();
        const u = Number.isFinite(u1) && Number.isFinite(u2) ? (u1 + u2) / 2 : 0;
        const v = Number.isFinite(v1) && Number.isFinite(v2) ? (v1 + v2) / 2 : 0;
        const [origin, normal] = value.face.normal(u, v);
        if (![origin.x, origin.y, origin.z, normal.x, normal.y, normal.z].every(Number.isFinite))
            return yield* invalid("Planar face has no finite reference frame");
        return yield* plane(origin, normal.multiply(value.normalSign ?? 1));
    }
    return yield* invalid("Select a plane or planar face");
}

function* asAxis(value: Source): EvaluationFlow<Axis> {
    if (value.kind === "axis") return value;
    if (value.kind === "edge") {
        if (value.curve && !isLinear(value.curve)) return yield* invalid("Select a linear edge");
        return { kind: "axis", origin: value.start, direction: yield* unit(value.end.sub(value.start)) };
    }
    if (value.kind === "curve" && CurveUtils.isLine(value.curve)) {
        return {
            kind: "axis",
            origin: value.curve.value(value.start ?? value.curve.firstParameter()),
            direction: yield* unit(value.curve.direction),
        };
    }
    return yield* invalid("Select a linear edge or axis");
}

function isLinear(curve: ICurve): boolean {
    return CurveUtils.isLine(curve) || (CurveUtils.isTrimmed(curve) && isLinear(curve.basisCurve));
}

function circleCenter(curve: ICurve): XYZ | undefined {
    if (CurveUtils.isCircle(curve)) return curve.center;
    if (CurveUtils.isTrimmed(curve)) return circleCenter(curve.basisCurve);
    return undefined;
}

function* plane(origin: XYZ, normal: XYZ, preferred?: XYZ): EvaluationFlow<Plane> {
    const n = yield* unit(normal, "Plane normal is undefined");
    const raw = preferred ?? (Math.abs(n.dot(XYZ.unitZ)) < 0.9 ? XYZ.unitZ : XYZ.unitY);
    const x = yield* unit(raw.sub(n.multiply(raw.dot(n))), "Plane orientation is ambiguous");
    return new Plane({ origin, normal: n, xvec: x });
}

function offset(base: Plane, distance = 0): Plane {
    return base.translateTo(base.origin.add(base.normal.multiply(distance)));
}

function* lineLine(a: Axis, b: Axis): EvaluationFlow<XYZ> {
    const cross = a.direction.cross(b.direction);
    const denominator = cross.lengthSq();
    if (denominator < EPS * EPS) {
        return yield* invalid(
            a.origin.sub(b.origin).cross(a.direction).length() < EPS
                ? "Lines coincide and have infinitely many intersections"
                : "Lines are parallel and do not intersect",
        );
    }
    const delta = b.origin.sub(a.origin);
    const t = delta.cross(b.direction).dot(cross) / denominator;
    const u = delta.cross(a.direction).dot(cross) / denominator;
    const p = a.origin.add(a.direction.multiply(t));
    const q = b.origin.add(b.direction.multiply(u));
    if (p.distanceTo(q) > EPS) return yield* invalid("Lines are skew and do not intersect");
    return XYZ.center(p, q);
}

function* planePlane(a: Plane, b: Plane): EvaluationFlow<Axis> {
    const direction = a.normal.cross(b.normal);
    const divisor = direction.lengthSq();
    if (divisor < EPS * EPS) return yield* invalid("Planes are parallel or coincident");
    const da = a.normal.dot(a.origin);
    const db = b.normal.dot(b.origin);
    const origin = b.normal
        .cross(direction)
        .multiply(da)
        .add(direction.cross(a.normal).multiply(db))
        .multiply(1 / divisor);
    return { kind: "axis", origin, direction: yield* unit(direction) };
}

function* linePlane(line: Axis, base: Plane): EvaluationFlow<XYZ> {
    const denominator = line.direction.dot(base.normal);
    const numerator = base.origin.sub(line.origin).dot(base.normal);
    if (Math.abs(denominator) < EPS)
        return yield* invalid(
            Math.abs(numerator) < EPS
                ? "Line lies in the plane and has infinitely many intersections"
                : "Line and plane are parallel",
        );
    return line.origin.add(line.direction.multiply(numerator / denominator));
}

function linearSource(value: Source): boolean {
    return (
        value.kind === "axis" ||
        (value.kind === "edge" && (!value.curve || isLinear(value.curve))) ||
        (value.kind === "curve" && isLinear(value.curve))
    );
}

function curveOf(value: Source): ICurve | undefined {
    return value.kind === "curve" || value.kind === "edge" ? value.curve : undefined;
}

function circleOf(value: Source) {
    const curve = curveOf(value);
    if (!curve) return undefined;
    const basis = CurveUtils.isTrimmed(curve) ? curve.basisCurve : curve;
    return CurveUtils.isCircle(basis) ? basis : undefined;
}

function withinCurve(value: Source, point: XYZ): boolean {
    const curve = curveOf(value);
    if (!curve) return true;
    const parameter = curve.parameter(point, 1e-6);
    return (
        parameter !== undefined &&
        parameter >= curve.firstParameter() - EPS &&
        parameter <= curve.lastParameter() + EPS
    );
}

function* lineCircle(line: Axis, circleSource: Source): EvaluationFlow<XYZ[]> {
    const circle = circleOf(circleSource);
    if (!circle) return yield* invalid("Unsupported curved edge intersection");
    const center = circle.center,
        normal = yield* unit(circle.axis);
    const delta = line.origin.sub(center);
    const dot = line.direction.dot(normal);
    let parameters: number[];
    if (Math.abs(dot) > EPS) {
        parameters = [-delta.dot(normal) / dot];
    } else {
        if (Math.abs(delta.dot(normal)) > EPS) return [];
        const b = 2 * delta.dot(line.direction);
        const c = delta.dot(delta) - circle.radius * circle.radius;
        const discriminant = b * b - 4 * c;
        if (discriminant < -EPS) return [];
        parameters =
            Math.abs(discriminant) <= EPS
                ? [-b / 2]
                : [(-b - Math.sqrt(discriminant)) / 2, (-b + Math.sqrt(discriminant)) / 2];
    }
    return parameters
        .map((t) => line.origin.add(line.direction.multiply(t)))
        .filter((point) => Math.abs(point.distanceTo(center) - circle.radius) <= 1e-6)
        .filter((point) => withinCurve(circleSource, point));
}

function* curvedIntersections(a: Source, b: Source): EvaluationFlow<XYZ[]> {
    const ae = a.kind === "edge" ? a.edge : undefined;
    const be = b.kind === "edge" ? b.edge : undefined;
    let points: XYZ[];
    if (linearSource(a) && circleOf(b)) points = yield* lineCircle(yield* asAxis(a), b);
    else if (linearSource(b) && circleOf(a)) points = yield* lineCircle(yield* asAxis(b), a);
    else if (ae && be) {
        if (ae.isSame(be)) return yield* invalid("Edges coincide and have infinitely many intersections");
        points = ae.intersect(be).map((hit) => hit.point);
    } else if (ae && linearSource(b)) {
        const line = yield* asAxis(b);
        points = ae
            .intersect(new Line({ point: line.origin, direction: line.direction }))
            .map((hit) => hit.point);
    } else if (be && linearSource(a)) {
        const line = yield* asAxis(a);
        points = be
            .intersect(new Line({ point: line.origin, direction: line.direction }))
            .map((hit) => hit.point);
    } else {
        return yield* invalid("Curved edge intersection is unsupported for these sources");
    }
    const unique: XYZ[] = [];
    for (const point of points) {
        if (!unique.some((previous) => previous.distanceTo(point) <= EPS)) unique.push(point);
    }
    return unique.sort((p, q) => p.x - q.x || p.y - q.y || p.z - q.z);
}

function* edgeIntersections(a: Source, b: Source, solution?: number): EvaluationFlow<XYZ> {
    if (linearSource(a) && linearSource(b)) return yield* lineLine(yield* asAxis(a), yield* asAxis(b));
    const points = yield* curvedIntersections(a, b);
    if (points.length === 0) return yield* invalid("Edges do not intersect");
    if (points.length > 1 && solution === undefined)
        return yield* invalid("Multiple intersections; select a solution");
    if (solution !== undefined && (!Number.isInteger(solution) || solution < 0 || solution >= points.length))
        return yield* invalid("Intersection solution is unavailable");
    return points[solution ?? 0];
}

function* pathPoint(
    value: Source,
    position: PathPosition,
    resolver: IConstructionResolver,
    requireTangentChoice = false,
): EvaluationFlow<{ point: XYZ; tangent: XYZ }> {
    const segments =
        value.kind === "path"
            ? value.segments
            : value.kind === "curve"
              ? [value]
              : value.kind === "edge" && value.curve
                ? [{ kind: "curve" as const, curve: value.curve }]
                : undefined;
    if (segments === undefined || segments.length === 0) {
        const axis = yield* asAxis(value);
        if (position.kind === "to-point") {
            const delta = (yield* asPoint(yield* source(resolver, position.point))).sub(axis.origin);
            return {
                point: axis.origin.add(axis.direction.multiply(delta.dot(axis.direction))),
                tangent: axis.direction,
            };
        }
        if (position.kind === "normalized") return yield* invalid("An unbounded axis needs a distance");
        return { point: axis.origin.add(axis.direction.multiply(position.value)), tangent: axis.direction };
    }
    const intervals = segments.map((segment) => ({
        curve: segment.curve,
        first: segment.start ?? segment.curve.firstParameter(),
        last: segment.end ?? segment.curve.lastParameter(),
    }));
    for (let i = 0; i < intervals.length - 1; i++) {
        const end = intervals[i].curve.value(intervals[i].last);
        const next = intervals[i + 1].curve.value(intervals[i + 1].first);
        if (end.distanceTo(next) > 1e-5) return yield* invalid("Path segments have a gap and do not connect");
    }
    const lengths: number[] = [];
    for (const { curve, first, last } of intervals) lengths.push(yield* arcLength(curve, first, last));
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total < EPS) return yield* invalid("Path has zero length");
    let distance: number;
    if (position.kind === "distance") distance = position.value;
    else if (position.kind === "normalized") distance = position.value * total;
    else {
        const point = yield* asPoint(yield* source(resolver, position.point));
        const matches: Array<{ i: number; projected: XYZ; separation: number; along: number }> = [];
        for (let i = 0; i < intervals.length; i++) {
            const { curve, first, last } = intervals[i];
            const circle = circleCenter(curve);
            if (circle && circle.distanceTo(point) < EPS) {
                return yield* invalid("To Object point has infinitely many closest positions on the circle");
            }
            const singleLinear = intervals.length === 1 && isLinear(curve);
            if (singleLinear) {
                const start = curve.value(first),
                    direction = yield* unit(curve.d1(first).vec);
                const along = point.sub(start).dot(direction);
                const projected = start.add(direction.multiply(along));
                matches.push({ i, projected, separation: point.distanceTo(projected), along });
                continue;
            }
            const candidates = [
                { projected: curve.value(first), parameter: first },
                { projected: curve.value(last), parameter: last },
            ];
            for (const projected of curve.project(point)) {
                const parameter = curve.parameter(projected, 1e-5);
                if (parameter !== undefined && parameter >= first - EPS && parameter <= last + EPS) {
                    candidates.push({ projected, parameter: Math.max(first, Math.min(last, parameter)) });
                }
            }
            for (const candidate of candidates) {
                matches.push({
                    i,
                    projected: candidate.projected,
                    separation: point.distanceTo(candidate.projected),
                    along: yield* arcLength(curve, first, candidate.parameter),
                });
            }
        }
        matches.sort((a, b) => a.separation - b.separation || a.i - b.i || a.along - b.along);
        const best = matches[0];
        if (!best) return yield* invalid("Path has no supported projection");
        if (
            matches.some(
                (match) =>
                    Math.abs(match.separation - best.separation) <= EPS &&
                    match.projected.distanceTo(best.projected) > EPS,
            )
        )
            return yield* invalid("Point has multiple equally close path projections");
        distance = lengths.slice(0, best.i).reduce((a, b) => a + b, 0) + best.along;
    }
    if (value.kind === "path" && value.reversed && position.kind !== "to-point") distance = total - distance;
    if (distance < -EPS || distance > total + EPS) {
        if (intervals.length !== 1 || !isLinear(intervals[0].curve))
            return yield* invalid("This path cannot extend beyond its ends");
    }
    let index = 0;
    while (index < intervals.length - 1 && distance > lengths[index] + EPS) {
        distance -= lengths[index++];
    }
    if (requireTangentChoice && index < intervals.length - 1 && Math.abs(distance - lengths[index]) <= EPS) {
        const incoming = yield* unit(intervals[index].curve.d1(intervals[index].last).vec);
        const outgoing = yield* unit(intervals[index + 1].curve.d1(intervals[index + 1].first).vec);
        if (!incoming.isParallelTo(outgoing)) {
            const branch = value.kind === "path" ? value.branch : undefined;
            if (branch === undefined) return yield* invalid("Sharp path corner requires a tangent branch");
            if (branch === 1) {
                index++;
                distance = 0;
            } else if (branch !== 0) return yield* invalid("Selected path tangent branch is unavailable");
        }
    }
    const { curve, first, last } = intervals[index];
    const span = last - first;
    let parameter: number;
    if (distance < 0 || distance > lengths[index]) {
        parameter = first + (distance / lengths[index]) * span;
    } else if (Math.abs(distance) < EPS || Math.abs(distance - lengths[index]) < EPS) {
        parameter = Math.abs(distance) < EPS ? first : last;
    } else {
        let low = first;
        let high = last;
        for (let i = 0; i < 45; i++) {
            const middle = (low + high) / 2;
            if ((yield* arcLength(curve, first, middle)) < distance) low = middle;
            else high = middle;
        }
        parameter = (low + high) / 2;
    }
    if ((distance < 0 || distance > lengths[index]) && isLinear(curve)) {
        const start = curve.value(first);
        const tangent = yield* unit(curve.d1(first).vec);
        return {
            point: start.add(tangent.multiply(distance)),
            tangent: value.kind === "path" && value.reversed ? tangent.reverse() : tangent,
        };
    }
    const point = curve.value(parameter);
    const tangent = yield* unit(curve.d1(parameter).vec, "Path tangent is undefined");
    return { point, tangent: value.kind === "path" && value.reversed ? tangent.reverse() : tangent };
}

function* arcLength(curve: ICurve, first: number, last: number): EvaluationFlow<number> {
    if (last <= first) return 0;
    if (isLinear(curve)) return curve.value(first).distanceTo(curve.value(last));
    if (Math.abs(first - curve.firstParameter()) < EPS && Math.abs(last - curve.lastParameter()) < EPS)
        return curve.length();
    const trimmed = curve.trim(first, last);
    if (!trimmed) return yield* invalid("Path interval is unavailable");
    try {
        return trimmed.length();
    } finally {
        trimmed.dispose();
    }
}

function* surfaceNormal(face: Extract<Source, { kind: "face" }>, contact: XYZ): EvaluationFlow<XYZ> {
    const surface = face.face.surface();
    if (surface.continuity() === "c0") return yield* invalid("Surface is not smooth at the contact point");
    const uv = surface.parameter(contact, EPS * 10);
    if (!uv || !face.face.containsPoint(contact, true, EPS * 10))
        return yield* invalid("Contact point is outside the face");
    if ("semiAngle" in surface) {
        const cone = surface as IConicalSurface;
        if (contact.distanceTo(cone.apex()) < 1e-5)
            return yield* invalid("Cone apex has no unique surface normal");
    }
    const bounds = surface.bounds();
    if (
        ![uv.u, uv.v].every(Number.isFinite) ||
        uv.u < bounds.u1 - 1e-5 ||
        uv.u > bounds.u2 + 1e-5 ||
        uv.v < bounds.v1 - 1e-5 ||
        uv.v > bounds.v2 + 1e-5
    )
        return yield* invalid("Contact point is outside the surface domain");
    const derivatives = surface.d1(uv.u, uv.v);
    if (derivatives.d1u.cross(derivatives.d1v).length() < EPS)
        return yield* invalid("Surface normal is undefined at the contact point");
    const [, normal] = face.face.normal(uv.u, uv.v);
    return yield* unit(
        normal.multiply(face.normalSign ?? 1),
        "Surface normal is undefined at the contact point",
    );
}

function* evaluateFlow(
    definition: ConstructionDefinition,
    resolver: IConstructionResolver,
): EvaluationFlow<Result<ConstructionGeometry>> {
    const get = (ref: ConstructionRef) => source(resolver, ref);
    const point = function* (ref: ConstructionRef): EvaluationFlow<XYZ> {
        return yield* asPoint(yield* get(ref));
    };
    const axis = function* (ref: ConstructionRef): EvaluationFlow<Axis> {
        return yield* asAxis(yield* get(ref));
    };
    const base = function* (ref: ConstructionRef): EvaluationFlow<Plane> {
        return yield* asPlane(yield* get(ref));
    };
    switch (definition.kind) {
        case "plane-offset": {
            const p = yield* base(definition.source);
            const distance = definition.toPoint
                ? (yield* point(definition.toPoint)).sub(p.origin).dot(p.normal)
                : definition.distance;
            return Result.ok({ kind: "plane", plane: offset(p, distance) });
        }
        case "plane-midplane": {
            const a = yield* base(definition.first),
                b = yield* base(definition.second);
            if (a.normal.isParallelTo(b.normal)) {
                const separation = b.origin.sub(a.origin).dot(a.normal);
                if (Math.abs(separation) < EPS)
                    return Result.err("Coincident planes have no unique midplane");
                return Result.ok({ kind: "plane", plane: offset(a, separation / 2) });
            }
            const intersection = yield* planePlane(a, b);
            const signed = a.normal.dot(b.normal) < 0 ? b.normal.reverse() : b.normal;
            const normal = yield* unit(a.normal.add(signed.multiply(definition.solution === 1 ? -1 : 1)));
            return Result.ok({
                kind: "plane",
                plane: yield* plane(intersection.origin, normal, intersection.direction),
            });
        }
        case "plane-angle": {
            const line = yield* axis(definition.axis),
                reference = yield* base(definition.baseline);
            if (Math.abs(line.direction.dot(reference.normal)) > EPS)
                return Result.err("Baseline plane must contain the selected axis");
            if (Math.abs(line.origin.sub(reference.origin).dot(reference.normal)) > EPS)
                return Result.err("Baseline plane must pass through the selected axis");
            const rotated = reference.normal.rotate(line.direction, (definition.angle * Math.PI) / 180)!;
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(line.origin, rotated, line.direction), definition.offset),
            });
        }
        case "plane-two-edges": {
            const a = yield* axis(definition.first),
                b = yield* axis(definition.second);
            const cross = a.direction.cross(b.direction);
            let normal: XYZ;
            if (cross.length() < EPS) {
                const delta = b.origin.sub(a.origin);
                normal = yield* unit(a.direction.cross(delta), "Coincident lines have no unique plane");
            } else {
                yield* lineLine(a, b);
                normal = yield* unit(cross);
            }
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(a.origin, normal, a.direction), definition.offset),
            });
        }
        case "plane-three-points": {
            const a = yield* point(definition.first),
                b = yield* point(definition.second),
                c = yield* point(definition.third);
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(a, b.sub(a).cross(c.sub(a)), b.sub(a)), definition.offset),
            });
        }
        case "plane-along-path": {
            const hit = yield* pathPoint(yield* get(definition.path), definition.position, resolver, true);
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(hit.point, hit.tangent), definition.offset),
            });
        }
        case "plane-tangent": {
            const face = yield* get(definition.face);
            if (face.kind !== "face") return Result.err("Select a smooth face");
            const contact = yield* point(definition.contact);
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(contact, yield* surfaceNormal(face, contact)), definition.offset),
            });
        }
        case "plane-perpendicular": {
            const src = yield* get(definition.source),
                contact = yield* point(definition.contact);
            const normal =
                src.kind === "face"
                    ? yield* surfaceNormal(src, contact)
                    : (yield* base(definition.source)).normal;
            const orient = (yield* axis(definition.orientation)).direction;
            const perpendicular = yield* unit(
                orient.sub(normal.multiply(orient.dot(normal))),
                "Orientation is parallel to the source normal",
            );
            return Result.ok({
                kind: "plane",
                plane: offset(yield* plane(contact, perpendicular, normal), definition.distance),
            });
        }
        case "axis-analytic": {
            const src = yield* get(definition.face);
            if (src.kind !== "face") return Result.err("Select a cylinder, cone, or torus face");
            const surface = src.face.surface() as IElementarySurface;
            if (
                !(
                    "semiAngle" in surface ||
                    "majorRadius" in surface ||
                    ("radius" in surface && !("area" in surface))
                ) ||
                !surface.axis
            )
                return Result.err("Face is not a cylinder, cone, or torus");
            return Result.ok({
                kind: "axis",
                origin: surface.location,
                direction: yield* unit(surface.axis),
            });
        }
        case "axis-normal": {
            const src = yield* get(definition.source),
                contact = yield* point(definition.contact);
            return Result.ok({
                kind: "axis",
                origin: contact,
                direction:
                    src.kind === "face"
                        ? yield* surfaceNormal(src, contact)
                        : (yield* base(definition.source)).normal,
            });
        }
        case "axis-two-planes":
            return Result.ok(
                yield* planePlane(yield* base(definition.first), yield* base(definition.second)),
            );
        case "axis-two-points": {
            const a = yield* point(definition.first),
                b = yield* point(definition.second);
            return Result.ok({
                kind: "axis",
                origin: a,
                direction: yield* unit(b.sub(a), "Points coincide"),
            });
        }
        case "axis-edge":
            return Result.ok(yield* axis(definition.edge));
        case "point-vertex":
            return Result.ok({ kind: "point", point: yield* point(definition.vertex) });
        case "point-two-edges":
            return Result.ok({
                kind: "point",
                point: yield* edgeIntersections(
                    yield* get(definition.first),
                    yield* get(definition.second),
                    definition.solution,
                ),
            });
        case "point-three-planes": {
            const a = yield* base(definition.first),
                b = yield* base(definition.second),
                c = yield* base(definition.third);
            return Result.ok({ kind: "point", point: yield* linePlane(yield* planePlane(a, b), c) });
        }
        case "point-center": {
            const src = yield* get(definition.source);
            if (src.kind === "face") {
                const surface = src.face.surface() as IElementarySurface;
                if (!("majorRadius" in surface || ("radius" in surface && "area" in surface)))
                    return Result.err("Face has no supported analytic center");
                return Result.ok({ kind: "point", point: surface.location });
            }
            if (src.kind === "curve" && circleCenter(src.curve))
                return Result.ok({ kind: "point", point: circleCenter(src.curve)! });
            if (src.kind === "edge" && src.curve && circleCenter(src.curve))
                return Result.ok({ kind: "point", point: circleCenter(src.curve)! });
            return Result.err("Select a circle, sphere, or torus");
        }
        case "point-edge-plane":
            return Result.ok({
                kind: "point",
                point: yield* linePlane(yield* axis(definition.edge), yield* base(definition.plane)),
            });
        case "point-along-path":
            return Result.ok({
                kind: "point",
                point: (yield* pathPoint(yield* get(definition.path), definition.position, resolver)).point,
            });
        case "ucs": {
            const origin = yield* point(definition.origin);
            const first = (yield* axis(definition.first)).direction.multiply(
                definition.reverseFirst ? -1 : 1,
            );
            const other = (yield* axis(definition.second)).direction.multiply(
                definition.reverseSecond ? -1 : 1,
            );
            const a = yield* unit(first),
                b = yield* unit(other.sub(a.multiply(other.dot(a))), "Directions are parallel");
            const firstAxis = definition.firstAxis ?? "X",
                secondAxis = definition.secondAxis ?? "Y";
            if (firstAxis === secondAxis) return Result.err("UCS direction axes must differ");
            let x: XYZ, y: XYZ, z: XYZ;
            if (firstAxis === "X") {
                x = a;
                if (secondAxis === "Y") {
                    y = b;
                    z = x.cross(y);
                } else {
                    z = b;
                    y = z.cross(x);
                }
            } else if (firstAxis === "Y") {
                y = a;
                if (secondAxis === "Z") {
                    z = b;
                    x = y.cross(z);
                } else {
                    x = b;
                    z = x.cross(y);
                }
            } else {
                z = a;
                if (secondAxis === "X") {
                    x = b;
                    y = z.cross(x);
                } else {
                    y = b;
                    x = y.cross(z);
                }
            }
            return Result.ok({ kind: "ucs", origin, x, y, z });
        }
    }
    return Result.err("Unsupported construction definition");
}

/** Evaluates all Construct tool definitions without storing a stale geometry fallback. */
export function evaluateConstruction(
    definition: ConstructionDefinition,
    resolver: IConstructionResolver,
): Result<ConstructionGeometry> {
    let flow: EvaluationFlow<Result<ConstructionGeometry>> | undefined;
    try {
        // A yielded Result is an expected failure. Unwind the suspended flow in finally.
        flow = evaluateFlow(definition, resolver);
        const step = flow.next();
        if (!step.done) return Result.err(step.value.error);
        return step.value;
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    } finally {
        flow?.return(Result.err("Evaluation stopped"));
        resolver.dispose?.();
    }
}
