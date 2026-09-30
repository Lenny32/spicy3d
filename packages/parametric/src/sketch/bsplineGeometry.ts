// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Precision, Result } from "@spicy3d/core";

/**
 * The interpolating B-spline of the sketch `bspline` entity: ONE smooth curve through every fit
 * point, in the order given.
 *
 * - **Parametrization** — where each fit point sits on the curve's parameter axis: `chord` (the
 *   default) spaces them by the distance between neighbours, so unevenly spaced points neither
 *   overshoot nor flatten; `centripetal` by the square root of that distance (tighter still around
 *   sharp turns); `uniform` one unit apart (only for evenly spaced points).
 * - **Open curve** — degree 3 with the "not-a-knot" end condition: the knots are the fit parameters
 *   minus the second and the second-to-last, so the first two and the last two spans are each one
 *   cubic and there are exactly as many poles as fit points (the scheme of OCCT's
 *   `GeomAPI_Interpolate`). Fewer points lower the degree: two points are a straight segment
 *   (degree 1), three a parabola arc (degree 2). The curve starts at the first fit point and ends at
 *   the last one (clamped knots).
 * - **Periodic curve** — closed and C2 everywhere, the seam included: the first point is NOT
 *   repeated as the last, the closing span runs from the last point back to the first (its
 *   parameter length follows the parametrization too). Degree 3 from four points, degree 2 for
 *   three. The representation follows OCCT: `knots` = the n + 1 fit parameters (the last one is
 *   the period's end), every multiplicity 1, n poles; the flat knot vector extends the knots
 *   periodically by `degree` on either side and pole j + n is pole j.
 */
export type BSplineParametrization = "chord" | "centripetal" | "uniform";

export const BSPLINE_PARAMETRIZATIONS: readonly BSplineParametrization[] = [
    "chord",
    "centripetal",
    "uniform",
];

export type BSplinePoint = [number, number];

export interface BSplineOptions {
    parametrization?: BSplineParametrization;
    periodic?: boolean;
}

/** A 2D B-spline in knot-vector form (OCCT layout: distinct knots with multiplicities). */
export interface BSplineCurve2d {
    degree: number;
    periodic: boolean;
    poles: BSplinePoint[];
    /** Distinct knots, increasing. */
    knots: number[];
    multiplicities: number[];
    /** The parameter of each fit point, in order (the curve passes through fit point i at `parameters[i]`). */
    parameters: number[];
}

/** First and last parameter of the curve's domain. */
export function bsplineDomain(curve: BSplineCurve2d): [number, number] {
    return [curve.knots[0], curve.knots[curve.knots.length - 1]];
}

/**
 * The fit points as they are stored (the entity params: `[x0, y0, x1, y1, ...]` in curve order),
 * validated: at least two finite points (three when periodic), consecutive points distinct. A
 * periodic curve given with its first point repeated as the last drops the repetition — the
 * closing span is implied. An open curve that ends where it starts is refused: it would close
 * with a corner; `periodic` closes it smoothly.
 */
export function bsplineFitParams(points: readonly BSplinePoint[], periodic = false): Result<number[]> {
    if (points.some((p) => p.length !== 2 || !p.every(Number.isFinite))) {
        return Result.err("B-spline points must be finite [u, v] pairs");
    }
    let fit = [...points];
    if (periodic && fit.length > 1 && distance(fit[0], fit[fit.length - 1]) < Precision.Distance) {
        fit = fit.slice(0, -1);
    }
    if (fit.length < (periodic ? 3 : 2)) {
        return Result.err(
            periodic
                ? "A periodic B-spline needs at least three points"
                : "A B-spline needs at least two points",
        );
    }
    if (fit.some((p, i) => i > 0 && distance(p, fit[i - 1]) < Precision.Distance)) {
        return Result.err("Consecutive B-spline points must be distinct");
    }
    if (!periodic && distance(fit[0], fit[fit.length - 1]) < Precision.Distance) {
        return Result.err(
            "An open B-spline cannot end where it starts; set periodic: true for a closed curve (without repeating the first point)",
        );
    }
    return Result.ok(fit.flat());
}

/** Fit points of stored entity params (`[x0, y0, x1, y1, ...]`). */
export function bsplinePoints(params: readonly number[]): BSplinePoint[] {
    const points: BSplinePoint[] = [];
    for (let i = 0; i + 1 < params.length; i += 2) points.push([params[i], params[i + 1]]);
    return points;
}

