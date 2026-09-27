// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "./foundation";
import { InternalClassName, type Serialized } from "./serialize";

// A cloud version is a *manifest* (the serialized document as JSON) plus content-addressed blobs.
// Large opaque values — BREP strings of shapes, mesh buffers, data-URL images — move to blobs, so a
// save whose geometry didn't change uploads only the manifest. The reference replacing a value is
// `{ "$blob": "<sha256>" }` (the server's export format documents that shape), with `$as` telling how
// the bytes read back when the value wasn't a string.

/** The key of a blob reference. */
export const BLOB_REF_KEY = "$blob";
/** Wraps an object of the document that happens to have a `$blob` (or `$literal`) key itself. */
const LITERAL_KEY = "$literal";

/**
 * How a blob's bytes decode: absent = UTF-8 text (the value was a string), `float32`/`uint32` = the
 * little-endian bytes of a `Float32Array`/`Uint32Array`'s `buffer`, `float64` = the little-endian
 * doubles of any other array of numbers (exact: `-0`, `NaN` and `±Infinity` survive, and a
 * `Float16Array` fits). `json` (a JSON array) is only read: early manifests used it.
 */
export type BlobEncoding = "float32" | "uint32" | "float64" | "json";

export interface BlobRef {
    [BLOB_REF_KEY]: string;
    $as?: BlobEncoding;
}

export interface SplitManifestOptions {
    /** Strings of at least this many characters become blobs (default 4096). */
    minStringLength?: number;
    /** Number arrays of at least this many items become blobs (default 1024). */
    minArrayLength?: number;
    /** SHA-256 as lowercase hex; defaults to SubtleCrypto. */
    hash?: (bytes: Uint8Array) => Promise<string>;
}

export interface SplitManifest {
    /** The document with every large value replaced by a {@link BlobRef}. */
    manifest: Serialized;
    /** The blobs by the SHA-256 of their (uncompressed) bytes; identical values share one blob. */
    blobs: Map<string, Uint8Array>;
}

export type ManifestError =
    | { kind: "missingBlob"; sha256: string }
    | { kind: "invalidManifest"; message: string };

const TYPED_ARRAYS: Record<string, "float32" | "uint32"> = {
    Float32Array: "float32",
    Uint32Array: "uint32",
};

const encoder = new TextEncoder();

/** The SHA-256 of `bytes` as lowercase hex (SubtleCrypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((x) => typeof x === "number");
}

export function isBlobRef(value: unknown): value is BlobRef {
    return (
        isRecord(value) &&
        typeof value[BLOB_REF_KEY] === "string" &&
        Object.keys(value).every((k) => k === BLOB_REF_KEY || k === "$as")
    );
}

function encodeNumbers(values: number[], as: BlobEncoding): Uint8Array {
    if (as === "float32") return new Uint8Array(new Float32Array(values).buffer);
    if (as === "uint32") return new Uint8Array(new Uint32Array(values).buffer);
    return new Uint8Array(new Float64Array(values).buffer);
}

/**
 * Replaces the large opaque values of a serialized document by blob references. Pure: `data` is not
 * modified, and the same document always gives the same manifest and hashes.
 */
export async function splitManifest(
    data: Serialized,
    options: SplitManifestOptions = {},
): Promise<SplitManifest> {
    const minString = options.minStringLength ?? 4096;
    const minArray = options.minArrayLength ?? 1024;
    const hash = options.hash ?? sha256Hex;
    const blobs = new Map<string, Uint8Array>();

    const toBlob = async (bytes: Uint8Array, as?: BlobEncoding): Promise<BlobRef> => {
        const sha = await hash(bytes);
        if (!blobs.has(sha)) blobs.set(sha, bytes);
        return as ? { [BLOB_REF_KEY]: sha, $as: as } : { [BLOB_REF_KEY]: sha };
    };

    const visit = async (value: unknown, typedArray?: "float32" | "uint32"): Promise<unknown> => {
        if (typeof value === "string") {
            return value.length >= minString ? toBlob(encoder.encode(value)) : value;
        }
        if (Array.isArray(value)) {
            if (value.length >= minArray && isNumberArray(value)) {
                const as = typedArray ?? "float64";
                return toBlob(encodeNumbers(value, as), as);
            }
            const items: unknown[] = [];
            for (const item of value) items.push(await visit(item));
            return items;
        }
        if (!isRecord(value)) return value;

        const kind = TYPED_ARRAYS[value[InternalClassName] as string];
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = await visit(item, key === "buffer" ? kind : undefined);
        }
        return BLOB_REF_KEY in value || LITERAL_KEY in value ? { [LITERAL_KEY]: result } : result;
    };

    const manifest = (await visit(data)) as Serialized;
    return { manifest, blobs };
}

