// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";
import type { BSplineCurve2d, BSplinePoint } from "./bsplineGeometry";

/** Saved on control-mode bspline entities; absent preserves interpolating fit mode. */
export interface ControlBSplineDefinition {
    degree: number;
    knots: number[];
    multiplicities: number[];
    weights?: number[];
}

export interface ControlBSplineSettings {
    degree?: number;
    knots?: number[];
    multiplicities?: number[];
    weights?: number[];
    periodic?: boolean;
}

export function defineControlBSpline(
    poles: readonly BSplinePoint[],
    settings: ControlBSplineSettings = {},
): Result<ControlBSplineDefinition> {
    if (
        !Array.isArray(poles) ||
        poles.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
    )
        return Result.err("Control poles must be finite [u, v] pairs");
    const degree = settings.degree === undefined ? Math.min(3, poles.length - 1) : settings.degree;
    if (!Number.isInteger(degree) || degree < 1 || degree > 25 || poles.length <= degree)
        return Result.err("Control B-spline degree must be 1..25 and less than the pole count");
    if (settings.periodic !== undefined && typeof settings.periodic !== "boolean")
        return Result.err("Periodic must be true or false");
    for (const field of [settings.knots, settings.multiplicities, settings.weights]) {
        if (field !== undefined && !Array.isArray(field))
            return Result.err("Knots, multiplicities and weights must be arrays");
    }
    const periodic = settings.periodic === true;
    if ((settings.knots === undefined) !== (settings.multiplicities === undefined))
        return Result.err("Control B-spline needs knots and multiplicities together");
    const knots =
        settings.knots ??
        (periodic
            ? Array.from({ length: poles.length + 1 }, (_, i) => i)
            : Array.from({ length: Math.max(0, poles.length - degree + 1) }, (_, i) => i));
    const multiplicities =
        settings.multiplicities ??
        knots.map((_, i) => (periodic ? 1 : i === 0 || i === knots.length - 1 ? degree + 1 : 1));
    const definition: ControlBSplineDefinition = {
        degree,
        knots: [...knots],
        multiplicities: [...multiplicities],
        ...(settings.weights === undefined ? {} : { weights: [...settings.weights] }),
    };
    const checked = controlBSplineCurve(poles.flat(), definition, periodic);
    return checked.isOk ? Result.ok(definition) : Result.err(checked.error);
}

export function controlBSplineCurve(
    params: readonly number[],
    definition: ControlBSplineDefinition,
    periodic = false,
): Result<BSplineCurve2d> {
    if (
        !Array.isArray(params) ||
        params.length < 4 ||
        params.length % 2 !== 0 ||
        !params.every(Number.isFinite)
    )
        return Result.err("Control poles must be finite [u, v] pairs, at least two");
    if (definition === null || typeof definition !== "object")
        return Result.err("Invalid control B-spline definition");
    const { degree, knots, multiplicities, weights } = definition;
    const count = params.length / 2;
    if (!Number.isInteger(degree) || degree < 1 || degree > 25 || count <= degree)
        return Result.err("Control B-spline degree must be 1..25 and less than the pole count");
    if (
        !Array.isArray(knots) ||
        !Array.isArray(multiplicities) ||
        knots.length < 2 ||
        knots.length !== multiplicities.length
    )
        return Result.err("Control B-spline needs at least two knots, one multiplicity per knot");
    if (!knots.every(Number.isFinite) || knots.some((k, i) => i > 0 && k <= knots[i - 1]))
        return Result.err("Control B-spline knots must be finite and strictly increasing");
    if (
        multiplicities.some(
            (m, i) =>
                !Number.isInteger(m) ||
                m < 1 ||
                m > (!periodic && (i === 0 || i === knots.length - 1) ? degree + 1 : degree),
        )
    )
        return Result.err("Control B-spline multiplicities are out of range");
    if (periodic) {
        const gap = knots[1] - knots[0];
        if (
            multiplicities.some((m) => m !== 1) ||
            knots.some(
                (k, i) => i > 0 && Math.abs(k - knots[i - 1] - gap) > 1e-9 * Math.max(1, Math.abs(gap)),
            )
        )
            return Result.err(
                "Periodic control B-splines require uniformly spaced knots and multiplicity one",
            );
    } else if (multiplicities[0] !== degree + 1 || multiplicities.at(-1) !== degree + 1)
        return Result.err("Open control B-splines require clamped endpoint multiplicities (degree + 1)");
    const required =
        multiplicities.reduce((sum, m) => sum + m, 0) - (periodic ? multiplicities.at(-1)! : degree + 1);
    if (required !== count)
        return Result.err("Control B-spline pole count does not match its knots and degree");
    if (
        weights !== undefined &&
        (!Array.isArray(weights) ||
            weights.length !== count ||
            weights.some((w) => !Number.isFinite(w) || w <= 0))
    )
        return Result.err("Control B-spline requires one positive finite weight per pole");
    return Result.ok({
        degree,
        periodic,
        knots: [...knots],
        multiplicities: [...multiplicities],
        poles: Array.from({ length: count }, (_, i) => [params[2 * i], params[2 * i + 1]] as BSplinePoint),
        parameters: [],
        ...(weights === undefined ? {} : { weights: [...weights] }),
    });
}
