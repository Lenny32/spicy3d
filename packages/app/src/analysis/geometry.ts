// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, Result, XYZ, type XYZLike } from "@spicy3d/core";

/** All lengths are document millimetres; curvature is inverse millimetres. */
export interface EdgeCurvatureSample {
    parameter: number;
    point: XYZ;
    tangent: XYZ;
    curvature: number;
    normal?: XYZ;
    status: "ok" | "singular";
}

/** The sign follows the face's outward normal. kMin <= kMax, in mm^-1. */
export interface SurfaceCurvatureSample {
    point: XYZ;
    normal: XYZ;
    kMin: number;
    kMax: number;
    gaussian: number;
}

export function evaluateFaceNormal(face: IFace, u: number, v: number): Result<{ point: XYZ; normal: XYZ }> {
    if (!Number.isFinite(u) || !Number.isFinite(v) || face.isNull()) return Result.err("Invalid face or UV");
    const surface = face.surface();
    try {
        const bounds = face.inspectionUVBounds?.();
        if (
            !bounds?.isOk ||
            u < bounds.value.u1 ||
            u > bounds.value.u2 ||
            v < bounds.value.v1 ||
            v > bounds.value.v2 ||
            !surface.isCNu(1) ||
            !surface.isCNv(1)
        ) {
            return Result.err("Face normal is outside its differentiable trimmed domain");
        }
        const d = surface.d1(u, v);
        if (
            ![d.point, d.d1u, d.d1v].every(finiteVector) ||
            d.d1u.cross(d.d1v).length() < DERIVATIVE_EPS ||
            !face.containsPoint(d.point, true, 1e-6)
        )
            return Result.err("Face normal is singular or outside trim");
        const normal = face.normal(u, v)[1].normalize();
        return normal ? Result.ok({ point: d.point, normal }) : Result.err("Face normal is singular");
    } finally {
        surface.dispose();
    }
}

const DERIVATIVE_EPS = 1e-12;

