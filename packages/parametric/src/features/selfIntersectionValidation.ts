// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@spicy3d/core";

/** Sync handlers cannot await a cancellable worker: bound the analyzer's topology instead. */
export function validateSelfIntersection(shape: IShape, warn?: (message: string) => void): Result<boolean> {
    const faces = shape.findSubShapes(ShapeTypes.face);
    const edges = shape.findSubShapes(ShapeTypes.edge);
    try {
        if (faces.length > 256) return Result.err("Shape exceeds the 256-face validation limit");
        if (!shape.checkShape()) return Result.err("Shape is invalid");
        if (faces.length > 32 || edges.length > 64) {
            const volume = shape.volume();
            const solids = shape.findSubShapes(ShapeTypes.solid);
            try {
                if (!Number.isFinite(volume) || (solids.length > 0 && volume <= 1e-8))
                    return Result.err("Shape has invalid volume");
            } finally {
                for (const solid of solids) solid.dispose();
            }
            warn?.("Self-intersection check skipped for large shape");
            return Result.ok(true);
        }
        return shape.checkSelfIntersection?.() ?? Result.err("Self-intersection validation unavailable");
    } finally {
        for (const item of [...faces, ...edges]) item.dispose();
    }
}
