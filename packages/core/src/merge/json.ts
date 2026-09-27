// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BLOB_REF_KEY, type BlobEncoding, isBlobRef } from "../documentManifest";
import { sha256HexSync } from "./sha256";

// JSON helpers of the merge engine: structural equality (docs/merge.md, "The three-way rule") that
// also compares a value with a `{ "$blob": sha }` manifest reference by hash, and the timeline
// position markers the engine puts in place of feature counts while it merges.

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent = the key is missing, `undefined` or `null` (the deserializer treats `null` as absent). */
export function isAbsent(value: unknown): value is undefined | null {
    return value === undefined || value === null;
}

/** `START` of a timeline: the position before the first feature. */
export const TIMELINE_START = null;

/**
 * A timeline position while the merge runs (docs/merge.md, "Timeline positions"): the feature it
 * follows on the side it was read from (`anchor`, `null` = the start), plus what is needed to
 * project it back to a number. Two markers are equal when they name the same body and anchor —
 * the raw numbers do not take part (the app does not renumber anchors when features are
 * inserted). `anchor` is `undefined` when the body has no feature list on that side: the raw
 * number is then the value.
 */
export class PositionMarker {
    constructor(
        readonly body: string,
        readonly anchor: string | null | undefined,
        readonly side: "base" | "ours" | "theirs",
        readonly raw: number,
        /** A map entry (`refPositions`) that goes when its body is gone, rather than keeping its number. */
        readonly droppable = false,
    ) {}

    equals(other: PositionMarker): boolean {
        if (this.body !== other.body) return false;
        if (this.anchor === undefined || other.anchor === undefined) {
            return this.anchor === other.anchor && Object.is(this.raw, other.raw);
        }
        return this.anchor === other.anchor;
    }
}

const encoder = new TextEncoder();

function encodeInline(value: unknown, as: BlobEncoding | undefined): Uint8Array | undefined {
    if (as === undefined) return typeof value === "string" ? encoder.encode(value) : undefined;
    if (!Array.isArray(value) || !value.every((x) => typeof x === "number")) return undefined;
    if (as === "float32") return new Uint8Array(new Float32Array(value).buffer);
    if (as === "uint32") return new Uint8Array(new Uint32Array(value).buffer);
    if (as === "float64") return new Uint8Array(new Float64Array(value).buffer);
    return undefined;
}

/**
 * Structural JSON equality: same type; numbers by `Object.is` (no tolerance); strings exactly;
 * arrays element by element; objects by key set and values, key order ignored, absent keys
 * (`undefined` / `null`) equal to missing ones; a blob reference by its hash — against another
 * reference, or against an inline value hashed the way `splitManifest` would have stored it.
 * Hashes of inline values are cached for the lifetime of the instance (one merge).
 */
export class JsonEquality {
    private readonly stringHashes = new Map<string, string>();
    private readonly objectHashes = new WeakMap<object, Map<string, string | undefined>>();

    equals(a: unknown, b: unknown): boolean {
        if (a === b) return typeof a !== "number" || Object.is(a, b);
        if (isAbsent(a) || isAbsent(b)) return isAbsent(a) && isAbsent(b);
        if (a instanceof PositionMarker || b instanceof PositionMarker) {
            return a instanceof PositionMarker && b instanceof PositionMarker && a.equals(b);
        }
        const refA = isBlobRef(a);
        const refB = isBlobRef(b);
        if (refA && refB) return a[BLOB_REF_KEY] === b[BLOB_REF_KEY];
        if (refA) return this.hashOf(b, a.$as) === a[BLOB_REF_KEY];
        if (refB) return this.hashOf(a, b.$as) === b[BLOB_REF_KEY];
        if (typeof a !== typeof b) return false;
        if (typeof a === "number") return Object.is(a, b);
        if (typeof a !== "object") return false;
        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!this.equals(a[i], b[i])) return false;
            return true;
        }
        if (Array.isArray(b)) return false;
        const x = a as Json;
        const y = b as Json;
        let present = 0;
        for (const key in x) {
            if (isAbsent(x[key])) continue;
            present++;
            if (!this.equals(x[key], y[key])) return false;
        }
        for (const key in y) if (!isAbsent(y[key])) present--;
        return present === 0;
    }

    /** Whether the value (deeply) holds a blob reference. */
    static hasBlobRef(value: unknown): boolean {
        if (isBlobRef(value)) return true;
        if (Array.isArray(value)) return value.some(JsonEquality.hasBlobRef);
        if (isRecord(value)) return Object.values(value).some(JsonEquality.hasBlobRef);
        return false;
    }

    private hashOf(value: unknown, as: BlobEncoding | undefined): string | undefined {
        if (typeof value === "string") {
            if (as !== undefined) return undefined;
            let hash = this.stringHashes.get(value);
            if (hash === undefined) {
                hash = sha256HexSync(encoder.encode(value));
                this.stringHashes.set(value, hash);
            }
            return hash;
        }
        if (typeof value !== "object" || value === null) return undefined;
        let perEncoding = this.objectHashes.get(value);
        if (perEncoding === undefined) {
            perEncoding = new Map();
            this.objectHashes.set(value, perEncoding);
        }
        const key = as ?? "text";
        if (!perEncoding.has(key)) {
            const bytes = encodeInline(value, as);
            perEncoding.set(key, bytes === undefined ? undefined : sha256HexSync(bytes));
        }
        return perEncoding.get(key);
    }
}

/**
 * Of two equal values, the one to keep: the inline one when the other is (or holds) a blob
 * reference, so a merge of an assembled document with manifests stays assembled wherever any input
 * had the content.
 */
export function preferInline<T>(first: T, second: unknown): T {
    return JsonEquality.hasBlobRef(first) && !JsonEquality.hasBlobRef(second) ? (second as T) : first;
}

/** Deep-freezes a JSON value (tests: inputs are never mutated). */
export function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}
