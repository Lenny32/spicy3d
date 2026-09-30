// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, isNodeReferences, Result } from "@spicy3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";

/** Snapshot the automatic search universe; never persist an implicitly selected face. */
export function captureNextCandidateIds(document: IDocument, hostId?: string): Result<string[]> {
    const nodes = document.modelManager.findNodes(() => true);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const dependsOnHost = (id: string, visiting = new Set<string>()): boolean => {
        if (hostId === undefined) return false;
        if (id === hostId) return true;
        if (visiting.has(id)) return false;
        visiting.add(id);
        const node = byId.get(id);
        return isNodeReferences(node) && node.referencedNodeIds().some((ref) => dependsOnHost(ref, visiting));
    };
    const ids = nodes
        .filter((node): node is ParametricBodyNode => node instanceof ParametricBodyNode)
        .filter((node) => node.id !== hostId && node.visible && node.rollbackIndex === undefined)
        .filter(
            (node) =>
                !(
                    node.parent instanceof ParametricBodyNode &&
                    node.parent.consumingFeatureIndex(node.id) !== undefined
                ),
        )
        .filter((node) => !dependsOnHost(node.id))
        .filter((node) => node.shape.isOk)
        .map((node) => node.id);
    if (ids.length > 1024)
        return Result.err(
            "Next-face candidate snapshot exceeds 1024 bodies; hide unrelated bodies before authoring",
        );
    return Result.ok(ids);
}
