// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { INode } from "../model";
import { requestFeatureFocus } from "../model/featureList";
import { parseMergePath } from "./types";

// "Show me": what the conflict panel (CLOUD-13) does when a conflict or a change is selected — the
// object its merge path names is selected (highlighted in the viewport and the tree), a feature is
// opened in the body's timeline, and modules reveal their own items (the sketch module selects a
// sketch entity).

/** What a merge path was revealed as. */
export interface RevealedTarget {
    readonly node: INode;
    /** The feature opened in the timeline (`node/<body>/feature/<id>/…`). */
    readonly featureId?: string;
}

/** A module's own part of revealing a path inside one of its nodes (e.g. a sketch entity). */
export interface IMergePathRevealer {
    /**
     * Called after `node` (the node the path names) was selected; `segments` are the path's
     * segments after `node/<id>`. Returns whether it revealed something more.
     */
    reveal(document: IDocument, node: INode, segments: readonly string[]): boolean;
}

export class MergePathRevealers {
    private static readonly revealers = new Set<IMergePathRevealer>();

    /** Adds a revealer; returns the function that removes it. */
    static register(revealer: IMergePathRevealer): () => void {
        MergePathRevealers.revealers.add(revealer);
        return () => MergePathRevealers.revealers.delete(revealer);
    }

    static get all(): readonly IMergePathRevealer[] {
        return [...MergePathRevealers.revealers];
    }
}

/** The node of `document` a merge path is about (`node/<id>/…`), if it has it. */
export function nodeOfMergePath(document: IDocument, path: string): INode | undefined {
    const [root, id] = parseMergePath(path);
    if (root !== "node" || id === undefined) return undefined;
    return document.modelManager.findNode((node) => node.id === id);
}

/**
 * Selects what `path` names in `document`: its node (which highlights it), and for a feature path
 * opens that feature in the body's timeline; registered revealers go further (a sketch entity).
 * `undefined` when the document has no such node (deleted there, or a document-level path).
 */
export function revealMergePath(document: IDocument, path: string): RevealedTarget | undefined {
    const node = nodeOfMergePath(document, path);
    if (!node) return undefined;
    const rest = parseMergePath(path).slice(2);
    const featureId = rest[0] === "feature" ? rest[1] : undefined;
    // Asked before the selection, which builds the timeline that takes the request.
    if (featureId !== undefined) requestFeatureFocus(node, featureId);
    document.selection.setSelectedNodes([node], false);
    for (const revealer of MergePathRevealers.all) {
        if (revealer.reveal(document, node, rest)) break;
    }
    return featureId === undefined ? { node } : { node, featureId };
}
