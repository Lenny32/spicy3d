// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, INode } from "@spicy3d/core";
import type { Tool } from "../llm/types";
import { getDocument } from "./documentContext";
import { kernelStateInfo } from "./kernelTools";

const metadataTools = new WeakSet<Tool>();
/** Only actual metadata built-ins, never plugin tools or caller-provided name/flags. */
export function isMetadataReadTool(tool: Tool): boolean {
    return metadataTools.has(tool);
}

const committed = new WeakMap<
    IDocument,
    { summary: ReturnType<typeof documentSummary>; selected: ReturnType<typeof summarizeNode>[] }
>();

export function hasDocumentReadSnapshot(): boolean {
    const doc = getDocument();
    return doc !== undefined && committed.has(doc);
}

/** Metadata-only snapshot; holds no geometry wrappers and is released after commit/rollback. */
export function holdDocumentReadSnapshot(doc: IDocument): () => void {
    if (committed.has(doc)) throw new Error("A modeling program is already running");
    committed.set(doc, {
        summary: documentSummary(doc),
        selected: doc.selection.getSelectedNodes().map(summarizeNode),
    });
    return () => committed.delete(doc);
}

function summarizeNode(node: INode) {
    // parentId is what makes the tree legible: a FolderNode's children share its id, and a
    // node moved by create_folder/move_nodes stays present here with its parent changed.
    return { id: node.id, type: node.constructor.name, name: node.name, parentId: node.parent?.id };
}

/** Once the geometry kernel crashed: `kernel: "crashed"` and the error every kernel tool returns. */
function documentSummary(doc: IDocument) {
    const nodes = doc.modelManager.findNodes(() => true).map(summarizeNode);
    // The root is not among the nodes, yet it is the parentId of every top-level one: named
    // here so that id resolves (get/set_node_properties take it; its name is the document's).
    const rootId = (doc.modelManager.rootNode as INode | undefined)?.id;
    return {
        hasActiveDocument: true,
        name: doc.name,
        ...(rootId !== undefined ? { rootId } : {}),
        nodeCount: nodes.length,
        nodes,
        ...kernelStateInfo(),
    };
}

async function readDocumentState(): Promise<string> {
    const doc = getDocument();
    if (!doc) return JSON.stringify({ hasActiveDocument: false, ...kernelStateInfo() });
    return JSON.stringify(committed.get(doc)?.summary ?? documentSummary(doc));
}

async function readSelection(): Promise<string> {
    const doc = getDocument();
    if (!doc) return JSON.stringify({ hasActiveDocument: false });
    const selected = committed.get(doc)?.selected ?? doc.selection.getSelectedNodes().map(summarizeNode);
    return JSON.stringify({ hasActiveDocument: true, selected });
}

/**
 * Compact JSON snapshot of the document and its selection, injected into the system prompt
 * at run start so the model can skip the first get_document_state / get_selection calls.
 */
export function documentSnapshot(): string {
    const doc = getDocument();
    if (!doc) return JSON.stringify({ hasActiveDocument: false, ...kernelStateInfo() });
    const selected = committed.get(doc)?.selected ?? doc.selection.getSelectedNodes().map(summarizeNode);
    return JSON.stringify({ ...(committed.get(doc)?.summary ?? documentSummary(doc)), selected });
}

export function buildReadTools(): Tool[] {
    const tools: Tool[] = [
        {
            name: "get_document_state",
            description:
                "Read the current document: whether there is an active document, its name, rootId, node count, and each node's id/type/name/parentId. Nodes of type FolderNode are the groups; a node's parentId is the folder holding it, and top-level nodes have rootId, the document root (its name is the document's name: rename_document changes it). A kernel field (crashed, with kernelError) means the geometry kernel is gone: modeling tools fail until recover_kernel succeeds or the user reloads the page. Successful recovery preserves committed edits but clears undo/redo.",
            parameters: { type: "object", properties: {} },
            handler: readDocumentState,
        },
        {
            name: "get_selection",
            description: "Read the currently selected nodes.",
            parameters: { type: "object", properties: {} },
            handler: readSelection,
        },
    ];
    for (const tool of tools) metadataTools.add(tool);
    return tools;
}
