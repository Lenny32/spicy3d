// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Logger, type SaveKind } from "@spicy3d/core";
import {
    BLOB_META_STORE,
    CLOUD_CACHE_DB,
    EVICTION_GRACE_MS,
    IndexedDbBlobCache,
    MemoryBlobCache,
} from "../src/documents/blobCache";
import {
    combineKinds,
    combinePending,
    IndexedDbSyncStore,
    type PendingKind,
    retainedBlobs,
    type SyncRecord,
} from "../src/sync/syncStore";
import { FakeIndexedDbFactory } from "./_helpers/fakeIndexedDb";

const bytes = (size: number) => new Uint8Array(size).fill(1);

function record(docId: string, fields: Partial<SyncRecord> = {}): SyncRecord {
    return { docId, ownerId: "u", name: docId, localDirty: false, clientId: "c", updatedAt: 1, ...fields };
}

beforeEach(() => {
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
    rs.restoreAllMocks();
});

describe("blob cache LRU", () => {
    test("memory: least recently used first, never one kept", async () => {
        let now = 0;
        const cache = new MemoryBlobCache(() => now);
        await cache.put("a", bytes(10));
        await cache.put("b", bytes(10));
        await cache.put("c", bytes(10));
        await cache.get("a");
        now = EVICTION_GRACE_MS + 1;

        const freed = await cache.evict(20, new Set(["b"]));

        expect(freed).toBe(10);
        expect([...cache.entries.keys()]).toEqual(["b", "a"]);
        expect(await cache.evict(5, new Set(["a", "b"]))).toBe(0);
    });

    test("IndexedDB: sizes and use times recorded, oldest evicted first, kept ones survive", async () => {
        const factory = new FakeIndexedDbFactory();
        let now = 1000;
        const cache = new IndexedDbBlobCache(factory.asFactory(), () => now);
        await cache.put("old", bytes(40));
        now = 2000;
        await cache.put("kept", bytes(40));
        now = 3000;
        await cache.put("recent", bytes(40));
        now = 100_000;
        // A read refreshes the use time (at most once a minute).
        expect(await cache.get("old")).toEqual(bytes(40));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const freed = await cache.evict(80, new Set(["kept"]));

        expect(freed).toBe(40);
        expect(await cache.get("recent")).toBeUndefined();
        expect(await cache.get("kept")).toEqual(bytes(40));
        expect(await cache.get("old")).toEqual(bytes(40));
        expect([...factory.store(CLOUD_CACHE_DB, BLOB_META_STORE)!.keys()].sort()).toEqual(["kept", "old"]);
    });

    test.each([
        "memory",
        "IndexedDB",
    ])("%s: an entry written or read within the grace period is never evicted (a save may be writing it)", async (kind) => {
        let now = 0;
        const cache =
            kind === "memory"
                ? new MemoryBlobCache(() => now)
                : new IndexedDbBlobCache(new FakeIndexedDbFactory().asFactory(), () => now);
        await cache.put("old", bytes(10));
        now = 10 * EVICTION_GRACE_MS;
        await cache.put("fresh", bytes(10));
        now += EVICTION_GRACE_MS - 1;

        expect(await cache.evict(0, new Set())).toBe(10);
        expect(await cache.get("old")).toBeUndefined();
        expect(await cache.get("fresh")).toEqual(bytes(10));
    });

    test("IndexedDB: under the cap, nothing goes", async () => {
        const cache = new IndexedDbBlobCache(new FakeIndexedDbFactory().asFactory());
        await cache.put("a", bytes(10));
        expect(await cache.evict(100, new Set())).toBe(0);
        expect(await cache.get("a")).toEqual(bytes(10));
    });
});

describe("sync store", () => {
    test("records survive a new store over the same database (a reload)", async () => {
        const factory = new FakeIndexedDbFactory();
        await new IndexedDbSyncStore(factory.asFactory()).put(
            record("d1", { localDirty: true, pendingKind: "auto" }),
        );

        const reloaded = new IndexedDbSyncStore(factory.asFactory());

        expect(await reloaded.get("d1")).toMatchObject({ localDirty: true, pendingKind: "auto" });
        expect((await reloaded.all()).map((x) => x.docId)).toEqual(["d1"]);
        await reloaded.clear();
        expect(await reloaded.all()).toEqual([]);
    });

    test("putIfClean never replaces pending changes", async () => {
        const store = new IndexedDbSyncStore(new FakeIndexedDbFactory().asFactory());
        await store.put(record("d1", { localDirty: true, name: "pending" }));

        expect(await store.putIfClean(record("d1", { name: "clean" }))).toBe(false);
        expect((await store.get("d1"))?.name).toBe("pending");
        expect(await store.putIfClean(record("d2"))).toBe(true);
    });

    test("a failed write is reported to the caller (a save must not claim to be kept)", async () => {
        const factory = new FakeIndexedDbFactory();
        const store = new IndexedDbSyncStore(factory.asFactory());
        factory.failWrites = true;
        await expect(store.put(record("d1"))).rejects.toMatchObject({ name: "QuotaExceededError" });
    });

    test.each([
        [undefined, "auto", "auto"],
        ["auto", "auto", "auto"],
        ["auto", "manual", "manual"],
        ["manual", "auto", "manual"],
        ["merge", "manual", "merge"],
        ["auto", "restore", "manual"],
        ["auto", "mcp", "mcp"],
        // The user's later autosave holds their own edits too: no longer the agent's version.
        ["mcp", "auto", "auto"],
        ["mcp", "manual", "manual"],
        ["manual", "mcp", "manual"],
    ] as [
        PendingKind | undefined,
        SaveKind,
        PendingKind,
    ][])("pending %s + %s → %s", (pending, next, expected) => {
        expect(combineKinds(pending, next)).toBe(expected);
    });

    test("an agent's label stays only while the push is the agent's save", () => {
        expect(combinePending(undefined, undefined, "mcp", "Agent: hole")).toEqual({
            kind: "mcp",
            label: "Agent: hole",
        });
        // The user's later autosave or a manual save joined: their version, not labelled as the agent's.
        expect(combinePending("mcp", "Agent: hole", "auto", undefined)).toEqual({ kind: "auto" });
        expect(combinePending("mcp", "Agent: hole", "manual", undefined)).toEqual({ kind: "manual" });
        expect(combinePending("manual", undefined, "mcp", "Agent: hole")).toEqual({ kind: "manual" });
        // The agent's next save carries its own label (or none).
        expect(combinePending("mcp", "first", "mcp", "second")).toEqual({ kind: "mcp", label: "second" });
        expect(combinePending("auto", undefined, "mcp", "late")).toEqual({ kind: "mcp", label: "late" });
    });

    test("a pending record keeps its snapshot and its base; a clean one keeps nothing", () => {
        const base = { id: "v1", manifestSha256: "m1", blobs: ["b1"] };
        const snapshot = {
            manifestSha256: "m2",
            blobs: ["b2"],
            thumbnailSha256: "t",
            formatVersion: 1,
            savedAt: 1,
        };

        expect(
            retainedBlobs(record("d", { localDirty: true, baseVersion: base, localSnapshot: snapshot })),
        ).toEqual(["m2", "b2", "t", "m1", "b1"]);
        expect(retainedBlobs(record("d", { baseVersion: base }))).toEqual([]);
    });
});
