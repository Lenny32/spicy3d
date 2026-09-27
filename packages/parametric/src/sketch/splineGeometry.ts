// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Precision, Result } from "@spicy3d/core";

export type SplinePoint = [number, number];
export type SplineSegment = [SplinePoint, SplinePoint, SplinePoint, SplinePoint];

/** Endpoints first (point refs 0/1), followed by the fixed interior interpolation points. */
export function splineParams(points: readonly SplinePoint[]): Result<number[]> {
    if (points.length < 2 || points.some((p) => !p.every(Number.isFinite))) {
        return Result.err("A spline needs at least two finite points");
    }
    if (points.some((p, i) => i > 0 && distance(p, points[i - 1]) < Precision.Distance)) {
        return Result.err("Consecutive spline points must be distinct");
    }
    if (distance(points[0], points[points.length - 1]) < Precision.Distance) {
        return Result.err("Closed splines are not supported");
    }
    return Result.ok([...points[0], ...points[points.length - 1], ...points.slice(1, -1).flat()]);
}

export function splinePoints(params: readonly number[]): SplinePoint[] {
    const points: SplinePoint[] = [[params[0], params[1]]];
    for (let i = 4; i < params.length; i += 2) points.push([params[i], params[i + 1]]);
    points.push([params[2], params[3]]);
    return points;
}

function distance(a: SplinePoint, b: SplinePoint): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Uniform Catmull–Rom, represented exactly as piecewise cubic Beziers for the kernel. */
export function splineSegments(params: readonly number[]): SplineSegment[] {
    const points = splinePoints(params);
    return points.slice(0, -1).map((p1, i) => {
        const p0 = points[Math.max(0, i - 1)];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        return [
            p1,
            [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
            [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
            p2,
        ];
    });
}

/** Shared tessellation for live previews, selection and editor rendering. Includes every picked point. */
export function sampleSpline(params: readonly number[], subdivisions = 32): SplinePoint[] {
    const points: SplinePoint[] = [];
    for (const [a, b, c, d] of splineSegments(params)) {
        for (let i = 0; i < subdivisions; i++) {
            const t = i / subdivisions;
            const s = 1 - t;
            points.push(
                [0, 1].map(
                    (axis) =>
                        s ** 3 * a[axis] +
                        3 * s * s * t * b[axis] +
                        3 * s * t * t * c[axis] +
                        t ** 3 * d[axis],
                ) as SplinePoint,
            );
        }
    }
    points.push([params[2], params[3]]);
    return points;
}
