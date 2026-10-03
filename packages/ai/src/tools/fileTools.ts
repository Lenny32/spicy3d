// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    awaitExportRebuilds,
    type DataExportError,
    type DataExportOptions,
    DocumentRebuilds,
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
import type { Tool, ToolCallContext } from "../llm/types";
import { MAX_CHUNK_EXPORT_BYTES, retainExport } from "./exportChunks";
import { imageByteBudget } from "./imageEncoding";

const DEFAULT_EXPORT_BYTES = 1024 * 1024;
/**
 * How long an export waits for pending rebuilds. Tool calls run one at a time, so an unbounded
 * wait blocks every later call; this leaves the writer time within the relay's 120 s answer limit.
 */
export const EXPORT_REBUILD_WAIT_MS = 60_000;
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

interface RebuildWait {
    /** Aborted by the call's signal or once the budget is spent. */
    readonly signal: AbortSignal;
    /** The caller went away: no retry advice is owed. */
    readonly cancelled: () => boolean;
    dispose(): void;
}

/**
 * The budget counts from `receivedAt`: time spent behind earlier calls in the page's tool queue
 * shares the relay's deadline. The timer cannot fire during a synchronous kernel step, so the
 * wait can run over by the length of one such step.
 */
function rebuildWait(signal?: AbortSignal, receivedAt?: number): RebuildWait {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const queued = receivedAt === undefined ? 0 : performance.now() - receivedAt;
    const timer = setTimeout(abort, Math.max(0, EXPORT_REBUILD_WAIT_MS - queued));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        cancelled: () => signal?.aborted === true,
        dispose: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
    };
}

type ExportOutcome = { data: BlobPart[]; skipped: readonly string[] } | { error: DataExportError };

async function exportNodes(
    app: IApplication,
    format: string,
    nodes: VisualNode[],
    options: DataExportOptions,
): Promise<ExportOutcome> {
    if (app.dataExchange.exportResult) {
        const result = await app.dataExchange.exportResult(format, nodes, options);
        return result.isOk ? result.value : { error: result.error };
    }
    const data = await app.dataExchange.export(format, nodes, options);
    return data ? { data, skipped: [] } : { error: { kind: "failed", message: "no file was produced" } };
}

function exportErrorMessage(error: DataExportError, wait: RebuildWait): string {
    if (error.kind === "rebuild-pending")
        return wait.cancelled()
            ? `Export cancelled while the model was rebuilding (${error.message})`
            : `Rebuild in progress, nothing was exported (${error.message}); retry export_nodes once get_rebuild_status reports pending 0`;
    if (error.kind === "no-geometry")
        return `Export failed: ${error.message}; check the nodes' rebuild errors`;
    return `Export failed: ${error.message}`;
}

function exportError(
    document: IDocument,
    error: DataExportError,
    wait: RebuildWait,
): Record<string, unknown> {
    const message = exportErrorMessage(error, wait);
    if (error.kind === "rebuild-pending")
        return { error: message, rebuild: DocumentRebuilds.status(document) };
    if (error.kind === "no-geometry") return { error: message, nodes: error.nodes };
    return { error: message };
}

async function handleExportNodes(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolCallContext,
): Promise<string> {
    const app = globalThis.app;
    const doc = getDocument();
    if (!doc) return JSON.stringify({ error: I18n.translate("ai.error.noDocument") });

    const delivery = args["delivery"] === undefined ? "download" : args["delivery"];
    if (delivery !== "download" && delivery !== "base64" && delivery !== "chunks")
        return JSON.stringify({ error: 'delivery must be "download", "base64" or "chunks"' });
    const byteLimit = delivery === "chunks" ? MAX_CHUNK_EXPORT_BYTES : MAX_EXPORT_BYTES;
    const maxBytes =
        args["maxBytes"] === undefined
            ? delivery === "chunks"
                ? byteLimit
                : DEFAULT_EXPORT_BYTES
            : args["maxBytes"];
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > byteLimit)
        return JSON.stringify({ error: `maxBytes must be an integer from 1 to ${byteLimit}` });
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
    let options: DataExportOptions = {};
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
    if (mode === "separate")
        return handleSeparateExport(
            app,
            doc,
            args,
            format,
            delivery,
            maxBytes,
            options,
            rebuildWait(signal, context?.receivedAt),
            context?.caller,
        );

    const nodes = resolveNodes(doc, args["ids"]);
    if (typeof nodes === "string") return JSON.stringify({ error: nodes });
    const visuals = nodes.filter((n): n is VisualNode => n instanceof VisualNode);
    if (visuals.length === 0) return JSON.stringify({ error: "no exportable nodes" });

    const wait = rebuildWait(signal, context?.receivedAt);
    let outcome: ExportOutcome;
    try {
        outcome = await exportNodes(app, format, visuals, { ...options, signal: wait.signal });
    } finally {
        wait.dispose();
    }
    if ("error" in outcome) return JSON.stringify(exportError(doc, outcome.error, wait));

    const filename = resolveFilename(visuals, format, args["filename"]);
    const skipped = [...outcome.skipped];
    return deliverExport(
        outcome.data,
        {
            filename,
            mimeType: exportMimeType(format),
            nodes: visuals.map((node) => node.id).filter((id) => !skipped.includes(id)),
            ...(skipped.length > 0 && {
                skipped,
                warning:
                    "Nodes without geometry after their rebuild were left out; check their rebuild errors",
            }),
        },
        delivery,
        maxBytes,
        context?.caller,
    );
}