function finiteVector(v: XYZLike): boolean {
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function sampleEdgeCurvature(edge: IEdge, count: number): Result<EdgeCurvatureSample[]> {
    if (!Number.isInteger(count) || count < 2 || count > 4096 || edge.isNull()) {
        return Result.err("Invalid edge or sample count");
    }
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    if (!Number.isFinite(first) || !Number.isFinite(last) || Math.abs(last - first) < DERIVATIVE_EPS) {
        return Result.err("Edge has no finite parameter interval");
    }
    const samples: EdgeCurvatureSample[] = [];
    const curve = edge.curve;
    // Edge owns and caches its curve wrapper. A query must not dispose it.
    if (!curve.isCN(2)) return Result.err("Curvature is undefined across a nonsmooth curve");
    for (let i = 0; i < count; i++) {
        const parameter = first + (i / (count - 1)) * (last - first);
        // A native derivative at a nonsmooth knot can raise in release WASM.
        // OCCT's BRep_Tool::Curve(edge) already applies TopLoc_Location.
        const { point, vec1, vec2 } = curve.d2(parameter);
        if (!finiteVector(point) || !finiteVector(vec1) || !finiteVector(vec2)) {
            return Result.err("Curve returned a nonfinite derivative");
        }
        const speed = vec1.length();
        if (speed < DERIVATIVE_EPS) {
            samples.push({ parameter, point, tangent: XYZ.zero, curvature: 0, status: "singular" });
            continue;
        }
        const cross = vec1.cross(vec2);
        const curvature = cross.length() / (speed * speed * speed);
        const tangent = vec1.multiply(1 / speed);
        const normal = cross.cross(tangent).normalize();
        samples.push({ parameter, point, tangent, curvature, normal, status: "ok" });
    }
    return Result.ok(samples);
}

export function edgeEndpointContinuity(
    a: IEdge,
    b: IEdge,
    tolerance = 1e-6,
): Result<"gap" | "position" | "tangent" | "curvature"> {
    if (!(tolerance > 0)) return Result.err("Tolerance must be positive");
    const pairs = [
        [a.firstParameter(), b.firstParameter()],
        [a.firstParameter(), b.lastParameter()],
        [a.lastParameter(), b.firstParameter()],
        [a.lastParameter(), b.lastParameter()],
    ];
    let nearest = pairs[0];
    let distance = Infinity;
    for (const pair of pairs) {
        const d = a.pointAt(pair[0]).distanceTo(b.pointAt(pair[1]));
        if (d < distance) {
            distance = d;
            nearest = pair;
        }
    }
    if (distance > tolerance) return Result.ok("gap");
    if (!a.curve.isCN(2) || !b.curve.isCN(2)) return Result.ok("position");
    const da = a.curve.d2(nearest[0]);
    const db = b.curve.d2(nearest[1]);
    const ta = da.vec1.normalize();
    const tb = db.vec1.normalize();
    if (!ta || !tb || Math.abs(ta.dot(tb)) < 1 - 1e-4) return Result.ok("position");
    const normalA = da.vec2.sub(ta.multiply(da.vec2.dot(ta))).multiply(1 / da.vec1.lengthSq());
    const normalB = db.vec2.sub(tb.multiply(db.vec2.dot(tb))).multiply(1 / db.vec1.lengthSq());
    return Result.ok(normalA.distanceTo(normalB) <= tolerance ? "curvature" : "tangent");
}

/** Evaluate exact surface derivatives at a point on the trimmed face. */
export function evaluateSurfaceCurvature(face: IFace, u: number, v: number): Result<SurfaceCurvatureSample> {
    if (!Number.isFinite(u) || !Number.isFinite(v) || face.isNull()) {
        return Result.err("Invalid face or UV parameters");
    }
    const surface = face.surface();
    try {
        const bounds = surface.bounds();
        if (
            ![bounds.u1, bounds.u2, bounds.v1, bounds.v2].every(Number.isFinite) ||
            u < bounds.u1 - 1e-8 ||
            u > bounds.u2 + 1e-8 ||
            v < bounds.v1 - 1e-8 ||
            v > bounds.v2 + 1e-8
        )
            return Result.err("UV is outside a finite surface domain");
        // This also avoids calling a kernel D2 on a surface known to have an
        // insufficient differentiability order.
        if (!surface.isCNu(2) || !surface.isCNv(2)) {
            return Result.err("Surface is not twice differentiable");
        }
        const d = surface.d2(u, v);
        if (![d.point, d.d1u, d.d1v, d.d2u, d.d2v, d.d2uv].every(finiteVector)) {
            return Result.err("Surface returned nonfinite derivatives");
        }
        if (!face.containsPoint(d.point, true, 1e-6)) {
            return Result.err("UV lies outside the trimmed face");
        }
        const intrinsic = d.d1u.cross(d.d1v).normalize();
        if (!intrinsic) return Result.err("Surface normal is singular");
        const oriented = face.normal(u, v)[1].normalize();
        if (!oriented) return Result.err("Face normal is singular");
        const e = d.d1u.dot(d.d1u);
        const f = d.d1u.dot(d.d1v);
        const g = d.d1v.dot(d.d1v);
        const det = e * g - f * f;
        if (det < DERIVATIVE_EPS) return Result.err("Surface parameterization is singular");
        // Negate the classical second fundamental form so a convex sphere
        // with outward normal has positive curvature.
        const l = -oriented.dot(d.d2u);
        const m = -oriented.dot(d.d2uv);
        const n = -oriented.dot(d.d2v);
        const mean = (e * n - 2 * f * m + g * l) / (2 * det);
        const gaussian = (l * n - m * m) / det;
        const discriminant = Math.max(0, mean * mean - gaussian);
        const delta = Math.sqrt(discriminant);
        return Result.ok({
            point: d.point,
            normal: oriented,
            kMin: mean - delta,
            kMax: mean + delta,
            gaussian,
        });
    } finally {
        surface.dispose();
    }
}

/** Positive means the outward normal leans toward the pull direction. */
export function signedDraftAngle(normal: XYZLike, pull: XYZLike): Result<number> {
    if (!finiteVector(normal) || !finiteVector(pull)) return Result.err("Direction or normal is nonfinite");
    const n = new XYZ(normal).normalize();
    const p = new XYZ(pull).normalize();
    if (!n || !p) return Result.err("Direction or normal is undefined");
    return Result.ok((Math.asin(Math.max(-1, Math.min(1, n.dot(p)))) * 180) / Math.PI);
}

/** Concavity is negative principal curvature under the outward-normal convention. */
export function classifyMinimumRadius(
    sample: SurfaceCurvatureSample,
    threshold: number,
): Result<"violation" | "pass"> {
    if (!Number.isFinite(threshold) || threshold <= 0) return Result.err("Radius must be positive");
    if (
        !Number.isFinite(sample.kMin) ||
        !Number.isFinite(sample.kMax) ||
        sample.kMin > sample.kMax ||
        !Number.isFinite(sample.gaussian) ||
        !finiteVector(sample.normal) ||
        sample.normal.length() < DERIVATIVE_EPS
    )
        return Result.err("Curvature is undefined");
    return Result.ok(sample.kMin < -1 / threshold - 1e-8 ? "violation" : "pass");
}
