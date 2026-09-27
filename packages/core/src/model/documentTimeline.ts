// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { I18nKeys } from "../i18n";
import {
    type FeatureItem,
    type IFeatureListNode,
    isFeatureListNode,
    requestFeatureFocus,
    takeFeatureFocus,
} from "./featureList";
import { FolderNode } from "./folderNode";
import { type INode, NodeUtils } from "./node";
import { isNodeIcon } from "./nodeIcon";

/** Shown for a node that declares no icon of its own. */
const FALLBACK_ICON = "icon-box";

/** One step of the document's design history, as the timeline bar shows it. */
export type TimelineEntry =
    | {
          readonly kind: "node";
          /** Stable across rebuilds: the timeline keeps scroll position and spots new entries by it. */
          readonly key: string;
          readonly node: INode;
          readonly icon: string;
      }
    | {
          readonly kind: "feature";
          readonly key: string;
          /** The body owning the feature. */
          readonly node: INode & IFeatureListNode;
          readonly icon: string;
          readonly feature: FeatureItem;
      };

/**
 * The document's design history in model order, Fusion-timeline style: every node of the tree
 * is a step (a sketch, a primitive, an imported shape), except that a node with a feature list
 * (a parametric body) contributes one step per feature instead, in replay order. Folders are
 * only walked; a body's own children (consumed boolean tools) come before its features, since
 * they were made before the boolean consuming them.
 */
export function documentTimeline(document: IDocument): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    visitChildren(document.modelManager.rootNode, entries);
    return entries;
}

function visitChildren(parent: INode, entries: TimelineEntry[]) {
    if (!NodeUtils.isLinkedListNode(parent)) return;
    for (let child = parent.firstChild; child !== undefined; child = child.nextSibling) {
        visit(child, entries);
    }
}

function visit(node: INode, entries: TimelineEntry[]) {
    visitChildren(node, entries);
    if (node instanceof FolderNode) return;
    const icon = isNodeIcon(node) ? node.icon : FALLBACK_ICON;
    const features = isFeatureListNode(node) ? node.featureItems() : [];
    if (!isFeatureListNode(node) || features.length === 0) {
        entries.push({ kind: "node", key: node.id, node, icon });
        return;
    }
    for (const feature of features) {
        entries.push({
            kind: "feature",
            key: `${node.id}/${feature.id}`,
            node,
            icon: feature.icon ?? icon,
            feature,
        });
    }
}

/** The entry's own name: a feature's user name or kind, a node's name. */
export function timelineEntryLabel(entry: TimelineEntry, translate: (key: I18nKeys) => string): string {
    if (entry.kind === "node") return entry.node.name;
    return entry.feature.name || translate(entry.feature.display);
}

/** Selects the entry's node; a feature is also opened in the body's feature list. */
export function revealTimelineEntry(document: IDocument, entry: TimelineEntry): void {
    const featureId = entry.kind === "feature" ? entry.feature.id : undefined;
    // Asked before the selection, which builds the feature list that takes the request.
    if (featureId !== undefined) requestFeatureFocus(entry.node, featureId);
    document.selection.setSelectedNodes([entry.node], false);
    // A request nobody took (the property panel not shown) must not open a feature later.
    if (featureId !== undefined) takeFeatureFocus(entry.node);
}
