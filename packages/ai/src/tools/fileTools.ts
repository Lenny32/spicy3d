// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    download,
    I18n,
    type IApplication,
    type IDocument,
    type INode,
    isLengthUnit,
    Matrix4,
    Transaction,
    VisualNode,
} from "@spicy3d/core";
import type { Tool } from "../llm/types";
import { imageByteBudget } from "./imageEncoding";

const DEFAULT_EXPORT_BYTES = 1024 * 1024;
const MAX_EXPORT_BYTES = 8 * DEFAULT_EXPORT_BYTES;

function exportMimeType(format: string): string {
    switch (format.replace(" binary", "")) {
        case ".step":
            return "model/step";
        case ".iges":
            return "model/iges";
        case ".stl":
            return "model/stl";
        default:
            return "application/octet-stream";
    }
}

function encodeExport(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    }
    return btoa(chunks.join(""));
}

function getDocument(): IDocument | undefined {
    return globalThis.app.activeView?.document;
}

function resolveNodes(doc: IDocument, ids: unknown): INode[] | string {
    if (ids === undefined) {
        return doc.modelManager.findNodes((n) => n.parent === doc.modelManager.rootNode);
    }
    if (!Array.isArray(ids)) return "ids must be an array of node ids";
    const nodes = ids.map((id) => doc.modelManager.findNodes((n) => n.id === String(id))[0]);
    const missing = ids.filter((_, i) => !nodes[i]);
    if (missing.length) return `nodes not found: ${missing.join(", ")}`;
    return nodes;
}

function validateFormat(app: IApplication, format: string): string | undefined {
    const formats = app.dataExchange.exportFormats();
    if (formats.includes(format)) return undefined;
    return `unknown format "${format}", expected one of ${formats.join(", ")}`;
}

function resolveFilename(visuals: VisualNode[], format: string, filename: unknown): string {
    const suffix = format.replace(" binary", "");
    let name = (filename as string | undefined)?.trim() || `${visuals[0].name}${suffix}`;
    if (!name.toLowerCase().endsWith(suffix)) name += suffix;
    return name;
}

async function handleExportNodes(args: Record<string, unknown>): Promise<string> {
    const app = globalThis.app;
    const doc = getDocument();
    if (!doc) return JSON.stringify({ error: I18n.translate("ai.error.noDocument") });

    const delivery = args["delivery"] === undefined ? "download" : args["delivery"];
    if (delivery !== "download" && delivery !== "base64")
        return JSON.stringify({ error: 'delivery must be "download" or "base64"' });
    const maxBytes = args["maxBytes"] === undefined ? DEFAULT_EXPORT_BYTES : args["maxBytes"];
    if (
        typeof maxBytes !== "number" ||
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_EXPORT_BYTES
    )
        return JSON.stringify({ error: `maxBytes must be an integer from 1 to ${MAX_EXPORT_BYTES}` });
    if (
        args["filename"] !== undefined &&
        (typeof args["filename"] !== "string" ||
            /[/\\]/.test(args["filename"]) ||
            Array.from(args["filename"]).some((character) => {
                const code = character.charCodeAt(0);
                return code < 32 || code === 127;
            }))
    )
        return JSON.stringify({ error: "filename must be a file name, not a filesystem path" });

    const format = args["format"] as string;
    const formatError = validateFormat(app, format);
    if (formatError) return JSON.stringify({ error: formatError });

    const nodes = resolveNodes(doc, args["ids"]);
    if (typeof nodes === "string") return JSON.stringify({ error: nodes });
    const visuals = nodes.filter((n): n is VisualNode => n instanceof VisualNode);
    if (visuals.length === 0) return JSON.stringify({ error: "no exportable nodes" });

    const data = await app.dataExchange.export(format, visuals);
    if (!data) {
        return JSON.stringify({ error: "export failed: no exportable geometry for this format" });
    }

    const filename = resolveFilename(visuals, format, args["filename"]);
    const blob = new Blob(data);
    const metadata = {
        ok: true,
        filename,
        mimeType: exportMimeType(format),
        bytes: blob.size,
        nodes: visuals.map((n) => n.id),
    };
    if (delivery === "base64") {
        if (blob.size > maxBytes) {
            return JSON.stringify({
                error: "Export exceeds maxBytes; increase the limit or use browser download",
                bytes: blob.size,
                maxBytes,
                filename,
                mimeType: metadata.mimeType,
            });
        }
        const result = JSON.stringify({
            ...metadata,
            encoding: "base64",
            data: encodeExport(new Uint8Array(await blob.arrayBuffer())),
        });
        const budget = imageByteBudget();
        // The relay budget reserves space for the JSON-RPC envelope. Include text escaping too.
        const responseBytes = new TextEncoder().encode(
            JSON.stringify({ content: [{ type: "text", text: result }] }),
        ).byteLength;
        if (budget !== undefined && responseBytes > budget) {
            return JSON.stringify({
                error: "Export exceeds the relay response limit; use browser download or export less geometry",
                filename,
                bytes: blob.size,
                responseBytes,
                responseByteLimit: budget,
            });
        }
        return result;
    }
    download(data, filename);
    return JSON.stringify(metadata);
}

