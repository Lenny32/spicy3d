// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { BoundingBox } from "../math";

/** Allow integration roundoff in slivers, relative to the shape's geometric scale (mm³). */
export function volumeTolerance(total: number, bounds: BoundingBox): number {
    const boxVolume = Math.abs(
        (bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y) * (bounds.max.z - bounds.min.z),
    );
    return Math.max(Math.abs(total), boxVolume) * 1e-10;
}
