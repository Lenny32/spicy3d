// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, type ParameterValue, Result, resolveUnitSpec, type Scope } from "@spicy3d/core";
import { type EdgeRef, sameEdgeFingerprint } from "./edgeRef";
import type { FilletFeatureData } from "./feature";

/** Distances are arc lengths measured away from the common vertex on the selected input edges. */
export interface FilletCornerSetback {
    readonly edges: [EdgeRef, EdgeRef, EdgeRef];
    readonly distances: [ParameterValue, ParameterValue, ParameterValue];
}

/** Resolve independent distances into the feature's selected-edge order without detaching their refs. */
export function resolveCornerSetbacks(feature: FilletFeatureData, scope: Scope): Result<number[]> {
    if (feature.radiusLaw !== undefined)
        return Result.err("Corner setbacks currently require a constant fillet radius");
    const corners = feature.cornerSetbacks;
    if (!Array.isArray(corners) || corners.length !== 1 || feature.edges.length !== 3)
        return Result.err("Corner setbacks currently require one corner and exactly three selected edges");
    const corner = corners[0];
    if (
        !corner ||
        !Array.isArray(corner.edges) ||
        corner.edges.length !== 3 ||
        !Array.isArray(corner.distances) ||
        corner.distances.length !== 3
    )
        return Result.err("A corner setback requires three edge references and three distances");
    const unused = new Set([0, 1, 2]);
    const distances: number[] = [];
    for (const selected of feature.edges) {
        const candidates = [...unused].filter((index) => {
            const ref = corner.edges[index];
            if (!ref || !selected) return false;
            return selected.edgeId && ref.edgeId
                ? selected.edgeId === ref.edgeId && selected.splitPiece === ref.splitPiece
                : sameEdgeFingerprint(selected, ref);
        });
        if (candidates.length !== 1)
            return Result.err("Corner setback references must match the three selected edges unambiguously");
        const index = candidates[0];
        unused.delete(index);
        const value = corner.distances[index];
        if (typeof value !== "number" && typeof value !== "string")
            return Result.err(`Corner setback ${index + 1} requires a length or expression`);
        const resolved = resolveUnitSpec(value, scope, LENGTH_UNITS);
        if (!resolved.isOk) return Result.err(`Corner setback ${index + 1}: ${resolved.error}`);
        if (!Number.isFinite(resolved.value) || resolved.value <= 0)
            return Result.err(`Corner setback ${index + 1} must be positive and finite`);
        distances.push(resolved.value);
    }
    return Result.ok(distances);
}