export function buildReferenceMeshImportTool(): Tool {
    return {
        name: "import_reference_mesh",
        description:
            "Import base64-encoded STL as a lightweight ghost MeshNode without kernel conversion. STL defaults to millimetres. Placement uses millimetres. Move/rotate, visibility and material opacity remain editable with existing node tools. This is display geometry, not a parametric solid. Maximum decoded file size: 32 MiB.",
        parameters: {
            type: "object",
            properties: {
                filename: { type: "string", description: "STL filename" },
                base64: { type: "string", description: "Raw base64 STL bytes (no data URL)" },
                lengthUnit: { type: "string", enum: ["mm", "cm", "m", "in"] },
                translation: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 3,
                    maxItems: 3,
                    description: "Placement [x,y,z] in millimetres",
                },
                opacity: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                    description: "Ghost opacity, default 0.35",
                },
                visible: { type: "boolean" },
            },
            required: ["filename", "base64"],
        },
        handler: handleImportReferenceMesh,
    };
}

export function buildFileTools(): Tool[] {
    return [
        {
            name: "export_nodes",
            description:
                "Export nodes to one CAD/mesh file. Default delivery downloads in the browser; base64 returns exact bytes with filename/MIME metadata. Returned bytes default to a 1 MiB limit (max 8 MiB), also bounded by the relay response limit. filename is a basename; this browser tool cannot write an agent's filesystem path. format is an app export format ('.step', '.iges', '.brep', '.stl', '.stl binary', '.ply', '.ply binary', '.obj'). Omit ids for all top-level nodes.",
            parameters: {
                type: "object",
                properties: {
                    ids: {
                        type: "array",
                        items: { type: "string" },
                        description: "Node ids to export; omit to export all top-level nodes",
                    },
                    format: { type: "string", description: "Export format, e.g. '.step'" },
                    delivery: {
                        type: "string",
                        enum: ["download", "base64"],
                        description: "Browser download (default) or returned base64 bytes",
                    },
                    maxBytes: {
                        type: "integer",
                        minimum: 1,
                        maximum: MAX_EXPORT_BYTES,
                        default: DEFAULT_EXPORT_BYTES,
                        description: "Maximum decoded bytes for base64 delivery; relay limits also apply",
                    },
                    filename: {
                        type: "string",
                        description: "Optional file name; the format extension is appended when missing",
                    },
                },
                required: ["format"],
            },
            handler: handleExportNodes,
        },
    ];
}

async function handleImportReferenceMesh(args: Record<string, unknown>): Promise<string> {
    const app = globalThis.app;
    const document = getDocument();
    const fail = (error: string) => JSON.stringify({ error });
    if (!document) return fail(I18n.translate("ai.error.noDocument"));
    if (document.repository.isReadOnly?.(document.id)) return fail("Document is read-only");
    const importer = app.dataExchange.importReferenceMesh;
    if (!importer) return fail("Reference mesh import is unavailable");
    if (typeof args["filename"] !== "string" || !args["filename"].toLowerCase().endsWith(".stl"))
        return fail("filename must end with .stl");
    const encoded = args["base64"];
    const maxBytes = 32 * 1024 * 1024;
    if (
        typeof encoded !== "string" ||
        encoded.length === 0 ||
        encoded.length % 4 !== 0 ||
        encoded.length > Math.ceil(maxBytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
        return fail("Expected raw base64 STL, up to 32 MiB");
    if (args["lengthUnit"] !== undefined && !isLengthUnit(args["lengthUnit"]))
        return fail("Invalid lengthUnit");
    if (
        args["opacity"] !== undefined &&
        (typeof args["opacity"] !== "number" ||
            !Number.isFinite(args["opacity"]) ||
            args["opacity"] < 0 ||
            args["opacity"] > 1)
    )
        return fail("Opacity must be 0–1");
    if (args["visible"] !== undefined && typeof args["visible"] !== "boolean")
        return fail("visible must be a boolean");
    const translation = args["translation"] ?? [0, 0, 0];
    if (
        !Array.isArray(translation) ||
        translation.length !== 3 ||
        !translation.every((v) => typeof v === "number" && Number.isFinite(v))
    )
        return fail("translation must be three finite numbers");
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        const decoded = atob(encoded);
        if (decoded.length > maxBytes) return fail("STL exceeds 32 MiB");
        bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
        return fail("Invalid base64");
    }
    const file = new File([bytes], args["filename"], { type: "model/stl" });
    let response = fail("Reference mesh import failed");
    await Transaction.executeAsync(document, "import reference mesh", async () => {
        const result = await importer.call(app.dataExchange, document, file, {
            lengthUnit: args["lengthUnit"] as "mm" | "cm" | "m" | "in" | undefined,
            opacity: args["opacity"] as number | undefined,
            visible: args["visible"] as boolean | undefined,
            transform: Matrix4.fromTranslation(translation[0], translation[1], translation[2]),
        });
        response = result.isOk
            ? JSON.stringify({
                  ok: true,
                  id: result.value.id,
                  name: result.value.name,
                  triangles: (result.value.mesh.position?.length ?? 0) / 9,
                  lengthUnit: args["lengthUnit"] ?? "mm",
              })
            : fail(result.error);
    });
    return response;
}
