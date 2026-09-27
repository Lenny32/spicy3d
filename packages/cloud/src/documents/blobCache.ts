// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@spicy3d/core";

/**
 * The cached copies of cloud documents on this device: manifests and blobs, keyed by the SHA-256 of
 * their content, so an entry never goes stale. Reopening a document downloads only what changed;
 * signing out clears it (unless the user keeps offline copies). A failing cache reads as a miss.
 * Least recently used entries go first once the cache outgrows its cap (`evict`), except the ones
 * the offline sync still needs: pending local saves and the versions they are based on.
 */
export interface IBlobCache {
    get(sha256: string): Promise<Uint8Array | undefined>;
    put(sha256: string, bytes: Uint8Array): Promise<void>;
    /**
     * `put` that fails instead of logging (a full disk, private mode): what a pending save points at
     * must really be stored before the save is reported kept.
     */
    putStrict(sha256: string, bytes: Uint8Array): Promise<void>;
    clear(): Promise<void>;
    /**
     * Removes least recently used entries until the cache holds at most `maxBytes`, never one of
     * `keep` nor one written or read within {@link EVICTION_GRACE_MS} (a save running meanwhile
     * may have just written it, after `keep` was computed). Resolves the bytes removed.
     */
    evict(maxBytes: number, keep: ReadonlySet<string>): Promise<number>;
}

/** Entries used this recently are never evicted (see `IBlobCache.evict`). */
export const EVICTION_GRACE_MS = 60_000;

/** Least recently used first: `Map` keeps insertion order and a read moves the entry to the end. */
export class MemoryBlobCache implements IBlobCache {
    readonly entries = new Map<string, Uint8Array>();

    async get(sha256: string) {
        const bytes = this.entries.get(sha256);
        if (bytes) {
            this.entries.delete(sha256);
            this.entries.set(sha256, bytes);
            this.usedAt.set(sha256, this.now());
        }
        return bytes;
    }

    async put(sha256: string, bytes: Uint8Array) {
        this.entries.delete(sha256);
        this.entries.set(sha256, bytes);
        this.usedAt.set(sha256, this.now());
    }

    async putStrict(sha256: string, bytes: Uint8Array) {
        if (this.failWrites) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
        await this.put(sha256, bytes);
    }

    /** Tests: every strict write fails like a full disk. */
    failWrites = false;
    private readonly usedAt = new Map<string, number>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    async clear() {
        this.entries.clear();
        this.usedAt.clear();
    }

    async evict(maxBytes: number, keep: ReadonlySet<string>): Promise<number> {
        let total = 0;
        for (const bytes of this.entries.values()) total += bytes.byteLength;
        let freed = 0;
        const recent = this.now() - EVICTION_GRACE_MS;
        for (const [sha, bytes] of [...this.entries]) {
            if (total - freed <= maxBytes) break;
            if (keep.has(sha) || (this.usedAt.get(sha) ?? 0) >= recent) continue;
            this.entries.delete(sha);
            freed += bytes.byteLength;
        }
        return freed;
    }
}

/** Separate from the app's `spicy3d-db`: local documents are never touched by clearing it. */
export const CLOUD_CACHE_DB = "spicy3d-cloud-cache";
/** 1: blobs. 2: + blob sizes and use times (LRU), + the offline sync's records. */
export const CLOUD_CACHE_DB_VERSION = 2;
export const BLOB_STORE = "blobs";
export const BLOB_META_STORE = "blobMeta";
export const SYNC_STORE = "sync";

/** A read refreshes an entry's use time at most this often (a write per read would be wasteful). */
const TOUCH_INTERVAL_MS = 60_000;

interface BlobMeta {
    size: number;
    usedAt: number;
}

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

const databases = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

/**
 * The cloud cache database, opened once per factory and shared by the blob cache and the sync
 * store (one upgrade creates every store).
 */
export function openCloudCacheDb(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
    let db = databases.get(factory);
    if (!db) {
        db = new Promise<IDBDatabase>((resolve, reject) => {
            const open = factory.open(CLOUD_CACHE_DB, CLOUD_CACHE_DB_VERSION);
            open.onupgradeneeded = () => {
                const names = open.result.objectStoreNames;
                for (const store of [BLOB_STORE, BLOB_META_STORE, SYNC_STORE]) {
                    if (!names.contains(store)) open.result.createObjectStore(store);
                }
            };
            open.onsuccess = () => {
                // Another tab upgrading later closes this connection instead of being blocked.
                open.result.onversionchange = () => {
                    open.result.close();
                    databases.delete(factory);
                };
                resolve(open.result);
            };
            open.onerror = () => {
                databases.delete(factory);
                reject(open.error);
            };
        });
        databases.set(factory, db);
    }
    return db;
}

