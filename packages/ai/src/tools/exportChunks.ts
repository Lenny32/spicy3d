// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { sha256Hex } from "@spicy3d/core";
import type { Tool } from "../llm/types";
import { imageByteBudget } from "./imageEncoding";

export const MAX_CHUNK_EXPORT_BYTES = 32 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CALLER_CACHE_BYTES = 32 * 1024 * 1024;
const LIFETIME_MS = 10 * 60 * 1000;
const CHUNK_BYTES = 48 * 1024;

const retained = new Map<string, { blob: Blob; caller?: string; expiresAt: number }>();

function prune(): number {
    let bytes = 0;
    for (const [id, entry] of retained) {
        if (entry.expiresAt <= Date.now()) retained.delete(id);
        else bytes += entry.blob.size;
    }
    return bytes;
}

function cacheFull(size: number, caller?: string): boolean {
    const total = prune();
    let ownBytes = 0;
    for (const entry of retained.values()) {
        if (entry.caller === caller) ownBytes += entry.blob.size;
    }
    return total + size > CACHE_BYTES || ownBytes + size > CALLER_CACHE_BYTES;
}

function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 4096)
        binary += String.fromCharCode(...bytes.subarray(index, index + 4096));
    return btoa(binary);
}

export function forgetExports(caller: string): void {
    for (const [id, entry] of retained) {
        if (entry.caller === caller) retained.delete(id);
    }
}

function responseSize(text: string): number {
    return new TextEncoder().encode(JSON.stringify({ content: [{ type: "text", text }] })).byteLength;
}

export async function retainExport(
    blob: Blob,
    metadata: { filename: string; mimeType: string; bytes: number },
    maxBytes: number,
    caller?: string,
): Promise<string> {
    if (blob.size > maxBytes)
        return JSON.stringify({ error: "Export exceeds maxBytes", bytes: blob.size, maxBytes });
    if (cacheFull(blob.size, caller))
        return JSON.stringify({
            error: "Temporary export cache is full; release an export or wait for expiry",
        });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let triangles: number | undefined;
    if (metadata.mimeType === "model/stl") {
        const count = bytes.length >= 84 ? new DataView(bytes.buffer).getUint32(80, true) : undefined;
        triangles =
            count !== undefined &&
            new TextDecoder().decode(bytes.subarray(0, 5)).toLowerCase() !== "solid" &&
            84 + count * 50 === bytes.length
                ? count
                : (new TextDecoder().decode(bytes).match(/\bfacet\s+normal\b/g) ?? []).length;
    }
    const exportId = crypto.randomUUID();
    const expiresAt = Date.now() + LIFETIME_MS;
    const result = JSON.stringify({
        ...metadata,
        delivery: "chunks",
        exportId,
        sha256: await sha256Hex(bytes),
        triangles,
        expiresInSeconds: LIFETIME_MS / 1000,
        chunkBytes: CHUNK_BYTES,
    });
    const budget = imageByteBudget();
    if (budget !== undefined && responseSize(result) > budget)
        return JSON.stringify({ error: "Export metadata exceeds the relay response limit" });
    // Recheck after hashing: other callers may have retained exports in the meantime.
    if (cacheFull(blob.size, caller))
        return JSON.stringify({
            error: "Temporary export cache is full; release an export or wait for expiry",
        });
    retained.set(exportId, { blob, caller, expiresAt });
    return result;
}

export function buildExportChunkTool(): Tool {
    return {
        name: "read_export_chunk",
        description:
            "Read exact bytes from export_nodes delivery=chunks. Use a client script to decode base64 straight to disk; do not put chunks into model context. Offset/length are decoded bytes. Responses may be shorter to fit relay limits: advance by returned bytes until eof, verify sha256 from export metadata. release=true deletes the temporary export without returning bytes. Exports expire after 10 minutes without a successful read and belong to the calling session.",
        parameters: {
            type: "object",
            properties: {
                exportId: { type: "string" },
                offset: { type: "integer", minimum: 0, default: 0 },
                length: { type: "integer", minimum: 1, maximum: CHUNK_BYTES, default: CHUNK_BYTES },
                release: { type: "boolean", default: false },
            },
            required: ["exportId"],
        },
        handler: async (args, _signal, context) => {
            prune();
            const id = args["exportId"];
            const entry = typeof id === "string" ? retained.get(id) : undefined;
            if (!entry || entry.caller !== context?.caller)
                return JSON.stringify({ error: "Export not found or expired; export again in this session" });
            const offset = args["offset"] === undefined ? 0 : args["offset"];
            const length = args["length"] === undefined ? CHUNK_BYTES : args["length"];
            if (args["release"] !== undefined && typeof args["release"] !== "boolean")
                return JSON.stringify({ error: "release must be a boolean" });
            if (args["release"] === true) {
                retained.delete(id as string);
                return JSON.stringify({ ok: true, released: true });
            }
            if (
                typeof offset !== "number" ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                offset > entry.blob.size
            )
                return JSON.stringify({ error: "offset must be an integer within the exported file" });
            if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > CHUNK_BYTES)
                return JSON.stringify({ error: `length must be an integer from 1 to ${CHUNK_BYTES}` });
            let size = Math.min(length, entry.blob.size - offset);
            const budget = imageByteBudget();
            // Encode only a bounded slice, then include JSON text escaping in the relay check.
            while (true) {
                const bytes = new Uint8Array(await entry.blob.slice(offset, offset + size).arrayBuffer());
                const result = JSON.stringify({
                    exportId: id,
                    offset,
                    bytes: size,
                    eof: offset + size === entry.blob.size,
                    encoding: "base64",
                    data: base64(bytes),
                });
                if (budget === undefined || responseSize(result) <= budget) {
                    entry.expiresAt = Date.now() + LIFETIME_MS;
                    return result;
                }
                if (size <= 1)
                    return JSON.stringify({ error: "Export chunk cannot fit the relay response limit" });
                size = Math.floor(size / 2);
            }
        },
    };
}
