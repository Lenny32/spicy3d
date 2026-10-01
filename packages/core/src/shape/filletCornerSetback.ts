// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Acceptance limits of the bounded fitted corner, in millimetres and radians. */
export const CORNER_SETBACK_DISTANCE_TOLERANCE = 1e-4;
export const CORNER_SETBACK_ANGLE_TOLERANCE = 1e-3;

/** Geometry-independent validation, also applied before sending a worker request. */
export function validateFilletCornerSetback(
    edges: readonly number[],
    radius: number,
    distances: readonly number[],
): string | undefined {
    if (edges.length !== 3 || distances.length !== 3)
        return "Corner setbacks require exactly three edges and three distances";
    if (edges.some((edge) => !Number.isSafeInteger(edge) || edge < 0 || edge > 2147483646))
        return "Corner setback edge indexes must be finite nonnegative integers";
    if (new Set(edges).size !== 3) return "Corner setbacks require three distinct edges";
    if (!Number.isFinite(radius) || radius <= 0) return "Corner setback radius must be positive and finite";
    if (
        distances.some(
            (distance) =>
                !Number.isFinite(distance) || distance <= radius + CORNER_SETBACK_DISTANCE_TOLERANCE,
        )
    )
        return "Each setback must be finite and exceed the fillet radius";
    return undefined;
}