/**
 * Fit parameters: 0 for the first point, then the parametrization's step to each next point; a
 * periodic curve gets one more entry, the period's end (the step back to the first point).
 */
export function bsplineParameters(
    points: readonly BSplinePoint[],
    parametrization: BSplineParametrization = "chord",
    periodic = false,
): number[] {
    const count = periodic ? points.length : points.length - 1;
    const parameters = [0];
    for (let i = 0; i < count; i++) {
        const gap = distance(points[i], points[(i + 1) % points.length]);
        const step =
            parametrization === "uniform" ? 1 : parametrization === "centripetal" ? Math.sqrt(gap) : gap;
        parameters.push(parameters[i] + step);
    }
    return parameters;
}

/** The degree used for `count` fit points (see the module comment). */
export function bsplineDegree(count: number, periodic: boolean): number {
    if (periodic) return count >= 4 ? 3 : 2;
    return Math.min(3, count - 1);
}

/** Distinct knots + multiplicities of the interpolant through points at `parameters`. */
function interpolationKnots(
    parameters: readonly number[],
    degree: number,
    periodic: boolean,
): { knots: number[]; multiplicities: number[] } {
    if (periodic) {
        return { knots: [...parameters], multiplicities: parameters.map(() => 1) };
    }
    const last = parameters.length - 1;
    if (degree < 3) {
        return { knots: [parameters[0], parameters[last]], multiplicities: [degree + 1, degree + 1] };
    }
    // not-a-knot: the second and the second-to-last parameters are no knots
    const interior = parameters.slice(2, last - 1);
    return {
        knots: [parameters[0], ...interior, parameters[last]],
        multiplicities: [degree + 1, ...interior.map(() => 1), degree + 1],
    };
}

/**
 * The interpolating B-spline through `points` (see the module comment for the scheme). Errors on
 * invalid points (`bsplineFitParams`) and on a singular interpolation system.
 */
export function interpolateBSpline(
    points: readonly BSplinePoint[],
    options: BSplineOptions = {},
): Result<BSplineCurve2d> {
    const periodic = options.periodic === true;
    const valid = bsplineFitParams(points, periodic);
    if (!valid.isOk) return Result.err(valid.error);
    const fit = bsplinePoints(valid.value);
    const parameters = bsplineParameters(fit, options.parametrization ?? "chord", periodic);
    const degree = bsplineDegree(fit.length, periodic);
    const { knots, multiplicities } = interpolationKnots(parameters, degree, periodic);
    return interpolateBSplineAt(fit, {
        degree,
        periodic,
        knots,
        multiplicities,
        parameters: parameters.slice(0, fit.length),
    });
}

/**
 * The B-spline of a given knot layout through `points`, each at its given parameter — the poles
 * alone are solved for. `interpolateBSpline` picks the layout from the points; the solver keeps
 * a layout fixed within one solve (its native knots are rebuilt between solves).
 * Errors when the point count does not match the layout or the system is singular.
 */
export function interpolateBSplineAt(
    points: readonly BSplinePoint[],
    shape: Omit<BSplineCurve2d, "poles">,
): Result<BSplineCurve2d> {
    const n = points.length;
    if (n !== shape.parameters.length) return Result.err("The B-spline point count does not match its knots");
    const flat = flatKnots(shape);
    const { degree } = shape;
    // row i: every basis function at the fit parameter t_i, folded onto the n distinct poles
    const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
        const u = shape.parameters[i];
        const span = findSpan(flat, degree, u);
        const basis = basisFunctions(flat, degree, span, u);
        for (let k = 0; k <= degree; k++) matrix[i][(span - degree + k) % n] += basis[k];
    }
    const solved = solveLinear(
        matrix,
        points.map((p) => [p[0], p[1]]),
    );
    if (solved === undefined || solved.some((row) => !row.every(Number.isFinite))) {
        return Result.err("The B-spline interpolation is singular for these points");
    }
    return Result.ok({
        degree,
        periodic: shape.periodic,
        knots: [...shape.knots],
        multiplicities: [...shape.multiplicities],
        parameters: [...shape.parameters],
        poles: solved.map((row) => [row[0], row[1]] as BSplinePoint),
    });
}

/**
 * The interpolant of stored entity params — the curve an entity's edges and meshes are built from.
 * Throws on invalid params: stored data is validated where it is written (`bsplineFitParams`),
 * callers building edges check `interpolateBSpline` themselves.
 */
