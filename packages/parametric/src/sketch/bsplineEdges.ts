// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type Plane, Result, type XYZ } from "@spicy3d/core";
import {
    type BSplineCurve2d,
    type BSplineOptions,
    type BSplinePoint,
    bsplineBezierSegments,
    bsplineDegree,
    bsplineFitParams,
    bsplinePoints,
    interpolateBSpline,
} from "./bsplineGeometry";

/**
 * The kernel edges of a sketch `bspline` entity.
 *
 * - **One edge** when the loaded kernel has the `bspline` binding (`shapeFactory.bspline`,
 *   `Geom_BSplineCurve` + `BRepBuilderAPI_MakeEdge`): the interpolant's poles and knots as they
 *   are, periodic curves included — one face boundary edge, so offsets and booleans see a single
 *   smooth curve.
 * - **Fallback: one `bezier` edge per polynomial span** (the curve split at its knots,
 *   `bsplineBezierSegments`) on kernel builds that predate the binding — the committed binary until
 *   it is rebuilt. Geometrically the same curve, C2 across the joints, only split into several edges.
 *
 * Identity across the switch between the two: every edge of the entity carries the entity id
 * (`shapeEntityIds` lists it once per edge, `bsplineEdgeCount`), and a sweep seeds from that id
 * (`ent<id>`, `profileEdgeSeeds`) only what the profile edges themselves generate: after an
 * extrude, the profile's own (bottom) edges and the side faces carry the entity seed. The top and
 * lateral edges get positional ids (`f1:N`): the switch changes the edge count, so a ref on one of
 * them does not survive it and falls to fingerprint matching.
 * - **k spans → 1 edge** (the kernel gains the binding): an edge ref on a seeded edge (a bottom
 *   span) resolves on the single edge — the only edge whose id is the entity seed is adopted by the
 *   id although its length is not the span's (`uniqueEntityHit` in `edgeMatcher.ts`). The feature
 *   then covers the whole curve, the span having no edge of its own any more.
 * - **1 edge → k spans** (a kernel without the binding opens a file saved with it): every span
 *   carries the seed, so the id no longer names one edge; the length invariant then fails on each
 *   span and the ref falls to fingerprint matching, which finds no span matching the whole curve —
 *   the feature reports the edge as lost ("Edge not found after rebuild") and it has to be re-picked.
 */

/** Whether the loaded kernel builds a B-spline as one edge (see the module comment). */
export function kernelBuildsBSplineEdges(): boolean {
    return typeof shapeFactory !== "undefined" && shapeFactory?.supportsBSplineEdges === true;
}

/** Polynomial spans of the interpolant through `count` fit points: the fallback's edge count. */
export function bsplineSpanCount(count: number, periodic: boolean): number {
    if (periodic) return count;
    return bsplineDegree(count, false) < 3 ? 1 : count - 3;
}

/** Edges `bsplineEdges` produces for an entity with `params` (1 with the binding, one per span without). */
export function bsplineEdgeCount(params: readonly number[], periodic: boolean): number {
    if (kernelBuildsBSplineEdges()) return 1;
    // counted on the points the curve is built from (a periodic one drops a repeated first point)
    const fit = bsplineFitParams(bsplinePoints(params), periodic);
    return bsplineSpanCount((fit.isOk ? fit.value : params).length / 2, periodic);
}

function toWorld(plane: Plane, [u, v]: readonly number[]): XYZ {
    return plane.origin.add(plane.xvec.multiply(u)).add(plane.yvec.multiply(v));
}

/** The entity's edges on `plane`: one B-spline edge, or its Bezier spans on older kernels. */
export function bsplineEdges(
    params: readonly number[],
    options: BSplineOptions,
    plane: Plane,
): Result<IEdge[]> {
    const fit = bsplinePoints(params);
    const curve = interpolateBSpline(fit, options);
    if (!curve.isOk) return Result.err(curve.error);
    return kernelBuildsBSplineEdges() ? singleEdge(curve.value, plane) : bezierEdges(curve.value, fit, plane);
}

function singleEdge(curve: BSplineCurve2d, plane: Plane): Result<IEdge[]> {
    const edge = shapeFactory.bspline(
        curve.poles.map((pole) => toWorld(plane, pole)),
        curve.knots,
        curve.multiplicities,
        curve.degree,
        curve.periodic,
    );
    return edge.isOk ? Result.ok([edge.value]) : Result.err(edge.error);
}

function bezierEdges(curve: BSplineCurve2d, fit: readonly BSplinePoint[], plane: Plane): Result<IEdge[]> {
    const segments = bsplineBezierSegments(curve);
    if (!curve.periodic) {
        // an open curve ends exactly on its first and last fit points (other entities join there)
        segments[0][0] = fit[0];
        segments[segments.length - 1][curve.degree] = fit[fit.length - 1];
    }
    const edges: IEdge[] = [];
    for (const segment of segments) {
        const edge = shapeFactory.bezier(segment.map((point) => toWorld(plane, point)));
        if (!edge.isOk) {
            for (const built of edges) built.dispose();
            return Result.err(edge.error);
        }
        edges.push(edge.value);
    }
    return Result.ok(edges);
}
