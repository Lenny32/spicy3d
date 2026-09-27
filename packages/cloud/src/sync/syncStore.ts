// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, type SaveKind } from "@spicy3d/core";
import { idbRequest, openCloudCacheDb, SYNC_STORE } from "../documents/blobCache";

/** The kinds a pending local save pushes as: `merge` once a merge was applied on top of the base. */
export type PendingKind = Exclude<SaveKind, "restore">;

/** A version as far as the sync needs it: to fetch its manifest, and to tell who saved it. */
export interface SyncVersionRef {
    id: string;
    manifestSha256: string;
    /** Every blob its manifest references (kept in the cache while it is a merge base). */
    blobs: string[];
    deviceName?: string;
    /** Epoch milliseconds. */
    createdAt?: number;
}

/**
 * A save of this device that the server doesn't have yet: its manifest and blobs are in the blob
 * cache (kept there while pending), the record only points at them.
 */
export interface LocalSnapshot {
    manifestSha256: string;
    blobs: string[];
    thumbnailSha256?: string;
    formatVersion: number;
    /** Epoch milliseconds. */
    savedAt: number;
}

/**
 * What this device knows of one cloud document, in IndexedDB (`spicy3d-cloud-cache`, store
 * `sync`), so pending saves survive reloads and the document opens offline. Clean
 * (`localDirty: false`): `base` is the head this device last synced with, cached for offline
 * opening. Dirty: `localSnapshot` is the latest save, not pushed yet; `base` is what it is based
 * on (`If-Match`, and the merge base when the head moved meanwhile, CLOUD-12).
 */
export interface SyncRecord {
    docId: string;
    /** The user the document belongs to; the sync ignores other users' records. */
    ownerId: string;
    name: string;
    /** `undefined`: never pushed, the push creates the document. */
    baseVersion?: SyncVersionRef;
    localSnapshot?: LocalSnapshot;
    localDirty: boolean;
    /** Several pending saves collapse into one push: `manual` wins over `auto`, `merge` over both. */
    pendingKind?: PendingKind;
    pendingLabel?: string;
    /** Saves made since `attempt` was made: the kind (and label) of the push after it. */
    nextKind?: PendingKind;
    nextLabel?: string;
    /** A pending merge's second parent: the version this device's line was based on before the merge. */
    mergeParent?: string;
    /** When the oldest pending save was made (epoch milliseconds). */
    pendingSince?: number;
    /**
     * The push of `localSnapshot` being made, exactly as sent — the server binds an
     * `Idempotency-Key` to every field of the request (SpicySrv `StorageInput.RequestHash`, the
     * tab's `clientId` included), so a retry (also after a reload, from another tab) resends the
     * same fields to be replayed, never refused as `idempotency_key_reused`.
     */
    attempt?: PushAttempt;
    /**
     * Pushes that got no answer (they may have reached the server): when the head moved, a version
     * with one of these manifests saved by that client is this device's own, and the merge base.
     */
    unconfirmed?: { manifestSha256: string; blobs: string[]; clientId?: string }[];
    lastError?: { kind: string; message?: string; at: number };
    /** The tab that made the pending save. */
    clientId: string;
    /** Epoch milliseconds of the last change of the record. */
    updatedAt: number;
}

/** A push as sent, kept so every retry sends the same request (see {@link SyncRecord.attempt}). */
export interface PushAttempt {
    idempotencyKey: string;
    name: string;
    baseVersion?: string;
    mergeParent?: string;
    kind: PendingKind;
    label?: string;
    manifestSha256: string;
    clientId: string;
    deviceName: string;
}

/** The records of the offline sync. A failing store logs and reads as empty. */
export interface ISyncStore {
    get(docId: string): Promise<SyncRecord | undefined>;
    put(record: SyncRecord): Promise<void>;
    /**
     * Writes a clean record unless the stored one has pending changes (another tab's, or saved
     * meanwhile) — atomically. Resolves whether it was written.
     */
    putIfClean(record: SyncRecord): Promise<boolean>;
    delete(docId: string): Promise<void>;
    all(): Promise<SyncRecord[]>;
    clear(): Promise<void>;
}