export function entityBSpline(params: readonly number[], options: BSplineOptions = {}): BSplineCurve2d {
    const curve = interpolateBSpline(bsplinePoints(params), options);
    if (!curve.isOk) throw new Error(curve.error);
    return curve.value;
}

/** The flat knot vector (every knot repeated by its multiplicity; periodic: extended by `degree` either side). */
export function flatKnots(
    curve: Pick<BSplineCurve2d, "degree" | "periodic" | "knots" | "multiplicities">,
): number[] {
    const flat: number[] = [];
    curve.knots.forEach((knot, i) => {
        for (let m = 0; m < curve.multiplicities[i]; m++) flat.push(knot);
    });
    if (!curve.periodic) return flat;
    // periodic: the last knot is the first one shifted by the period; the flat sequence keeps it once
    const period = curve.knots[curve.knots.length - 1] - curve.knots[0];
    const inner = flat; // k0 .. kn (multiplicity 1 each)
    const count = inner.length - 1; // distinct knots in one period
    const before = Array.from({ length: curve.degree }, (_, i) => inner[count - curve.degree + i] - period);
    const after = Array.from({ length: curve.degree }, (_, i) => inner[1 + i] + period);
    return [...before, ...inner, ...after];
}

/** Poles as the flat knot vector addresses them: a periodic curve repeats its first `degree` poles. */
export function unperiodizedPoles(
    curve: Pick<BSplineCurve2d, "degree" | "periodic" | "poles">,
): BSplinePoint[] {
    if (!curve.periodic) return curve.poles;
    return [...curve.poles, ...curve.poles.slice(0, curve.degree)];
}

/** Span index s with flat[s] <= u < flat[s + 1], clamped into the domain [flat[p], flat[m - p]]. */
function findSpan(flat: readonly number[], degree: number, u: number): number {
    const high = flat.length - degree - 2;
    if (u >= flat[high + 1]) {
        let s = high;
        while (s > degree && flat[s] >= flat[high + 1]) s--;
        return s;
    }
    if (u <= flat[degree]) {
        let s = degree;
        while (s < high && flat[s + 1] <= flat[degree]) s++;
        return s;
    }
    let low = degree;
    let top = high + 1;
    let mid = Math.floor((low + top) / 2);
    while (u < flat[mid] || u >= flat[mid + 1]) {
        if (u < flat[mid]) top = mid;
        else low = mid;
        mid = Math.floor((low + top) / 2);
    }
    return mid;
}

/** The degree + 1 non-zero basis functions at u in span s (The NURBS Book, A2.2). */
function basisFunctions(flat: readonly number[], degree: number, span: number, u: number): number[] {
    const basis = [1];
    const left: number[] = [];
    const right: number[] = [];
    for (let j = 1; j <= degree; j++) {
        left[j] = u - flat[span + 1 - j];
        right[j] = flat[span + j] - u;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            const temp = basis[r] / (right[r + 1] + left[j - r]);
            basis[r] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        basis[j] = saved;
    }
    return basis;
}

/** Basis functions and their derivatives up to `order` at u in span s (The NURBS Book, A2.3). */
function basisDerivatives(
    flat: readonly number[],
    degree: number,
    span: number,
    u: number,
    order: number,
): number[][] {
    const ndu = Array.from({ length: degree + 1 }, () => new Array<number>(degree + 1).fill(0));
    const left: number[] = [];
    const right: number[] = [];
    ndu[0][0] = 1;
    for (let j = 1; j <= degree; j++) {
        left[j] = u - flat[span + 1 - j];
        right[j] = flat[span + j] - u;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            ndu[j][r] = right[r + 1] + left[j - r];
            const temp = ndu[r][j - 1] / ndu[j][r];
            ndu[r][j] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        ndu[j][j] = saved;
    }
    const ders = Array.from({ length: order + 1 }, () => new Array<number>(degree + 1).fill(0));
    for (let j = 0; j <= degree; j++) ders[0][j] = ndu[j][degree];
    for (let r = 0; r <= degree; r++) {
        let s1 = 0;
        let s2 = 1;
        const a = [new Array<number>(degree + 1).fill(0), new Array<number>(degree + 1).fill(0)];
        a[0][0] = 1;
        for (let k = 1; k <= order; k++) {
            let d = 0;
            const rk = r - k;
            const pk = degree - k;
            if (r >= k) {
                a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
                d = a[s2][0] * ndu[rk][pk];
            }
            const j1 = rk >= -1 ? 1 : -rk;
            const j2 = r - 1 <= pk ? k - 1 : degree - r;
            for (let j = j1; j <= j2; j++) {
                a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
                d += a[s2][j] * ndu[rk + j][pk];
            }
            if (r <= pk) {
                a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
                d += a[s2][k] * ndu[r][pk];
            }
            ders[k][r] = d;
            [s1, s2] = [s2, s1];
        }
    }
    let factor = degree;
    for (let k = 1; k <= order; k++) {
        for (let j = 0; j <= degree; j++) ders[k][j] *= factor;
        factor *= degree - k;
    }
    return ders;
}

