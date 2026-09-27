// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GroupNode, type INode } from "../model";

const PALETTE = [
    0x3d84c6, 0xd9843b, 0x56a86a, 0x9b6bc5, 0xc96078, 0x64a7ad, 0xb39a3c, 0x667ed1, 0xcf684a, 0x6c9b43,
    0xae70a9, 0x4994bb,
];

/** The nearest containing group owns a component; an ungrouped node owns itself. */
export function componentAnalysisColor(node: INode): number {
    let ownerId = node.id;
    let parent = node.parent;
    while (parent) {
        if (parent instanceof GroupNode) {
            ownerId = parent.id;
            break;
        }
        parent = parent.parent;
    }
    let hash = 2166136261;
    for (const char of ownerId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return PALETTE[(hash >>> 0) % PALETTE.length];
}
