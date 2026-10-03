// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, type INode, Transaction } from "@spicy3d/core";

/**
 * The active document, or undefined when none is open. `globalThis.app` is a core getter that
 * throws before any Application exists, so the read is guarded — every tool that needs the
 * document starts here.
 */
export function getDocument(): IDocument | undefined {
    try {
        return globalThis.app?.activeView?.document;
    } catch {
        return undefined;
    }
}

export function findNode(doc: IDocument, id: string): INode | undefined {
    return doc.modelManager.findNodes((n) => n.id === id)[0];
}

/**
 * Like {@link findNode}, but also the document root — the component every top-level node's
 * parentId names. Only for tools that may act on the root itself (reading it, renaming it):
 * deleting, moving or transforming it must keep failing.
 */
export function findNodeOrRoot(doc: IDocument, id: string): INode | undefined {
    const root = doc.modelManager.rootNode as INode | undefined;
    return root?.id === id ? root : findNode(doc, id);
}

export function isDocumentRoot(doc: IDocument, node: INode): boolean {
    return node === (doc.modelManager.rootNode as INode | undefined);
}

/** The server keeps document names up to this length. */
export const DOCUMENT_NAME_MAX_LENGTH = 200;

/** A document name as given by the agent: trimmed, 1–200 characters, no control characters. */
export function parseDocumentName(value: unknown): { name: string } | { error: string } {
    if (typeof value !== "string" || value.trim() === "") return { error: "name must be a non-empty string" };
    const name = value.trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "name must not contain control characters" };
    if (name.length > DOCUMENT_NAME_MAX_LENGTH) {
        return { error: `name must be at most ${DOCUMENT_NAME_MAX_LENGTH} characters` };
    }
    return { name };
}

/** Why the document cannot be renamed here, or undefined when it can. */
export function renameRefusal(doc: IDocument): string | undefined {
    if (!doc.repository.isReadOnly?.(doc.id)) return undefined;
    return `"${doc.name}" is read-only in this tab (a preview of an older version, or another tab is editing it), so it cannot be renamed here.`;
}

/**
 * Renames the document the way the project tree does: the root node's name is the document's
 * (ModelManager keeps them in step), so this is one undo step and leaves the document dirty —
 * the next save (autosave, spicy3d_save) stores the new name, in the cloud too.
 */
export function renameDocument(doc: IDocument, name: string): void {
    Transaction.execute(doc, "rename", () => {
        doc.name = name;
    });
}

/** Active document, or the serialized error response when no document is open. */
export function requireDocument(): IDocument | string {
    return getDocument() ?? JSON.stringify({ error: I18n.translate("ai.error.noDocument") });
}

/** Node with the given id, or the serialized error response when it does not exist. */
export function requireNode(doc: IDocument, id: string): INode | string {
    return (
        findNode(doc, id) ??
        JSON.stringify({
            error: `node not found: ${id} — it may have been consumed by an edit-style run_program op (e.g. booleanCut) or deleted; the consumed nodes are listed in run_program's "removed". Call get_document_state for the current node list instead of retrying.`,
        })
    );
}
