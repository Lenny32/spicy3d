// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes, sha256HexSync, type TrackedCornerResult } from "@spicy3d/core";
import type { ShapeTracking } from "./feature";
import { isReusableTopologyIdentity } from "./reusableTopologyIdentity";
import { ancestorInputs, combineIds } from "./trackedId";

function derivedId(featureId: string, role: string, sources: readonly string[]): string {
    const leaves = combineIds(sources).split("|");
    return `${featureId}:setback:${role}:${sha256HexSync(new TextEncoder().encode(JSON.stringify(leaves)))}`;
}

/** Preserve actual derivations and name new joins from their verified adjacent constructed faces. */
export function trackCornerSetback(
    featureId: string,
    tracking: ShapeTracking,
    selectedEdges: readonly number[],
    result: TrackedCornerResult,
): Result<IShape> {
    const sourceEdges = selectedEdges.map((index) => tracking.inputEdgeIds[index]);
    if (sourceEdges.length !== 3 || sourceEdges.some((id) => !isReusableTopologyIdentity(id)))
        return Result.err("Corner setback selected edges require complete source ancestry");
    const faces = result.shape.findSubShapes(ShapeTypes.face);
    const edges = result.shape.findSubShapes(ShapeTypes.edge);
    const owned: IShape[] = [...faces, ...edges];
    try {
        if (
            result.cornerFaces.length !== 1 ||
            result.faceMap.length !== faces.length ||
            result.edgeMap.length !== edges.length
        )
            return Result.err("Corner setback output topology has incomplete construction history");
        const corner = result.cornerFaces[0];
        if (corner < 0 || corner >= faces.length) return Result.err("Corner setback corner face is missing");
        const faceOrigins = ancestorInputs(result.faceMap, result.faceAncestors);
        const edgeOrigins = ancestorInputs(result.edgeMap, result.edgeAncestors);
        const constructed = new Set<number>([corner]);
        const faceIds: string[] = [];
        for (let index = 0; index < faces.length; index++) {
            if (index === corner) {
                const origins = faceOrigins[index].map((source) => tracking.inputFaceIds[source]);
                if (origins.length !== 3 || origins.some((id) => !isReusableTopologyIdentity(id)))
                    return Result.err("Corner setback patch requires three actual supporting-face ancestors");
                faceIds.push(derivedId(featureId, "corner", sourceEdges));
                continue;
            }
            const generatingEdge = result.faceEdgeMap?.[index] ?? -1;
            if (selectedEdges.includes(generatingEdge)) {
                const source = tracking.inputEdgeIds[generatingEdge];
                if (!isReusableTopologyIdentity(source))
                    return Result.err("Corner setback strip ancestry is missing");
                faceIds.push(derivedId(featureId, "strip", [source]));
                constructed.add(index);
                continue;
            }
            const origins = faceOrigins[index].map((source) => tracking.inputFaceIds[source]);
            if (origins.length === 0 || origins.some((id) => !isReusableTopologyIdentity(id)))
                return Result.err("Corner setback retained face ancestry is missing");
            faceIds.push(combineIds(origins));
        }
        const faceEdges = faces.map((face) => {
            const members = face.findSubShapes(ShapeTypes.edge);
            owned.push(...members);
            return members;
        });
        const edgeIds: string[] = [];
        const newJoins = new Set<string>();
        for (let index = 0; index < edges.length; index++) {
            const origins = edgeOrigins[index].map((source) => tracking.inputEdgeIds[source]);
            if (origins.length !== 0) {
                if (origins.some((id) => !isReusableTopologyIdentity(id)))
                    return Result.err("Corner setback edge ancestry is incomplete");
                edgeIds.push(combineIds(origins));
                continue;
            }
            const adjacent = faceEdges.flatMap((members, face) =>
                members.some((member) => member.isSame(edges[index])) ? [face] : [],
            );
            if (adjacent.length !== 2 || !adjacent.some((face) => constructed.has(face)))
                return Result.err("Corner setback new edge lacks an unambiguous constructed-face join");
            const id = derivedId(
                featureId,
                "join",
                adjacent.map((face) => faceIds[face]),
            );
            if (newJoins.has(id))
                return Result.err(
                    "Corner setback has multiple ambiguous edges at the same constructed-face join",
                );
            newJoins.add(id);
            edgeIds.push(id);
        }
        tracking.outputFaceIds = faceIds;
        tracking.outputEdgeIds = edgeIds;
        return Result.ok(result.shape);
    } finally {
        for (const shape of owned) shape.dispose();
    }
}