interface ExportMetadata {
    filename: string;
    mimeType: string;
    nodes: string[];
    outputs?: BatchExportOutput[];
    skipped?: string[];
    warning?: string;
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
    delivery: "download" | "base64" | "chunks",
    maxBytes: number,
    caller?: string,
): Promise<string> {
    const blob = new Blob(data);
    const metadata = {
        ok: true,
        ...details,
        bytes: blob.size,
    };
    if (delivery === "chunks") return retainExport(blob, metadata, maxBytes, caller);
    if (delivery === "base64") {
        if (blob.size > maxBytes) {
            return JSON.stringify({
                error: "Export exceeds maxBytes; increase the limit or use chunks/browser download",
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
                error: "Export exceeds the relay response limit; use chunks, browser download or export less geometry",
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
    delivery: "download" | "base64" | "chunks",
    maxBytes: number,
    options: DataExportOptions,
    wait: RebuildWait,
    caller?: string,
): Promise<string> {
    try {
        return await exportSeparately(app, document, args, format, delivery, maxBytes, options, wait, caller);
    } finally {
        wait.dispose();
    }
}

async function exportSeparately(
    app: IApplication,
    document: IDocument,
    args: Record<string, unknown>,
    format: string,
    delivery: "download" | "base64" | "chunks",
    maxBytes: number,
    options: DataExportOptions,
    wait: RebuildWait,
    caller?: string,
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
    if (requested.length > 256)
        return JSON.stringify({ error: "Separate export supports at most 256 node ids" });
    if (requested.length === 0) return JSON.stringify({ error: "no exportable nodes" });
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const outputs: BatchExportOutput[] = [];
    const names = new Set<string>();
    const exported: string[] = [];
    let accumulatedBytes = 0;
    // Rebuild every requested node up front: a body evaluated only at its turn would find the
    // budget spent by earlier writers and throw the finished outputs away.
    const visuals = requested
        .map((id) => document.modelManager.findNodes((candidate) => candidate.id === id)[0])
        .filter((node): node is VisualNode => node instanceof VisualNode);
    const rebuilt = await awaitExportRebuilds(visuals, wait.signal);
    if (!rebuilt.isOk) return JSON.stringify(exportError(document, rebuilt.error, wait));
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
            const outcome = await exportNodes(app, format, [node], { ...options, signal: wait.signal });
            if ("error" in outcome) {
                // A rebuild started after the batch wait: stop instead of exporting stale geometry.
                if (outcome.error.kind === "rebuild-pending")
                    return JSON.stringify({ ...exportError(document, outcome.error, wait), outputs });
                output.error = exportErrorMessage(outcome.error, wait);
                continue;
            }
            const blob = new Blob(outcome.data);
            accumulatedBytes += blob.size;
            if (accumulatedBytes > maxBytes) {
                return JSON.stringify({
                    error: "Separate export exceeds maxBytes before archiving",
                    bytes: accumulatedBytes,
                    maxBytes,
                    outputs,
                });
            }
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
        caller,
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
                "Export nodes to one CAD/mesh file. Default delivery downloads in the browser; chunks returns only metadata and an exportId for read_export_chunk (client scripts decode ranges directly to disk, outside model context). Temporary exports last 10 minutes, belong to the calling session and allow up to 32 MiB. base64 returns inline bytes with filename/MIME metadata. Inline base64 defaults to a 1 MiB limit (max 8 MiB), also bounded by the relay response limit. filename is a basename; this browser tool cannot write an agent's filesystem path. format is an app export format ('.step', '.iges', '.brep', '.stl', '.stl binary', '.ply', '.ply binary', '.obj'). Omit ids for all top-level nodes. Waits about 60 s from the request (queue time included; a long synchronous kernel step can extend it) for pending parametric rebuilds; a model still rebuilding returns a 'Rebuild in progress' error: retry once get_rebuild_status reports pending 0. Merged exports list nodes left out for lack of geometry in skipped.",
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
                        enum: ["download", "base64", "chunks"],
                        description:
                            "Browser download (default), inline base64, or metadata with chunk retrieval",
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
                        maximum: MAX_CHUNK_EXPORT_BYTES,
                        description:
                            "Decoded-byte limit: base64 defaults to 1 MiB (max 8 MiB); chunks defaults to 32 MiB (max 32 MiB). Also bounds separate outputs before archiving; relay limits apply to responses",
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