/** A periodic parameter brought into the domain; an open one clamped to it. */
function domainParameter(curve: BSplineCurve2d, u: number): number {
    const [first, last] = bsplineDomain(curve);
    if (!curve.periodic) return Math.min(last, Math.max(first, u));
    const period = last - first;
    const wrapped = (((u - first) % period) + period) % period;
    return first + wrapped;
}

/**
 * The point and derivatives up to `order` (default: the point and the first derivative) at `u`,
 * as `[point, d1, d2, ...]`.
 */
export function evaluateBSpline(curve: BSplineCurve2d, u: number, order = 1): BSplinePoint[] {
    const flat = flatKnots(curve);
    const poles = unperiodizedPoles(curve);
    const t = domainParameter(curve, u);
    const span = findSpan(flat, curve.degree, t);
    const ders = basisDerivatives(flat, curve.degree, span, t, Math.min(order, curve.degree));
    const result: BSplinePoint[] = [];
    for (let k = 0; k <= order; k++) {
        const point: BSplinePoint = [0, 0];
        if (k <= curve.degree) {
            for (let j = 0; j <= curve.degree; j++) {
                const pole = poles[span - curve.degree + j];
                point[0] += ders[k][j] * pole[0];
                point[1] += ders[k][j] * pole[1];
            }
        }
        result.push(point);
    }
    return result;
}

/** A point on the curve at `u`. */
export function bsplinePointAt(curve: BSplineCurve2d, u: number): BSplinePoint {
    return evaluateBSpline(curve, u, 0)[0];
}

/** The polynomial spans of the domain, as [start, end] parameter pairs. */
export function bsplineSpans(curve: BSplineCurve2d): [number, number][] {
    const spans: [number, number][] = [];
    for (let i = 0; i + 1 < curve.knots.length; i++) spans.push([curve.knots[i], curve.knots[i + 1]]);
    return spans;
}

/**
 * The exact Bezier segments of the curve, one per polynomial span (`degree + 1` control points
 * each), from the blossom of the span's polynomial: control point j = blossom(a × (p − j), b × j).
 * The kernel fallback builds one `bezier` edge per segment; meshing samples them.
 */
export function bsplineBezierSegments(curve: BSplineCurve2d): BSplinePoint[][] {
    const flat = flatKnots(curve);
    const poles = unperiodizedPoles(curve);
    const p = curve.degree;
    const segments = bsplineSpans(curve).map(([a, b]) => {
        const span = findSpan(flat, p, (a + b) / 2);
        return Array.from({ length: p + 1 }, (_, j) =>
            blossom(flat, poles, p, span, [
                ...new Array<number>(p - j).fill(a),
                ...new Array<number>(j).fill(b),
            ]),
        );
    });
    // a joint is one point: each segment starts exactly where the previous one ends (and a periodic
    // curve's last one where the first starts), so the edges chain without a rounding gap
    for (let i = 1; i < segments.length; i++) segments[i][0] = segments[i - 1][p];
    if (curve.periodic) segments[segments.length - 1][p] = segments[0][0];
    return segments;
}

/** De Boor's algorithm with one parameter per level: the blossom of span `span`'s polynomial. */
function blossom(
    flat: readonly number[],
    poles: readonly BSplinePoint[],
    degree: number,
    span: number,
    args: readonly number[],
): BSplinePoint {
    const d = Array.from({ length: degree + 1 }, (_, j) => [...poles[span - degree + j]] as BSplinePoint);
    for (let r = 1; r <= degree; r++) {
        const x = args[r - 1];
        for (let j = degree; j >= r; j--) {
            const i = span - degree + j;
            const denominator = flat[i + degree + 1 - r] - flat[i];
            const alpha = denominator === 0 ? 0 : (x - flat[i]) / denominator;
            d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
        }
    }
    return d[degree];
}

