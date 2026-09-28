// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DOCUMENT_FILE_EXTENSION } from "./document";
import { decodeCloudVersionEnvelope, isCloudVersionEnvelope } from "./documentManifest";
import { Result } from "./foundation";
import { PerformanceTrace } from "./performanceTrace";
import type { Serialized } from "./serialize";

/** Extensions of documents saved before `.spicy` files: plain (uncompressed) JSON. */
export const LEGACY_DOCUMENT_FILE_EXTENSIONS = [".cd"] as const;

/** MIME type of a `.spicy` file: the gzipped JSON of the serialized document. */
export const DOCUMENT_FILE_MIME_TYPE = "application/x-spicy3d";

const GZIP_MAGIC = [0x1f, 0x8b];

export type DocumentFileError = { kind: "unreadable"; message: string };

/**
 * Encodes a serialized document as a `.spicy` file. The document carries its own
 * `formatVersion`, so reading it back goes through the usual migrations.
 */
export async function encodeDocumentFile(data: Serialized): Promise<Blob> {
    const json = new Blob([JSON.stringify(data)], { type: "application/json" });
    const gzipped = json.stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = await new Response(gzipped).arrayBuffer();
    return new Blob([bytes], { type: DOCUMENT_FILE_MIME_TYPE });
}

/**
 * Decodes a `.spicy` file. Plain JSON (a legacy `.cd` file) is accepted too; the format is
 * told apart by the gzip magic bytes, not by the file name. A `.spicy` file of the server's data
 * export (one cloud version: manifest and base64 blobs, SpicySrv#17) is reassembled into its document.
 */
export async function decodeDocumentFile(file: Blob): Promise<Result<Serialized, DocumentFileError>> {
    const span = PerformanceTrace.enabled ? PerformanceTrace.begin("document.decode") : undefined;
    try {
        const head = new Uint8Array(await file.slice(0, GZIP_MAGIC.length).arrayBuffer());
        const isGzip = GZIP_MAGIC.every((byte, i) => head[i] === byte);
        const decompress = PerformanceTrace.enabled
            ? PerformanceTrace.begin("document.decompress", { gzip: isGzip })
            : undefined;
        let text: string;
        try {
            text = isGzip
                ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()
                : await file.text();
        } finally {
            if (PerformanceTrace.enabled) PerformanceTrace.end(decompress);
        }
        const parse = PerformanceTrace.enabled ? PerformanceTrace.begin("document.parse") : undefined;
        let data: unknown;
        try {
            data = JSON.parse(text);
        } finally {
            if (PerformanceTrace.enabled) PerformanceTrace.end(parse);
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            return Result.err({ kind: "unreadable", message: "not a JSON object" });
        }
        if (isCloudVersionEnvelope(data)) {
            const document = decodeCloudVersionEnvelope(data);
            return document.isOk
                ? Result.ok(document.value)
                : Result.err({ kind: "unreadable", message: JSON.stringify(document.error) });
        }
        return Result.ok(data as Serialized);
    } catch (error) {
        return Result.err({ kind: "unreadable", message: (error as Error).message });
    } finally {
        if (PerformanceTrace.enabled) PerformanceTrace.end(span);
    }
}

/** Whether `fileName` names a document file (`.spicy`, or a legacy extension). */
export function isDocumentFileName(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return (
        lower.endsWith(DOCUMENT_FILE_EXTENSION) ||
        LEGACY_DOCUMENT_FILE_EXTENSIONS.some((x) => lower.endsWith(x))
    );
}
