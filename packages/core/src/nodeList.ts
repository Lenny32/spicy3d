// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEqualityComparer } from "./foundation";
import type { INode } from "./model";

/**
 * The bodies (or other nodes) a command acts on, shown in its options tab as a list — one
 * entry per node with a remove button, plus an add toggle — through a `nodeList` property
 * (see `PropertyType`). The command publishes a new list whenever it changes (a plain
 * property change), so the tab redraws from the value it reads.
 */
export interface INodeList {
    /** The list's caption when it depends on the command's state; else the property's display name. */
    readonly label?: string;
    readonly nodes: readonly INode[];
    /** Nodes the command keeps whatever happens (e.g. an extrude's host body): no remove button. */
    readonly fixed?: readonly INode[];
    remove(node: INode): void;
    /**
     * Present when nodes can be added: `toggle` switches picking them in the viewport on or
     * off (a plain click on a body adds it while `active`).
     */
    readonly add?: { readonly active: boolean; toggle(): void };
}

const sameNodes = (a: readonly INode[] | undefined, b: readonly INode[] | undefined) =>
    (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b?.[i]);

/**
 * Two lists that show the same (caption, nodes, fixed ones, add toggle): a command rebuilding
 * its list on every preview publishes it through this so the options tab redraws only on a change.
 */
export const NodeListComparer: IEqualityComparer<INodeList | undefined> = {
    equals(left, right) {
        if (left === right) return true;
        if (left === undefined || right === undefined) return false;
        return (
            left.label === right.label &&
            sameNodes(left.nodes, right.nodes) &&
            sameNodes(left.fixed, right.fixed) &&
            (left.add === undefined) === (right.add === undefined) &&
            left.add?.active === right.add?.active
        );
    },
};
