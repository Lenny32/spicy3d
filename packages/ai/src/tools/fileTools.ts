// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DataExportOptions,
    download,
    I18n,
    type IApplication,
    type IDocument,
    type INode,
    isLengthUnit,
    Matrix4,
    Transaction,
    VisualNode,
    validateStlTessellation,
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
    const custom = args["linearTolerance"] !== undefined || args["angularTolerance"] !== undefined;
    let options: DataExportOptions | undefined;
    if (custom) {
        if (format !== ".stl" && format !== ".stl binary")
            return JSON.stringify({ error: "Tessellation tolerances apply only to STL exports" });
        options = {
            stl: {
                linearTolerance: args["linearTolerance"] as number | undefined,
                angularTolerance: args["angularTolerance"] as number | undefined,
            },
        };
        const error = validateStlTessellation(options.stl);
        if (error) return JSON.stringify({ error });
    }

    const mode = args["mode"] === undefined ? "merged" : args["mode"];
    if (mode !== "merged" && mode !== "separate")
        return JSON.stringify({ error: 'mode must be "merged" or "separate"' });
    if (mode === "separate") return handleSeparateExport(app, doc, args, format, delivery, maxBytes, options);

    const nodes = resolveNodes(doc, args["ids"]);
    if (typeof nodes === "string") return JSON.stringify({ error: nodes });
    const visuals = nodes.filter((n): n is VisualNode => n instanceof VisualNode);
    if (visuals.length === 0) return JSON.stringify({ error: "no exportable nodes" });

    const data = options
        ? await app.dataExchange.export(format, visuals, options)
        : await app.dataExchange.export(format, visuals);
    if (!data) {
        return JSON.stringify({ error: "export failed: no exportable geometry for this format" });
    }

    const filename = resolveFilename(visuals, format, args["filename"]);
    return deliverExport(
        data,
        {
            filename,
            mimeType: exportMimeType(format),
            nodes: visuals.map((node) => node.id),
        },
        delivery,
        maxBytes,
    );
}

interface ExportMetadata {
    filename: string;
    mimeType: string;
    nodes: string[];
    outputs?: BatchExportOutput[];
}

interface BatchExportOutput {
    id: string;
    filename?: string;
    mimeType: string;
    bytes?: number;
    error?: string;
}

async function deliverExport(
    data: BlobPart[],
    details: ExportMetadata,
    delivery: "download" | "base64",
    maxBytes: number,
): Promise<string> {
    const blob = new Blob(data);
    const metadata = {
        ok: true,
        ...details,
        bytes: blob.size,
    };
    if (delivery === "base64") {
        if (blob.size > maxBytes) {
            return JSON.stringify({
                error: "Export exceeds maxBytes; increase the limit or use browser download",
                bytes: blob.size,
                maxBytes,
                filename: details.filename,
                mimeType: metadata.mimeType,
                outputs: details.outputs,
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
                filename: details.filename,
                bytes: blob.size,
                responseBytes,
                responseByteLimit: budget,
                outputs: details.outputs,
            });
        }
        return result;
    }
    download(data, details.filename);
    return JSON.stringify(metadata);
}

async function handleSeparateExport(
    app: IApplication,
    document: IDocument,
    args: Record<string, unknown>,
    format: string,
    delivery: "download" | "base64",
    maxBytes: number,
    options?: DataExportOptions,
): Promise<string> {
    const ids = args["ids"];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")))
        return JSON.stringify({ error: "ids must be an array of node ids" });
    const requested =
        ids === undefined
            ? document.modelManager
                  .findNodes((node) => node.parent === document.modelManager.rootNode)
                  .map((node) => node.id)
            : (ids as string[]);
    if (requested.length === 0) return JSON.stringify({ error: "no exportable nodes" });
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const outputs: BatchExportOutput[] = [];
    const names = new Set<string>();
    const exported: string[] = [];
    for (const id of requested) {
        const node = document.modelManager.findNodes((candidate) => candidate.id === id)[0];
        const output: BatchExportOutput = { id, mimeType: exportMimeType(format) };
        outputs.push(output);
        if (!node || !(node instanceof VisualNode)) {
            output.error = node ? "Node has no exportable visual geometry" : "Node not found";
            continue;
        }
        const safeName =
            Array.from(node.name)
                .map((character) =>
                    character === "/" || character === "\\" || character.charCodeAt(0) < 32 ? "_" : character,
                )
                .join("") || "model";
        const suffix = format.replace(" binary", "");
        const base = safeName.toLowerCase().endsWith(suffix) ? safeName.slice(0, -suffix.length) : safeName;
        let filename = `${base}${suffix}`;
        let counter = 2;
        while (names.has(filename.toLowerCase())) filename = `${base} (${counter++})${suffix}`;
        output.filename = filename;
        try {
            const data = options
                ? await app.dataExchange.export(format, [node], options)
                : await app.dataExchange.export(format, [node]);
            if (!data) {
                output.error = "Export failed: no exportable geometry for this format";
                continue;
            }
            const blob = new Blob(data);
            zip.file(filename, await blob.arrayBuffer());
            names.add(filename.toLowerCase());
            output.bytes = blob.size;
            exported.push(id);
        } catch {
            output.error = "Export failed";
        }
    }
    if (exported.length === 0) return JSON.stringify({ error: "No batch outputs exported", outputs });
    let filename = (args["filename"] as string | undefined)?.trim() || "models.zip";
    if (!filename.toLowerCase().endsWith(".zip")) filename += ".zip";
    return deliverExport(
        [await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })],
        {
            filename,
            mimeType: "application/zip",
            nodes: exported,
            outputs,
        },
        delivery,
        maxBytes,
    );
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
                    mode: {
                        type: "string",
                        enum: ["merged", "separate"],
                        description:
                            "Merge nodes into one model (default) or export one file per node in one ZIP archive; reports each output/error",
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
                    linearTolerance: {
                        type: "number",
                        exclusiveMinimum: 0,
                        description:
                            "STL only: absolute linear tessellation deflection in millimetres; omit to preserve legacy relative deflection",
                    },
                    angularTolerance: {
                        type: "number",
                        exclusiveMinimum: 0,
                        maximum: 180,
                        description:
                            "STL only: angular tessellation deflection in degrees; omit to preserve the legacy 0.2-radian setting",
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
