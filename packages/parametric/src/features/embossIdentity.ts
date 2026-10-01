// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, ShapeTypes, type XYZ } from "@spicy3d/core";
import { captureEdgeRef } from "./edgeRef";
import { profileEdgeEntityIds } from "./profileEntities";
import { MATCH_TOLERANCE } from "./refGeometry";

/** Thicken has no kernel history: recover side ancestry from its unchanged patch boundary. */
export function reliefIds(
    shape: IShape,
    patch: IFace,
    profile: IFace,
    originalProfile: IFace,
    normal: XYZ,
    seed: string,
): { faceIds: string[]; edgeIds: string[] } {
    const boundary = patch.findSubShapes(ShapeTypes.edge) as IEdge[];
    const sources = profile.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faceEdges = faces.map((face) => face.findSubShapes(ShapeTypes.edge) as IEdge[]);
    try {
        const entities = profileEdgeEntityIds(originalProfile);
        const sourceOrigin = profile.normal(0, 0)[0];
        const boundaryIds = boundary.map((edge) => {
            const first = edge.firstParameter(),
                last = edge.lastParameter();
            const points = [first, (first + last) / 2, last].map((t) => {
                const point = edge.pointAt(t);
                return point.sub(normal.multiply(point.sub(sourceOrigin).dot(normal)));
            });
            const index = sources.findIndex((source) => {
                const curve = source.curve;
                return points.every((point) => curve.nearestFromPoint(point).distance < MATCH_TOLERANCE);
            });
            return index >= 0 && entities?.[index] !== undefined
                ? `ent${entities[index]}`
                : `boundary:${JSON.stringify(captureEdgeRef(edge))}`;
        });
        const faceIds = faces.map((face, index) => {
            if (face.isSame(patch)) return `${seed}:base`;
            const ancestors = boundary.flatMap((edge, k) =>
                faceEdges[index].some((candidate) => candidate.isSame(edge)) ? [boundaryIds[k]] : [],
            );
            return ancestors.length > 0 ? `${seed}:side:${ancestors.sort().join("+")}` : `${seed}:top`;
        });
        const edgeIds = edges.map((edge) => {
            const adjacent = faceEdges.flatMap((list, index) =>
                list.some((candidate) => candidate.isSame(edge)) ? [faceIds[index]] : [],
            );
            return `${seed}:edge:${adjacent.sort().join("+")}`;
        });
        return { faceIds, edgeIds };
    } finally {
        [...boundary, ...sources, ...faces, ...edges, ...faceEdges.flat()].forEach((shape) => {
            shape.dispose();
        });
    }
}
