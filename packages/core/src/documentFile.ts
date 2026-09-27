// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DOCUMENT_FILE_EXTENSION } from "./document";
import { Result } from "./foundation";
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
 * told apart by the gzip magic bytes, not by the file name.
 */
export async function decodeDocumentFile(file: Blob): Promise<Result<Serialized, DocumentFileError>> {
    try {
        const head = new Uint8Array(await file.slice(0, GZIP_MAGIC.length).arrayBuffer());
        const isGzip = GZIP_MAGIC.every((byte, i) => head[i] === byte);
        const text = isGzip
            ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()
            : await file.text();
        const data: unknown = JSON.parse(text);
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            return Result.err({ kind: "unreadable", message: "not a JSON object" });
        }
        return Result.ok(data as Serialized);
    } catch (error) {
        return Result.err({ kind: "unreadable", message: (error as Error).message });
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
