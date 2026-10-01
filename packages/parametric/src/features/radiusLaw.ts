// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FilletRadiusSample,
    LENGTH_UNITS,
    MAX_FILLET_RADIUS_SAMPLES,
    type ParameterValue,
    Result,
    resolveUnitSpec,
    type Scope,
    validateFilletRadiusLaw,
} from "@spicy3d/core";

/** Persisted only on variable fillets; positions follow normalized edge arc length. */
export interface FilletRadiusPoint {
    readonly position: number;
    readonly radius: ParameterValue;
}

export function resolveFilletRadiusLaw(
    law: readonly FilletRadiusPoint[],
    scope: Scope,
): Result<FilletRadiusSample[]> {
    if (!Array.isArray(law) || law.length < 2 || law.length > MAX_FILLET_RADIUS_SAMPLES)
        return Result.err(`Radius law requires 2 to ${MAX_FILLET_RADIUS_SAMPLES} samples`);
    const samples: FilletRadiusSample[] = [];
    for (let index = 0; index < law.length; index++) {
        const point = law[index];
        if (!point || (typeof point.radius !== "number" && typeof point.radius !== "string"))
            return Result.err(`Radius law sample ${index + 1} requires a length or expression`);
        const radius = resolveUnitSpec(point.radius, scope, LENGTH_UNITS);
        if (!radius.isOk) return Result.err(`Radius law sample ${index + 1}: ${radius.error}`);
        samples.push({ position: point.position, radius: radius.value });
    }
    const error = validateFilletRadiusLaw(samples);
    return error ? Result.err(error) : Result.ok(samples);
}