/** The cache in IndexedDB (`spicy3d-cloud-cache`). */
export class IndexedDbBlobCache implements IBlobCache {
    private readonly touched = new Map<string, number>();

    constructor(
        private readonly factory: IDBFactory = globalThis.indexedDB,
        private readonly now: () => number = () => Date.now(),
    ) {}

    private async stores(mode: IDBTransactionMode): Promise<[IDBObjectStore, IDBObjectStore]> {
        const transaction = (await openCloudCacheDb(this.factory)).transaction(
            [BLOB_STORE, BLOB_META_STORE],
            mode,
        );
        return [transaction.objectStore(BLOB_STORE), transaction.objectStore(BLOB_META_STORE)];
    }

    async get(sha256: string): Promise<Uint8Array | undefined> {
        try {
            const [blobs] = await this.stores("readonly");
            const value: unknown = await idbRequest(blobs.get(sha256));
            if (!(value instanceof Uint8Array)) return undefined;
            void this.touch(sha256, value.byteLength);
            return value;
        } catch (error) {
            Logger.warn(`[cloud] cache read failed: ${error}`);
            return undefined;
        }
    }

    private async touch(sha256: string, size: number) {
        const now = this.now();
        if (now - (this.touched.get(sha256) ?? 0) < TOUCH_INTERVAL_MS) return;
        this.touched.set(sha256, now);
        try {
            const [, meta] = await this.stores("readwrite");
            await idbRequest(meta.put({ size, usedAt: now } satisfies BlobMeta, sha256));
        } catch (error) {
            Logger.warn(`[cloud] cache use time not recorded: ${error}`);
        }
    }

    async put(sha256: string, bytes: Uint8Array): Promise<void> {
        try {
            await this.putStrict(sha256, bytes);
        } catch (error) {
            // Quota or private mode: the next load downloads it again.
            Logger.warn(`[cloud] cache write failed: ${error}`);
        }
    }

    async putStrict(sha256: string, bytes: Uint8Array): Promise<void> {
        const [blobs, meta] = await this.stores("readwrite");
        const now = this.now();
        this.touched.set(sha256, now);
        await Promise.all([
            idbRequest(blobs.put(bytes, sha256)),
            idbRequest(meta.put({ size: bytes.byteLength, usedAt: now } satisfies BlobMeta, sha256)),
        ]);
    }

    async clear(): Promise<void> {
        this.touched.clear();
        try {
            const [blobs, meta] = await this.stores("readwrite");
            await Promise.all([idbRequest(blobs.clear()), idbRequest(meta.clear())]);
        } catch (error) {
            Logger.warn(`[cloud] cache clear failed: ${error}`);
        }
    }

    async evict(maxBytes: number, keep: ReadonlySet<string>): Promise<number> {
        try {
            const [, meta] = await this.stores("readonly");
            const [keys, values] = await Promise.all([
                idbRequest(meta.getAllKeys()),
                idbRequest(meta.getAll() as IDBRequest<BlobMeta[]>),
            ]);
            // Blobs cached before the sizes were recorded (version 1) aren't counted until read.
            const entries = keys.map((key, i) => ({ sha: String(key), ...values[i] }));
            let total = entries.reduce((sum, x) => sum + x.size, 0);
            if (total <= maxBytes) return 0;
            const victims: string[] = [];
            const recent = this.now() - EVICTION_GRACE_MS;
            for (const entry of entries.sort((a, b) => a.usedAt - b.usedAt)) {
                if (total <= maxBytes) break;
                const used = Math.max(entry.usedAt, this.touched.get(entry.sha) ?? 0);
                if (keep.has(entry.sha) || used >= recent) continue;
                victims.push(entry.sha);
                total -= entry.size;
            }
            const freed = entries.filter((x) => victims.includes(x.sha)).reduce((s, x) => s + x.size, 0);
            const [blobs, metaWrite] = await this.stores("readwrite");
            await Promise.all(
                victims.flatMap((sha) => {
                    this.touched.delete(sha);
                    return [idbRequest(blobs.delete(sha)), idbRequest(metaWrite.delete(sha))];
                }),
            );
            return freed;
        } catch (error) {
            Logger.warn(`[cloud] cache eviction failed: ${error}`);
            return 0;
        }
    }
}

/** IndexedDB where the browser has it, memory otherwise (tests, some private modes). */
export function defaultBlobCache(): IBlobCache {
    return globalThis.indexedDB ? new IndexedDbBlobCache() : new MemoryBlobCache();
}
