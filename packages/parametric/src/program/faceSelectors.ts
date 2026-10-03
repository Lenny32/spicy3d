// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IFace, ShapeNode, XYZLike } from "@spicy3d/core";
import { ID_COMPONENT_SEPARATOR, idsOverlap } from "../features/trackedId";
import { ParametricBodyNode } from "../parametricBodyNode";

/** Runtime predicates in body-local coordinates; all predicates intersect. Never serialized. */
export interface FaceSelector {
    faceIds?: string[];
    featureIds?: string[];
    containsPoint?: XYZLike;
    largest?: boolean;
    tolerance?: number;
}

export function selectFaceIndexes(
    node: ShapeNode,
    faces: IFace[],
    ids: readonly string[],
    selector: FaceSelector,
    timelineIndex?: number,
): number[] {
    if (selector === null || typeof selector !== "object" || Array.isArray(selector))
        throw new Error("face selector must be an object");
    for (const key of Object.keys(selector))
        if (!["faceIds", "featureIds", "containsPoint", "largest", "tolerance"].includes(key))
            throw new Error(`unknown face selector field "${key}"`);
    const tolerance = selector.tolerance ?? 1e-6;
    if (!Number.isFinite(tolerance) || tolerance <= 0)
        throw new Error("face selector tolerance must be positive and finite");
    if (selector.largest !== undefined && typeof selector.largest !== "boolean")
        throw new Error("largest must be a boolean");
    for (const key of ["faceIds", "featureIds"] as const) {
        const given = selector[key];
        if (
            given !== undefined &&
            (!Array.isArray(given) ||
                given.length === 0 ||
                given.some((id) => typeof id !== "string" || id.length === 0))
        )
            throw new Error(`${key} must be a non-empty array of ids`);
    }
    const point = selector.containsPoint;
    if (point !== undefined && (point === null || ![point.x, point.y, point.z].every(Number.isFinite)))
        throw new Error("containsPoint requires finite x, y and z");
    const leaves = (values: readonly string[]) => values.flatMap((id) => id.split(ID_COMPONENT_SEPARATOR));
    let origins: Set<string> | undefined;
    if (selector.featureIds !== undefined) {
        if (!(node instanceof ParametricBodyNode)) throw new Error("featureIds requires a parametric body");
        origins = new Set<string>();
        for (const id of selector.featureIds) {
            const index = node.features.findIndex((feature) => feature.id === id);
            if (index < 0) throw new Error(`unknown feature origin "${id}"`);
            if (timelineIndex !== undefined && index >= timelineIndex)
                throw new Error(`feature "${id}" is not before the queried timeline position`);
            if (node.features[index].suppressed) continue;
            const before = new Set(leaves(node.timelineStateAt(index)?.faceIds ?? []));
            const after = node.timelineStateAt(index + 1)?.faceIds ?? ids;
            for (const leaf of leaves(after)) if (!before.has(leaf)) origins.add(leaf);
        }
    }
    let indexes = faces.flatMap((face, index) => {
        const id = ids[index] ?? "";
        if (selector.faceIds !== undefined && !selector.faceIds.some((given) => idsOverlap(id, given)))
            return [];
        if (origins !== undefined && !id.split(ID_COMPONENT_SEPARATOR).some((leaf) => origins.has(leaf)))
            return [];
        if (point !== undefined && !face.containsPoint(point, true, tolerance)) return [];
        return [index];
    });
    if (selector.largest && indexes.length > 0) {
        const areas = indexes.map((index) => Math.abs(faces[index].area()));
        const largest = Math.max(...areas);
        // Ties remain candidates so a single-face consumer refuses ambiguity.
        indexes = indexes.filter((_, i) => Math.abs(areas[i] - largest) <= 1e-6 * Math.max(1, largest));
    }
    return indexes;
}