/**
 * Polyline through the curve for previews, hit tests and editor meshes: `subdivisions` samples per
 * span, every fit point included (they sit on span ends or, for the not-a-knot spans, are added).
 * A periodic curve's polyline ends where it starts.
 */
export function sampleBSpline(curve: BSplineCurve2d, subdivisions = 24): BSplinePoint[] {
    const samples = new Set<number>(curve.parameters);
    for (const [a, b] of bsplineSpans(curve)) {
        for (let i = 0; i < subdivisions; i++) samples.add(a + ((b - a) * i) / subdivisions);
    }
    const [first, last] = bsplineDomain(curve);
    samples.add(last);
    return [...samples]
        .filter((u) => u >= first && u <= last)
        .sort((a, b) => a - b)
        .map((u) => (u === last && curve.periodic ? bsplinePointAt(curve, first) : bsplinePointAt(curve, u)));
}

/**
 * Polyline of stored entity params (`sampleBSpline` of their interpolant) — editor meshes, hit
 * tests, previews. Points that do not interpolate (a hand-edited file) draw as the plain polyline
 * through them, so the entity stays visible and selectable while its shape reports the error.
 */
export function bsplinePolyline(
    params: readonly number[],
    options: BSplineOptions = {},
    subdivisions?: number,
): BSplinePoint[] {
    const points = bsplinePoints(params);
    const curve = interpolateBSpline(points, options);
    if (curve.isOk) return sampleBSpline(curve.value, subdivisions);
    return options.periodic && points.length > 0 ? [...points, points[0]] : points;
}

/**
 * The curve parameter nearest to `point`: the best dense sample, refined by Newton steps on
 * (C(u) − point) · C'(u) = 0. Hit tests, the point-on-B-spline constraint's initial parameter.
 */
export function closestBSplineParameter(curve: BSplineCurve2d, point: BSplinePoint): number {
    let best = curve.knots[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [a, b] of bsplineSpans(curve)) {
        for (let i = 0; i <= 16; i++) {
            const u = a + ((b - a) * i) / 16;
            const d = distance(bsplinePointAt(curve, u), point);
            if (d < bestDistance) {
                bestDistance = d;
                best = u;
            }
        }
    }
    const [first, last] = bsplineDomain(curve);
    let u = best;
    for (let iteration = 0; iteration < 8; iteration++) {
        const [c, d1, d2] = evaluateBSpline(curve, u, 2);
        const dx = c[0] - point[0];
        const dy = c[1] - point[1];
        const f = dx * d1[0] + dy * d1[1];
        const df = d1[0] * d1[0] + d1[1] * d1[1] + dx * d2[0] + dy * d2[1];
        if (Math.abs(df) < 1e-14) break;
        let next = u - f / df;
        if (!curve.periodic) next = Math.min(last, Math.max(first, next));
        if (Math.abs(next - u) < 1e-12) {
            u = next;
            break;
        }
        u = next;
    }
    const refined = domainParameter(curve, u);
    return distance(bsplinePointAt(curve, refined), point) <= bestDistance ? refined : best;
}

/** Distance from `point` to the curve. */
export function bsplineDistance(curve: BSplineCurve2d, point: BSplinePoint): number {
    return distance(bsplinePointAt(curve, closestBSplineParameter(curve, point)), point);
}

/** Solves A·X = B (B with two columns) by Gaussian elimination with partial pivoting; undefined when singular. */
function solveLinear(matrix: number[][], rhs: number[][]): number[][] | undefined {
    const n = matrix.length;
    const a = matrix.map((row, i) => [...row, ...rhs[i]]);
    const width = n + rhs[0].length;
    for (let column = 0; column < n; column++) {
        let pivot = column;
        for (let row = column + 1; row < n; row++) {
            if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
        }
        if (Math.abs(a[pivot][column]) < 1e-12) return undefined;
        [a[column], a[pivot]] = [a[pivot], a[column]];
        for (let row = 0; row < n; row++) {
            if (row === column) continue;
            const factor = a[row][column] / a[column][column];
            if (factor === 0) continue;
            for (let k = column; k < width; k++) a[row][k] -= factor * a[column][k];
        }
    }
    return a.map((row, i) => row.slice(n).map((value) => value / a[i][i]));
}

function distance(a: readonly number[], b: readonly number[]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
