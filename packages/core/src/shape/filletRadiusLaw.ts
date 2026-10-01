// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A resolved radius at normalized arc length along an edge's natural curve direction. */
export interface FilletRadiusSample {
    readonly position: number;
    readonly radius: number;
}

export const MAX_FILLET_RADIUS_SAMPLES = 64;

export function validateFilletRadiusLaw(law: readonly FilletRadiusSample[]): string | undefined {
    if (!Array.isArray(law) || law.length < 2 || law.length > MAX_FILLET_RADIUS_SAMPLES)
        return `Radius law requires 2 to ${MAX_FILLET_RADIUS_SAMPLES} samples`;
    if (law[0]?.position !== 0 || law[law.length - 1]?.position !== 1)
        return "Radius law must start at position 0 and end at position 1";
    let previous = -1;
    for (const sample of law) {
        if (
            !sample ||
            !Number.isFinite(sample.position) ||
            sample.position < 0 ||
            sample.position > 1 ||
            sample.position <= previous
        )
            return "Radius law positions must be finite, strictly increasing numbers from 0 to 1";
        if (!Number.isFinite(sample.radius) || sample.radius <= 0)
            return "Radius law radii must be positive finite lengths";
        previous = sample.position;
    }
    return undefined;
}