/** Records are copied in and out, like IndexedDB does. */
export class MemorySyncStore implements ISyncStore {
    readonly records = new Map<string, SyncRecord>();

    async get(docId: string) {
        const record = this.records.get(docId);
        return record ? structuredClone(record) : undefined;
    }

    async put(record: SyncRecord) {
        this.records.set(record.docId, structuredClone(record));
    }

    async putIfClean(record: SyncRecord) {
        if (this.records.get(record.docId)?.localDirty) return false;
        this.records.set(record.docId, structuredClone(record));
        return true;
    }

    async delete(docId: string) {
        this.records.delete(docId);
    }

    async all() {
        return [...this.records.values()].map((x) => structuredClone(x));
    }

    async clear() {
        this.records.clear();
    }
}

export class IndexedDbSyncStore implements ISyncStore {
    constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

    private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await openCloudCacheDb(this.factory)).transaction(SYNC_STORE, mode).objectStore(SYNC_STORE);
    }

    async get(docId: string): Promise<SyncRecord | undefined> {
        try {
            return ((await idbRequest((await this.store("readonly")).get(docId))) as SyncRecord) ?? undefined;
        } catch (error) {
            Logger.warn(`[cloud] sync record read failed: ${error}`);
            return undefined;
        }
    }

    /** Throws when the record can't be written (quota): the caller must not report it saved. */
    async put(record: SyncRecord): Promise<void> {
        await idbRequest((await this.store("readwrite")).put(record, record.docId));
    }

    async putIfClean(record: SyncRecord): Promise<boolean> {
        try {
            const store = await this.store("readwrite");
            const stored = (await idbRequest(store.get(record.docId))) as SyncRecord | undefined;
            if (stored?.localDirty) return false;
            await idbRequest(store.put(record, record.docId));
            return true;
        } catch (error) {
            Logger.warn(`[cloud] sync record write failed: ${error}`);
            return false;
        }
    }

    async delete(docId: string): Promise<void> {
        try {
            await idbRequest((await this.store("readwrite")).delete(docId));
        } catch (error) {
            Logger.warn(`[cloud] sync record delete failed: ${error}`);
        }
    }

    async all(): Promise<SyncRecord[]> {
        try {
            return (await idbRequest((await this.store("readonly")).getAll())) as SyncRecord[];
        } catch (error) {
            Logger.warn(`[cloud] sync records read failed: ${error}`);
            return [];
        }
    }

    async clear(): Promise<void> {
        try {
            await idbRequest((await this.store("readwrite")).clear());
        } catch (error) {
            Logger.warn(`[cloud] sync records clear failed: ${error}`);
        }
    }
}

export function defaultSyncStore(): ISyncStore {
    return globalThis.indexedDB ? new IndexedDbSyncStore() : new MemorySyncStore();
}

/** The kind a pending save pushes as once `next` joins `pending` (manual wins, a merge stays one). */
export function combineKinds(pending: PendingKind | undefined, next: SaveKind): PendingKind {
    const kind: PendingKind = next === "restore" ? "manual" : next;
    if (!pending) return kind;
    if (pending === "merge" || kind === "merge") return "merge";
    if (pending === "manual" || kind === "manual") return "manual";
    if (pending === "mcp" || kind === "mcp") return "mcp";
    return "auto";
}

/**
 * Every blob a record keeps in the cache while it has pending changes: its snapshot's and its
 * base's (the merge base). A clean record's base is only cached (for opening offline) and may go.
 */
export function retainedBlobs(record: SyncRecord): string[] {
    if (!record.localDirty) return [];
    const shas: string[] = [];
    if (record.localSnapshot) {
        shas.push(record.localSnapshot.manifestSha256, ...record.localSnapshot.blobs);
        if (record.localSnapshot.thumbnailSha256) shas.push(record.localSnapshot.thumbnailSha256);
    }
    if (record.baseVersion) shas.push(record.baseVersion.manifestSha256, ...record.baseVersion.blobs);
    return shas;
}
