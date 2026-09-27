// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentFormatError, DocumentMigrations } from "./documentFormat";
import { Result } from "./foundation";
import type { I18nKeys } from "./i18n";
import { InternalClassName, type Serialized } from "./serialize";

export type DocumentChangeKind = "added" | "removed" | "renamed" | "modified";

/** One line of a comparison, e.g. "Box 1 deleted"; the text is `I18n.translate(message, ...args)`. */
export interface DocumentChange {
    kind: DocumentChangeKind;
    /** What changed (a node id), stable across comparisons. */
    target: string;
    message: I18nKeys;
    args: unknown[];
}

/**
 * Tells what changed between two serialized documents, both already migrated to this build's
 * format (`diffDocuments` does that). The version history's "Compare" lists its answer.
 */
export interface IDocumentDiffer {
    diff(before: Serialized, after: Serialized): DocumentChange[];
}

interface SerializedNode {
    id: string;
    name?: string;
    parentId?: string;
    [key: string]: unknown;
}

function nodesOf(data: Serialized): SerializedNode[] {
    const nodes = (data["models"] as { nodes?: unknown } | undefined)?.nodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.filter(
        (node): node is SerializedNode =>
            typeof node === "object" && node !== null && typeof (node as SerializedNode).id === "string",
    );
}

/** Everything but the name, for "was it changed otherwise". Key order doesn't matter. */
function contentOf({ name: _name, ...rest }: SerializedNode): string {
    return JSON.stringify(rest, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
    );
}

/**
 * The placeholder differ until the merge engine's semantic diff (CLOUD-12) replaces it: compares
 * the model tree node by node (by id) and reports nodes added, removed, renamed, or otherwise
 * changed — not which parameter changed ("Extrude 3: distance 10 → 15 mm" is CLOUD-12's).
 * The root node (the document itself) is skipped.
 */
export class NodeListDiffer implements IDocumentDiffer {
    diff(before: Serialized, after: Serialized): DocumentChange[] {
        const old = new Map(
            nodesOf(before)
                .filter((x) => x.parentId !== undefined)
                .map((x) => [x.id, x]),
        );
        const changes: DocumentChange[] = [];
        const seen = new Set<string>();
        for (const node of nodesOf(after)) {
            if (node.parentId === undefined) continue;
            seen.add(node.id);
            const name = node.name ?? String(node[InternalClassName] ?? node.id);
            const previous = old.get(node.id);
            if (!previous) {
                changes.push({ kind: "added", target: node.id, message: "diff.added{0}", args: [name] });
            } else if ((previous.name ?? "") !== (node.name ?? "")) {
                changes.push({
                    kind: "renamed",
                    target: node.id,
                    message: "diff.renamed{0}{1}",
                    args: [previous.name ?? "", name],
                });
            } else if (contentOf(previous) !== contentOf(node)) {
                changes.push({
                    kind: "modified",
                    target: node.id,
                    message: "diff.modified{0}",
                    args: [name],
                });
            }
        }
        for (const [id, node] of old) {
            if (seen.has(id)) continue;
            const name = node.name ?? String(node[InternalClassName] ?? id);
            changes.push({ kind: "removed", target: id, message: "diff.removed{0}", args: [name] });
        }
        return changes;
    }
}

/** The differ "Compare" uses: {@link NodeListDiffer} until CLOUD-12 registers the semantic one. */
export class DocumentDiffers {
    private static differ: IDocumentDiffer = new NodeListDiffer();

    static get current(): IDocumentDiffer {
        return DocumentDiffers.differ;
    }

    /** Replaces the differ; returns a function that puts the previous one back. */
    static register(differ: IDocumentDiffer): () => void {
        const previous = DocumentDiffers.differ;
        DocumentDiffers.differ = differ;
        return () => {
            if (DocumentDiffers.differ === differ) DocumentDiffers.differ = previous;
        };
    }
}

/**
 * The changes from `before` to `after` (serialized documents of any supported format: both are
 * migrated first, never modified), by the registered differ. A document that can't be migrated
 * (a newer format, not a Spicy3D document) is the error.
 */
export function diffDocuments(
    before: Serialized,
    after: Serialized,
    differ: IDocumentDiffer = DocumentDiffers.current,
): Result<DocumentChange[], DocumentFormatError> {
    const from = DocumentMigrations.migrate(before);
    if (!from.isOk) return Result.err(from.error);
    const to = DocumentMigrations.migrate(after);
    if (!to.isOk) return Result.err(to.error);
    return Result.ok(differ.diff(from.value, to.value));
}
