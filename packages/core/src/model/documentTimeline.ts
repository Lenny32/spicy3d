// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { I18nKeys } from "../i18n";
import { ShapeTypes } from "../shape/shapeType";
import { VisualStates } from "../visual/visualShape";
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
 * only walked. A feature's inputs are pulled before the feature reading them (`dependsOn`): a
 * sketch added after its body for a join extrude, or a consumed boolean tool, comes right
 * before that feature and is skipped at its own place in the tree. Other bodies are never pulled
 * forward (that would drag their whole feature list along, and two bodies may read each other):
 * they keep their place, and a body's other children (consumed tools no feature pulls) come before
 * its features, since they were made before the boolean consuming them.
 */
export function documentTimeline(document: IDocument): TimelineEntry[] {
    const root = document.modelManager.rootNode;
    const walk: TimelineWalk = {
        entries: [],
        visited: new Set(),
        nodesById: new Map(NodeUtils.findNodes(root).map((node) => [node.id, node])),
    };
    visitChildren(root, walk);
    return walk.entries;
}

interface TimelineWalk {
    readonly entries: TimelineEntry[];
    /** Nodes already walked, so a node pulled before a feature is not listed again. */
    readonly visited: Set<INode>;
    readonly nodesById: ReadonlyMap<string, INode>;
}

function visitChildren(parent: INode, walk: TimelineWalk, skip?: ReadonlySet<string>) {
    if (!NodeUtils.isLinkedListNode(parent)) return;
    for (let child = parent.firstChild; child !== undefined; child = child.nextSibling) {
        if (skip?.has(child.id)) continue;
        visit(child, walk);
    }
}

function visit(node: INode, walk: TimelineWalk) {
    if (walk.visited.has(node)) return;
    walk.visited.add(node);
    const features = isFeatureListNode(node) ? node.featureItems() : [];
    if (!isFeatureListNode(node) || features.length === 0) {
        visitChildren(node, walk);
        if (node instanceof FolderNode) return;
        walk.entries.push({ kind: "node", key: node.id, node, icon: nodeIcon(node) });
        return;
    }
    visitFeatures(node, features, walk);
}

function visitFeatures(node: INode & IFeatureListNode, features: readonly FeatureItem[], walk: TimelineWalk) {
    const pulled = new Set(
        features
            .flatMap((feature) => feature.dependsOn ?? [])
            .filter((id) => {
                const input = walk.nodesById.get(id);
                return input !== undefined && isPlainStep(input);
            }),
    );
    visitChildren(node, walk, pulled);
    const icon = nodeIcon(node);
    for (const feature of features) {
        for (const id of feature.dependsOn ?? []) {
            const input = walk.nodesById.get(id);
            if (input !== undefined && pulled.has(id)) visit(input, walk);
        }
        walk.entries.push({
            kind: "feature",
            key: `${node.id}/${feature.id}`,
            node,
            icon: feature.icon ?? icon,
            feature,
        });
    }
}

/** A step pulled before the feature reading it: not a folder, nor a body with its own features. */
function isPlainStep(node: INode): boolean {
    if (node instanceof FolderNode) return false;
    return !isFeatureListNode(node) || node.featureItems().length === 0;
}

function nodeIcon(node: INode): string {
    return isNodeIcon(node) ? node.icon : FALLBACK_ICON;
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

/**
 * Highlights the entry's result in the viewport, so it is easy to find: the faces a feature
 * created (`featureFaces`), or a node's whole shape. Returns the function taking it off again.
 */
export function highlightTimelineEntry(document: IDocument, entry: TimelineEntry): () => void {
    const visual = document.visual.context.getVisual(entry.node);
    if (visual === undefined) return () => {};
    const highlighter = document.visual.highlighter;
    const state = VisualStates.faceHighlight;
    if (entry.kind === "node") {
        highlighter.addState(visual, state, ShapeTypes.shape);
        return () => highlighter.removeState(visual, state, ShapeTypes.shape);
    }
    const faces = entry.node.featureFaces?.(entry.feature.id) ?? [];
    if (faces.length === 0) return () => {};
    highlighter.addState(visual, state, ShapeTypes.face, ...faces);
    return () => highlighter.removeState(visual, state, ShapeTypes.face, ...faces);
}