/** The object a `$literal` wrapper holds (its keys are the document's, never a reference). */
function literalContent(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const inner = value[LITERAL_KEY];
    return Object.keys(value).length === 1 && isRecord(inner) ? inner : undefined;
}

/** The SHA-256 of every blob a manifest references, each once, in order of appearance. */
export function manifestBlobRefs(manifest: unknown): string[] {
    const found = new Set<string>();
    const visit = (value: unknown) => {
        if (isBlobRef(value)) {
            found.add(value[BLOB_REF_KEY]);
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (isRecord(value)) {
            Object.values(literalContent(value) ?? value).forEach(visit);
        }
    };
    visit(manifest);
    return [...found];
}

const decoder = new TextDecoder();

function decodeBlob(bytes: Uint8Array, as: BlobEncoding | undefined): unknown {
    // Copied: a view into a larger buffer may not be aligned for a typed array.
    const buffer = bytes.slice().buffer;
    if (as === "float32") return Array.from(new Float32Array(buffer));
    if (as === "uint32") return Array.from(new Uint32Array(buffer));
    if (as === "float64") return Array.from(new Float64Array(buffer));
    const text = decoder.decode(bytes);
    if (as === "json") {
        // JSON wrote NaN and ±Infinity as null; NaN is the closest reading.
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "number" || x === null)) {
            throw new Error("a json blob is not an array of numbers");
        }
        return parsed.map((x) => (x === null ? Number.NaN : x));
    }
    return text;
}

/** Puts a manifest's blobs back in: the inverse of {@link splitManifest}. */
export function assembleManifest(
    manifest: unknown,
    blob: (sha256: string) => Uint8Array | undefined,
): Result<Serialized, ManifestError> {
    let missing: string | undefined;
    const visit = (value: unknown): unknown => {
        if (isBlobRef(value)) {
            const bytes = blob(value[BLOB_REF_KEY]);
            if (bytes === undefined) {
                missing ??= value[BLOB_REF_KEY];
                return null;
            }
            return decodeBlob(bytes, value.$as);
        }
        if (Array.isArray(value)) return value.map(visit);
        if (!isRecord(value)) return value;
        const source = literalContent(value) ?? value;
        return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, visit(item)]));
    };

    if (!isRecord(manifest)) return Result.err({ kind: "invalidManifest", message: "not a JSON object" });
    try {
        const data = visit(manifest) as Serialized;
        return missing ? Result.err({ kind: "missingBlob", sha256: missing }) : Result.ok(data);
    } catch (error) {
        return Result.err({ kind: "invalidManifest", message: (error as Error).message });
    }
}

// ---- The server's export envelope ----------------------------------------------------------------

/** `type` of a `.spicy` file written by the server's data export (one cloud version). */
export const CLOUD_VERSION_FILE_TYPE = "spicy3d.cloudVersion";

/** Whether parsed JSON is the server's export envelope rather than a serialized document. */
export function isCloudVersionEnvelope(data: unknown): boolean {
    return isRecord(data) && data["type"] === CLOUD_VERSION_FILE_TYPE;
}

function fromBase64(text: string): Uint8Array {
    const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
    if (native) return native(text);
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * The document of a server export envelope (`exportFormat` 1): the manifest blob, reassembled from
 * the base64 blobs next to it. The server's name wins over the manifest's (renames are metadata only).
 */
export function decodeCloudVersionEnvelope(envelope: unknown): Result<Serialized, ManifestError> {
    if (!isRecord(envelope) || !isRecord(envelope["blobs"])) {
        return Result.err({ kind: "invalidManifest", message: "not an export envelope" });
    }
    if (envelope["exportFormat"] !== 1) {
        return Result.err({ kind: "invalidManifest", message: `exportFormat ${envelope["exportFormat"]}` });
    }
    const encoded = envelope["blobs"] as Record<string, unknown>;
    const cache = new Map<string, Uint8Array>();
    const blob = (sha: string) => {
        const text = encoded[sha];
        if (typeof text !== "string") return undefined;
        let bytes = cache.get(sha);
        if (!bytes) {
            bytes = fromBase64(text);
            cache.set(sha, bytes);
        }
        return bytes;
    };

    const manifestSha = envelope["manifestSha256"];
    const manifestBytes = typeof manifestSha === "string" ? blob(manifestSha) : undefined;
    if (!manifestBytes) return Result.err({ kind: "missingBlob", sha256: String(manifestSha) });
    let manifest: unknown;
    try {
        manifest = JSON.parse(decoder.decode(manifestBytes));
    } catch (error) {
        return Result.err({ kind: "invalidManifest", message: (error as Error).message });
    }
    const assembled = assembleManifest(manifest, blob);
    if (!assembled.isOk) return assembled;
    const name = isRecord(envelope["document"]) ? envelope["document"]["name"] : undefined;
    return Result.ok(typeof name === "string" && name ? { ...assembled.value, name } : assembled.value);
}
