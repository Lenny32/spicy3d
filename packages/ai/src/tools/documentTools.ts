// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Tool } from "../llm/types";
import { parseDocumentName, renameDocument, renameRefusal, requireDocument } from "./documentContext";

async function renameDocumentHandler(args: Record<string, unknown>): Promise<string> {
    const doc = requireDocument();
    if (typeof doc === "string") return doc;
    const parsed = parseDocumentName(args["name"]);
    if ("error" in parsed) return JSON.stringify(parsed);
    const refusal = renameRefusal(doc);
    if (refusal !== undefined) return JSON.stringify({ error: refusal });
    const previous = doc.name;
    renameDocument(doc, parsed.name);
    return JSON.stringify({
        renamed: true,
        previous,
        name: doc.name,
        note: "One undo step. The name is stored by the next save (autosave, or spicy3d_save for a cloud document).",
    });
}

export function buildDocumentTools(): Tool[] {
    return [
        {
            name: "rename_document",
            description:
                "Rename the active document — the name in the title bar, the home page and the cloud library. The document root (get_document_state's rootId, the parentId of every top-level node) carries the same name, so this is also how the root component is renamed. One undo step; stored by the next save.",
            parameters: {
                type: "object",
                properties: { name: { type: "string", description: "New document name" } },
                required: ["name"],
            },
            handler: renameDocumentHandler,
        },
    ];
}
