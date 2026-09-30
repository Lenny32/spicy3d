// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IShape,
    type IWire,
    type Matrix4,
    Result,
    ShapeTypes,
    type XYZLike,
} from "@spicy3d/core";
import { projectForwardCurve, projectionCurveId } from "./projectedCurves";
import type { ResolvedProjectionTarget } from "./projectionTargetReferences";
import { isReusableTopologyIdentity } from "./reusableTopologyIdentity";

/** A logical source span, compatible with the shared path resolver's reference result. */
export interface ProjectionSourceSpan {
    readonly edges: readonly IEdge[];
    readonly seed: string;
    readonly stable: boolean;
}

export interface ProjectionResult {
    readonly shape: IWire;
    /** Native output edge order; each ID comes from its actual source span and target ancestry. */
    readonly edgeIds: string[];
}

/** Project host-local spans along a fixed world vector, retaining semantic source provenance. */
export function buildProjectionResult(
    featureId: string,
    sourceNodeId: string,
    source: readonly ProjectionSourceSpan[],
    targetNodeId: string,
    target: ResolvedProjectionTarget,
    worldDirection: XYZLike,
    hostWorld: Matrix4,
): Result<ProjectionResult> {
    if (!worldDirection || ![worldDirection.x, worldDirection.y, worldDirection.z].every(Number.isFinite))
        return Result.err("Projection direction must be finite");
    if (source.length === 0 || source.length > 256)
        return Result.err("Projection requires 1 to 256 logical source references");
    if (
        source.some((span) => !span.stable || !isReusableTopologyIdentity(span.seed)) ||
        !target.stableIdentity ||
        !isReusableTopologyIdentity(target.seed)
    )
        return Result.err("Associative projection requires tracked source edges and a tracked target face");
    const inverse = hostWorld.invert();
    if (inverse === undefined) return Result.err("Projection host placement is not invertible");
    const direction = inverse.ofVector(worldDirection);
    if (direction.normalize() === undefined) return Result.err("Projection direction must be nonzero");
    const owned: IShape[] = [];
    let accepted: IWire | undefined;
    try {
        const projectedEdges: IEdge[] = [];
        const ids: string[] = [];
        for (const span of source) {
            if (span.edges.length === 0) return Result.err("Projection source reference has no edge pieces");
            const wire = shapeFactory.wire([...span.edges]);
            if (!wire.isOk) return Result.err(`Projection source span: ${wire.error}`);
            owned.push(wire.value);
            const projected = projectForwardCurve(wire.value, target.face, direction);
            if (!projected.isOk) return Result.err(projected.error);
            owned.push(projected.value);
            const pieces = projected.value.findSubShapes(ShapeTypes.edge) as IEdge[];
            projectedEdges.push(...pieces);
            if (projectedEdges.length > 512)
                return Result.err("Projection exceeds the 512-output-piece limit");
            const id = projectionCurveId(featureId, sourceNodeId, span.seed, targetNodeId, target.seed);
            ids.push(...pieces.map(() => id));
        }
        const joined = shapeFactory.wire(projectedEdges);
        if (!joined.isOk) return Result.err(`Projected source spans do not form one curve: ${joined.error}`);
        owned.push(joined.value);
        const outputs = joined.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        // MakeWire copies inputs to protect their vertices. Transfer existing ancestry
        // only through unchanged geometry with a unique match.
        const candidateBounds = projectedEdges.map((edge) => edge.geometryBoundingBox());
        const candidateLengths = projectedEdges.map((edge) => edge.length());
        let comparisons = 0;
        const edgeIds: string[] = [];
        for (const edge of outputs) {
            const bounds = edge.geometryBoundingBox();
            const edgeLength = edge.length();
            const matches: number[] = [];
            for (const [index, candidate] of projectedEdges.entries()) {
                if (Math.abs(edgeLength - candidateLengths[index]) > 1e-6) continue;
                const other = candidateBounds[index];
                if (
                    ["x", "y", "z"].some((axis) => {
                        const key = axis as "x" | "y" | "z";
                        return (
                            bounds.max[key] < other.min[key] - 1e-6 || other.max[key] < bounds.min[key] - 1e-6
                        );
                    })
                )
                    continue;
                if (++comparisons > 8192)
                    return Result.err(
                        "Projection ancestry proof exceeds the 8192-comparison limit; select fewer source edges",
                    );
                const overlap = shapeFactory.booleanCommon([edge], [candidate]);
                if (!overlap.isOk) {
                    if (overlap.error === "Boolean produced an empty shape") continue;
                    return Result.err(`Projection ancestry comparison failed: ${overlap.error}`);
                }
                try {
                    const length = overlap.value
                        .findSubShapes(ShapeTypes.edge)
                        .reduce((sum, piece) => sum + (piece as IEdge).length(), 0);
                    if (Math.abs(length - edgeLength) <= 1e-6) matches.push(index);
                } finally {
                    overlap.value.dispose();
                }
            }
            if (matches.length !== 1)
                return Result.err(
                    "Projected curve provenance is ambiguous after assembling its source spans",
                );
            edgeIds.push(ids[matches[0]]);
        }
        if (edgeIds.length !== projectedEdges.length)
            return Result.err(
                "Projection merged overlapping source spans; select distinct whole-edge references",
            );
        accepted = joined.value;
        return Result.ok({ shape: accepted, edgeIds });
    } catch (error) {
        return Result.err(`Projection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        for (const shape of owned) if (shape !== accepted) shape.dispose();
    }
}
