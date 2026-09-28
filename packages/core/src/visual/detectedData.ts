// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Matrix4, XYZ } from "../math";
import type { IShape, ISubShape, ShapeMeshRange } from "../shape";
import type { INodeVisual } from "./visualObject";

export interface VisualShapeData {
    shape: IShape;
    owner: INodeVisual;
    transform: Matrix4;
    point?: XYZ;
    /** Mesh-range positions for highlighting, NOT findSubShapes/topology indexes. */
    indexes: number[];
}

/** The picked primitive's topology position. Never infer it from a mesh-range position. */
export function pickedTopologyIndex(picked: Pick<VisualShapeData, "shape">): number | undefined {
    const index = (picked.shape as Partial<ISubShape>).index;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** Reverse mapping for topology-driven preselection. Omitted subshapes have no mesh ranges. */
export function meshIndexesForTopology(ranges: readonly ShapeMeshRange[], index: number): number[] {
    const indexes: number[] = [];
    ranges.forEach((range, meshIndex) => {
        if (pickedTopologyIndex(range) === index) indexes.push(meshIndex);
    });
    return indexes;
}
