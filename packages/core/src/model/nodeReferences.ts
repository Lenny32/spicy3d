// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode, INodeLinkedList } from "./node";
import { NodeUtils } from "./node";

/**
 * Implemented by nodes that read other nodes by id — a parametric body's features
 * (the sketches they consume), a sketch's plane face and projected edges, a datum's
 * source geometry. Deleting a referenced node leaves the reader failing to rebuild,
 * so the delete command asks first; the node knows nothing about who asks.
 */
export interface INodeReferences {
    /** Ids of every node this one reads; duplicates and missing ids are allowed. */
    referencedNodeIds(): readonly string[];
}

export function isNodeReferences(node: unknown): node is INodeReferences {
    return typeof (node as INodeReferences | undefined)?.referencedNodeIds === "function";
}

/**
 * The nodes left in the tree that read one of `removed` (or a descendant of one) —
 * what deleting `removed` would break. Readers removed along with them don't count.
 */
export function findNodeDependents(root: INodeLinkedList, removed: readonly INode[]): INode[] {
    const gone = new Set<INode>();
    for (const node of removed) {
        gone.add(node);
        if (NodeUtils.isLinkedListNode(node)) NodeUtils.findNodes(node).forEach((x) => gone.add(x));
    }
    const goneIds = new Set([...gone].map((x) => x.id));
    return NodeUtils.findNodes(
        root,
        (node) =>
            !gone.has(node) &&
            isNodeReferences(node) &&
            node.referencedNodeIds().some((id) => id !== node.id && goneIds.has(id)),
    );
}
