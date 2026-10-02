// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Precision, Result } from "@spicy3d/core";
import {
    type BSplineCurve2d,
    type BSplinePoint,
    bsplineDomain,
    bsplinePointAt,
    closestBSplineParameter,
    entityBSpline,
    evaluateBSpline,
    interpolateBSpline,
    sampleBSpline,
} from "./bsplineGeometry";
import type { SketchEntityData } from "./sketchModel";

const TOLERANCE = 0.001; // mm; offsets are approximated by existing fit-point entities.
const MAX_POINTS = 512;

/** Positive offsets are left for open curves, outward for periodic curves of either winding. */
function normalSign(curve: BSplineCurve2d): number {
    if (!curve.periodic) return 1;
    const points = sampleBSpline(curve, 4);
    let area = 0;
    for (let i = 1; i < points.length; i++) {
        area += points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1];
    }
    if (Math.abs(area) < Precision.Distance ** 2) throw new Error("B-spline has no enclosed area");
    return area > 0 ? -1 : 1;
}

export function bsplineOffsetSide(entity: SketchEntityData, at: BSplinePoint): number {
    const curve = entityBSpline(entity.params, entity);
    const [p, tangent] = evaluateBSpline(curve, closestBSplineParameter(curve, at));
    const side = normalSign(curve) * (tangent[0] * (at[1] - p[1]) - tangent[1] * (at[0] - p[0]));
    return side < 0 ? -1 : 1;
}

/** Tolerance-checked normal offset geometry, shared by fixed copies and associative regeneration. */
export function offsetBSpline(source: SketchEntityData, distance: number): Result<SketchEntityData> {
    if (source.params.length % 2 !== 0) return Result.err("B-spline params must be [u, v] pairs");
    try {
        const curve = entityBSpline(source.params, source);
        const signed = distance * normalSign(curve);
        const offsetAt = (u: number): BSplinePoint => {
            const [p, d1, d2] = evaluateBSpline(curve, u, 2);
            const speed = Math.hypot(...d1);
            const curvature = (d1[0] * d2[1] - d1[1] * d2[0]) / speed ** 3;
            if (speed < Precision.Distance || 1 - signed * curvature <= 0) {
                throw new Error("Offset would collapse or invert the B-spline");
            }
            const point: BSplinePoint = [p[0] - (signed * d1[1]) / speed, p[1] + (signed * d1[0]) / speed];
            if (!point.every(Number.isFinite)) throw new Error("Offset is outside the supported range");
            return point;
        };
        const [first, last] = bsplineDomain(curve);
        // Include knot boundaries in the regularity check even when uniform samples miss them.
        curve.knots.forEach(offsetAt);
        for (
            let count = Math.min(MAX_POINTS, Math.max(16, 2 * (curve.knots.length - 1)));
            count <= MAX_POINTS;
            count = Math.min(MAX_POINTS, count * 2)
        ) {
            const intervals = curve.periodic ? count : count - 1;
            const parameter = (i: number) => first + ((last - first) * i) / intervals;
            const points = Array.from({ length: count }, (_, i) => offsetAt(parameter(i)));
            const fit = interpolateBSpline(points, { periodic: curve.periodic, parametrization: "uniform" });
            if (!fit.isOk) return Result.err(fit.error);
            let error = 0;
            for (let i = 0; i < intervals; i++) {
                for (const fraction of [0.25, 0.5, 0.75]) {
                    const expected = offsetAt(parameter(i + fraction));
                    const actual = bsplinePointAt(fit.value, i + fraction);
                    error = Math.max(error, Math.hypot(actual[0] - expected[0], actual[1] - expected[1]));
                }
            }
            if (error > TOLERANCE) {
                if (count === MAX_POINTS) break;
                continue;
            }
            if (selfIntersects(sampleBSpline(fit.value, 4))) {
                return Result.err("Offset B-spline would self-intersect");
            }
            return Result.ok({
                id: source.id,
                type: "bspline",
                params: points.flat(),
                parametrization: "uniform",
                periodic: curve.periodic,
                construction: source.construction,
            });
        }
        return Result.err("B-spline offset cannot meet 0.001 mm tolerance within 512 fit points");
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

function selfIntersects(points: BSplinePoint[]): boolean {
    const cross = (a: BSplinePoint, b: BSplinePoint, c: BSplinePoint) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (let i = 1; i < points.length; i++) {
        for (let j = i + 2; j < points.length; j++) {
            const a = points[i - 1],
                b = points[i],
                c = points[j - 1],
                d = points[j];
            if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
        }
    }
    return false;
}
