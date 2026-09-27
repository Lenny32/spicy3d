// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@spicy3d/core";

/**
 * The cached copies of cloud documents on this device: manifests and blobs, keyed by the SHA-256 of
 * their content, so an entry never goes stale. Reopening a document downloads only what changed;
 * signing out clears it (unless the user keeps offline copies). A failing cache reads as a miss.
 */
export interface IBlobCache {
    get(sha256: string): Promise<Uint8Array | undefined>;
    put(sha256: string, bytes: Uint8Array): Promise<void>;
    clear(): Promise<void>;
}

export class MemoryBlobCache implements IBlobCache {
    readonly entries = new Map<string, Uint8Array>();

    async get(sha256: string) {
        return this.entries.get(sha256);
    }

    async put(sha256: string, bytes: Uint8Array) {
        this.entries.set(sha256, bytes);
    }

    async clear() {
        this.entries.clear();
    }
}

/** Separate from the app's `spicy3d-db`: local documents are never touched by clearing it. */
export const CLOUD_CACHE_DB = "spicy3d-cloud-cache";
const STORE = "blobs";

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** The cache in IndexedDB (`spicy3d-cloud-cache`). */
export class IndexedDbBlobCache implements IBlobCache {
    private db?: Promise<IDBDatabase>;

    constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

    private open(): Promise<IDBDatabase> {
        this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
            const open = this.factory.open(CLOUD_CACHE_DB, 1);
            open.onupgradeneeded = () => {
                if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
            };
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        return this.db;
    }

    private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await this.open()).transaction(STORE, mode).objectStore(STORE);
    }

    async get(sha256: string): Promise<Uint8Array | undefined> {
        try {
            const value: unknown = await request((await this.store("readonly")).get(sha256));
            return value instanceof Uint8Array ? value : undefined;
        } catch (error) {
            Logger.warn(`[cloud] cache read failed: ${error}`);
            return undefined;
        }
    }

    async put(sha256: string, bytes: Uint8Array): Promise<void> {
        try {
            await request((await this.store("readwrite")).put(bytes, sha256));
        } catch (error) {
            // Quota or private mode: the next load downloads it again.
            Logger.warn(`[cloud] cache write failed: ${error}`);
        }
    }

    async clear(): Promise<void> {
        try {
            await request((await this.store("readwrite")).clear());
        } catch (error) {
            Logger.warn(`[cloud] cache clear failed: ${error}`);
        }
    }
}

/** IndexedDB where the browser has it, memory otherwise (tests, some private modes). */
export function defaultBlobCache(): IBlobCache {
    return globalThis.indexedDB ? new IndexedDbBlobCache() : new MemoryBlobCache();
}
