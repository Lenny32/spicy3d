// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { AutosaveHolds, type IDocument, Logger, Result, type Serialized } from "@spicy3d/core";
import { IndexedDbBlobCache, MemoryBlobCache } from "../src/documents/blobCache";
import { keepMineChoice } from "../src/documents/cloudDocuments";
import { EditLocks } from "../src/documents/editLocks";
import { VersionHistory } from "../src/history/versionHistory";
import { combineKinds, IndexedDbSyncStore, MemorySyncStore } from "../src/sync/syncStore";
import { FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeIndexedDbFactory } from "./_helpers/fakeIndexedDb";
import { FakeServer, json, problem, TestRequest, USER } from "./_helpers/fakeServer";
import {
    Device,
    documentData,
    FakeEventsServer,
    FlakyNetwork,
    SharedLocks,
    type SyncDoc,
    seeded,
    sleep,
    until,
    valuesOf,
} from "./_helpers/syncHarness";

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

let devices: Device[];
let server: FakeServer;
let docs: FakeDocumentServer;
let events: FakeEventsServer;

beforeEach(() => {
    devices = [];
    server = new FakeServer();
    docs = new FakeDocumentServer(server);
    events = new FakeEventsServer(docs);
    rs.spyOn(Logger, "info").mockImplementation(() => {});
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
    for (const device of devices) device.dispose();
    rs.restoreAllMocks();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

async function device(network?: FlakyNetwork, options?: Parameters<typeof Device.start>[3]) {
    const started = await Device.start(server, events, network ?? new FlakyNetwork(server), options);
    devices.push(started);
    return started;
}

const head = (id = "doc-1") => docs.head(id)!;
const headValues = (id = "doc-1") => valuesOf(docs.content(head(id)));

describe("local first", () => {
    test("a save lands on this device first, then is pushed; the record is clean with the new head as base", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });

        expect(head().kind).toBe("manual");
        expect(headValues()).toEqual({ w: "10" });
        const record = await a.store.get("doc-1");
        expect(record?.localDirty).toBe(false);
        expect(record?.baseVersion?.id).toBe(head().id);
        expect(doc.version).toBe(head().id);
        expect(doc.isDirty).toBe(false);
        expect(a.repository.stateOf("doc-1")).toBe("saved");
    });

    test.each([
        [["auto", "auto", "auto"], "auto"],
        [["auto", "manual", "auto"], "manual"],
    ] as const)("server stopped, saves %j, restarted: one %s version on the right parent, nothing lost", async (kinds, expected) => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        const parent = head().id;
        const versions = docs.documents.get("doc-1")!.versions.length;

        a.network.down = true;
        for (const [i, kind] of kinds.entries()) {
            doc.edit("w", `${20 + i}`);
            const saved = await doc.save(kind);
            // Safe on this device: the document is clean even though the server is gone.
            expect(saved.isOk && saved.value.status).toBe("saved");
            expect(doc.isDirty).toBe(false);
        }
        await until(() => a.repository.stateOf("doc-1") === "offline", "offline");
        const pending = await a.store.get("doc-1");
        expect(pending?.localDirty).toBe(true);
        // A push attempt made for an earlier save (it failed: offline) keeps the later saves' kinds in
        // `nextKind` until the next attempt folds them in — what that push will carry is both.
        const effective = pending?.nextKind
            ? combineKinds(pending.pendingKind, pending.nextKind)
            : pending?.pendingKind;
        expect(effective).toBe(expected);
        expect(pending?.baseVersion?.id).toBe(parent);

        a.network.down = false;
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed after the restart");

        const document = docs.documents.get("doc-1")!;
        expect(document.versions.length).toBe(versions + 1);
        expect(head().kind).toBe(expected);
        expect(head().parentIds).toEqual([parent]);
        expect(headValues()).toEqual({ w: `${20 + kinds.length - 1}`, h: "5" });
        expect(doc.version).toBe(head().id);
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
    });

    test("a lost answer is retried with the same Idempotency-Key: one version, not two", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const versions = docs.documents.get("doc-1")!.versions.length;
        a.network.loseAnswerOnce((r) => r.method === "POST" && r.url.endsWith("/versions"));

        doc.edit("w", "11");
        await doc.save("auto");
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");

        const posts = server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/versions"));
        expect(posts.length).toBe(2);
        expect(posts[0].headers["idempotency-key"]).toBe(posts[1].headers["idempotency-key"]);
        expect(docs.documents.get("doc-1")!.versions.length).toBe(versions + 1);
        expect(doc.version).toBe(head().id);
    });

    test.each([
        "memory",
        "IndexedDB",
    ])("reload while offline with pending changes (%s): still there, pushed once the server is back", async (kind) => {
        const factory = new FakeIndexedDbFactory().asFactory();
        const store = kind === "memory" ? new MemorySyncStore() : new IndexedDbSyncStore(factory);
        const cache = kind === "memory" ? new MemoryBlobCache() : new IndexedDbBlobCache(factory);
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        const doc = await first.create("doc-1", { w: "10" });
        const parent = head().id;

        network.down = true;
        doc.edit("w", "42");
        await doc.save("auto");
        await first.engine.settle();
        first.dispose();
        devices.splice(devices.indexOf(first), 1);

        // The reload: a new tab (new client id) over the same IndexedDB, the server still down.
        const second = await device(network, { store, cache, settings: first.account.deviceSettings });
        expect(second.account.isSignedIn).toBe(true);
        const reopened = await second.open("doc-1");
        expect(reopened.values).toEqual({ w: "42" });
        expect(reopened.isDirty).toBe(false);
        expect(second.repository.stateOf("doc-1")).toBe("offline");
        expect(head().id).toBe(parent);

        network.down = false;
        await until(() => second.repository.stateOf("doc-1") === "saved", "pushed later");
        expect(headValues()).toEqual({ w: "42" });
        expect(head().parentIds).toEqual([parent]);
        expect(reopened.version).toBe(head().id);
    });

    test("opening offline shows the copy last synced here", async () => {
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache();
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        await first.create("doc-1", { w: "10" });
        first.dispose();
        devices.splice(devices.indexOf(first), 1);

        network.down = true;
        const second = await device(network, { store, cache, settings: first.account.deviceSettings });
        const listed = await second.repository.list();
        expect(listed.isOk && listed.value.items.map((x) => [x.id, x.syncState])).toEqual([
            ["doc-1", "synced"],
        ]);
        const reopened = await second.open("doc-1");

        expect(reopened.values).toEqual({ w: "10" });
        expect(reopened.version).toBe(head().id);
        expect(second.repository.stateOf("doc-1")).toBe("offline");
    });
});

describe("cached cloud open", () => {
    test("a warm load reads no network and a cold load reads its manifest once", async () => {
        const a = await device();
        await a.create("doc-1", { w: "10" });
        await a.engine.settle();
        server.requests.length = 0;

        const warm = await a.repository.load("doc-1");
        expect(warm.isOk).toBe(true);
        expect(valuesOf(warm.value.data)).toEqual({ w: "10" });
        expect(warm.value.version).toBe(head().id);
        expect(server.calls).toEqual([]);

        const b = await device();
        await b.engine.settle();
        const read = rs.spyOn(b.cache, "get");
        const cold = await b.repository.load("doc-1");
        expect(cold.isOk).toBe(true);
        expect(valuesOf(cold.value.data)).toEqual({ w: "10" });
        expect(read.mock.calls.filter(([sha]) => sha === head().manifestSha256)).toHaveLength(1);
        expect((await b.store.get("doc-1"))?.baseVersion?.id).toBe(head().id);
    });

    test.each(["manifest", "blob"])("a missing cached %s falls back to the head", async (missing) => {
        const a = await device();
        const brep = `CASCADE Topology V3\n${"0 1 2\n".repeat(2000)}`;
        await a.create("doc-1", { w: "10" }, [{ __cla$$__: "OccShape", shape: brep, id: "shape-1" }]);
        await a.engine.settle();
        const base = (await a.store.get("doc-1"))?.baseVersion;
        expect(base).toBeDefined();
        const cache = a.cache as MemoryBlobCache;
        if (missing === "manifest") cache.entries.delete(base!.manifestSha256);
        else {
            expect(base!.blobs.length).toBeGreaterThan(0);
            cache.entries.delete(base!.blobs[0]);
        }
        server.requests.length = 0;
        const loaded = await a.repository.load("doc-1");
        expect(loaded.isOk).toBe(true);
        expect(valuesOf(loaded.value.data)).toEqual({ w: "10" });
        expect(loaded.value.data["models"].nodes[0].shape).toBe(brep);
        expect(server.calls).toContain("GET /api/documents/doc-1");
    });

    test.each([false, true])("a stale cache refreshes safely after opening (edited: %s)", async (edited) => {
        const a = await device();
        const original = await a.create("doc-1", { w: "10", h: "5" });
        await original.close();
        await a.engine.settle();
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99", h: "5" }));
        await a.engine.settle();
        const cached = await a.repository.load("doc-1");
        expect(cached.isOk).toBe(true);
        expect(valuesOf(cached.value.data)).toEqual({ w: "10", h: "5" });

        const reopened = (await a.app.openDocument("doc-1", a.repository)) as unknown as SyncDoc;
        expect(reopened).not.toBeUndefined();
        if (edited) reopened.edit("h", "42");
        await until(() => reopened.values["w"] === "99", "cache revalidated");
        expect(reopened.values).toEqual({ w: "99", h: edited ? "42" : "5" });
        expect(reopened.isDirty).toBe(edited);
        expect(reopened.version).toBe(head().id);
        expect(reopened.replaced).toEqual([edited ? "merge" : "remote update"]);
    });

    test("a cached read-only opening refreshes without pushing or taking the editor's lock", async () => {
        const a = await device();
        const original = await a.create("doc-1", { w: "10" });
        await original.close();
        await a.engine.settle();
        const locks = new SharedLocks();
        locks.held.add("spicy3d.document.doc-1");
        const viewer = await device(undefined, {
            cache: a.cache,
            store: a.store,
            locks: new EditLocks(locks, undefined),
        });
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99" }));
        await viewer.engine.settle();
        const cached = await viewer.repository.load("doc-1");
        expect(cached.isOk).toBe(true);
        expect(valuesOf(cached.value.data)).toEqual({ w: "10" });
        server.requests.length = 0;
        const shown = await viewer.open("doc-1");
        await until(() => shown.values["w"] === "99", "read-only cache refreshed");
        expect(viewer.documents.locks.isReadOnly("doc-1")).toBe(true);
        expect(locks.held.has("spicy3d.document.doc-1")).toBe(true);
        expect(shown.isDirty).toBe(false);
        expect(shown.version).toBe(head().id);
        expect(server.requests.filter((r) => r.method !== "GET")).toEqual([]);
        expect((await viewer.store.get("doc-1"))?.baseVersion?.id).toBe(original.version);
    });

    test("metadata-only renames refresh a cached clean document", async () => {
        const a = await device();
        const original = await a.create("doc-1", { w: "10" });
        await original.close();
        await a.engine.settle();
        docs.documents.get("doc-1")!.name = "Renamed elsewhere";
        const reopened = await a.open("doc-1");
        await until(() => reopened.name === "Renamed elsewhere", "rename refreshed");
        expect(reopened.values).toEqual({ w: "10" });
        expect(reopened.isDirty).toBe(false);
        expect(reopened.version).toBe(head().id);
        expect((await a.store.get("doc-1"))?.name).toBe("Renamed elsewhere");
    });

    test("Open latest and Restore bypass the stale cache", async () => {
        const a = await device();
        const original = await a.create("doc-1", { w: "10" });
        const first = head();
        await original.close();
        await a.engine.settle();
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99" }));
        await a.engine.settle();
        await a.engine.discardLocal("doc-1");
        const latest = await a.repository.load("doc-1");
        expect(latest.isOk).toBe(true);
        expect(valuesOf(latest.value.data)).toEqual({ w: "99" });
        const restored = await a.repository.restoreVersion("doc-1", first);
        expect(restored.isOk).toBe(true);
        const loaded = await a.repository.load("doc-1");
        expect(loaded.isOk).toBe(true);
        expect(valuesOf(loaded.value.data)).toEqual({ w: "10" });
        expect(loaded.value.version).toBe(restored.value.version.id);
    });
});

describe("pull", () => {
    test("an update from device B appears on clean A within ~2 s, in place, with a toast", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const steps = doc.undoSteps;

        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99" }), "Laptop – Chrome");
        const elapsed = await until(() => doc.values["w"] === "99", "the update", 2000);

        expect(elapsed).toBeLessThan(2000);
        expect(doc.isDirty).toBe(false);
        expect(doc.version).toBe(head().id);
        expect(doc.replaced).toEqual(["remote update"]);
        expect(doc.undoSteps).toBe(steps + 1);
        expect(a.toasted("cloud.sync.updatedFrom{0}")).toEqual([["Laptop – Chrome"]]);
        expect((await a.store.get("doc-1"))?.baseVersion?.id).toBe(head().id);
    });

    test("its own saves' events are ignored: no refetch", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        server.requests.length = 0;

        doc.edit("w", "11");
        await doc.save("auto");
        await a.engine.settle();
        await sleep(30);

        expect(server.calls.filter((c) => c === "GET /api/documents/doc-1")).toEqual([]);
        expect(doc.replaced).toEqual([]);
    });

    test("while a command runs, the update waits ('remote changes pending'), then applies", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        (a.app as { executingCommand: unknown }).executingCommand = {};

        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99" }));
        await until(() => a.repository.stateOf("doc-1") === "remotePending", "pending");
        expect(doc.values).toEqual({ w: "10" });

        (a.app as { executingCommand: unknown }).executingCommand = undefined;
        await until(() => doc.values["w"] === "99", "applied once idle");
        expect(a.repository.stateOf("doc-1")).toBe("saved");
    });

    test("refetches the heads on reconnect: an event missed while disconnected is caught up", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        events.up = false;
        events.dropAll();
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "77" }));
        await sleep(30);
        expect(doc.values).toEqual({ w: "10" });

        events.up = true;
        await until(() => doc.values["w"] === "77", "caught up after reconnecting");
    });

    test("unsaved edits here: the head is merged into them, which stay unsaved", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        doc.edit("h", "6");

        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "99", h: "5" }), "Tablet");
        await until(() => doc.values["w"] === "99", "merged");

        expect(doc.values).toEqual({ w: "99", h: "6" });
        expect(doc.isDirty).toBe(true);
        expect(doc.version).toBe(head().id);
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        expect(a.toasted("cloud.sync.mergedFrom{0}")).toEqual([["Tablet"]]);
    });
});

describe("diverged", () => {
    test("a clean merge is applied as one step and pushed as a merge version (parents: head, own base)", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        const base = head().id;
        a.network.down = true;
        doc.edit("h", "6");
        await doc.save("manual");
        const theirs = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "99", h: "5" }),
            "Tablet",
        );

        a.network.down = false;
        a.engine.refreshAll();
        await until(
            () => head().kind === "merge" && a.repository.stateOf("doc-1") === "saved",
            "merged and pushed",
        );

        expect(head().parentIds).toEqual([theirs.id, base]);
        expect(headValues()).toEqual({ w: "99", h: "6" });
        expect(doc.values).toEqual({ w: "99", h: "6" });
        expect(doc.isDirty).toBe(false);
        expect(doc.version).toBe(head().id);
        expect(doc.replaced).toEqual(["merge"]);
        expect(a.toasted("cloud.sync.mergedFrom{0}")).toEqual([["Tablet"]]);
    });

    test("conflicting changes: the conflict state with both sides labelled, resolved with the user's choices", async () => {
        const a = await device(undefined, { deviceName: "Desktop" });
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        const base = head().id;
        a.network.down = true;
        doc.edit("w", "20");
        doc.edit("h", "6");
        await doc.save("auto");
        const theirs = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "30", h: "5" }),
            "Tablet",
        );
        const changed: string[] = [];
        a.engine.onChanged((id) => changed.push(id));

        a.network.down = false;
        a.engine.refreshAll();
        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");

        const conflict = a.engine.syncConflictOf("doc-1");
        expect(conflict?.local).toBe("pending");
        expect(conflict?.theirs).toMatchObject({ versionId: theirs.id, deviceName: "Tablet" });
        expect(conflict?.ours.deviceName).toBe("Desktop");
        expect(conflict?.base.versionId).toBe(base);
        expect(conflict?.result?.conflicts.map((x) => [x.ours, x.theirs])).toEqual([["20", "30"]]);
        expect(a.repository.conflictOf("doc-1")).toMatchObject({
            headVersion: theirs.id,
            headDeviceName: "Tablet",
        });
        expect(changed).toContain("doc-1");
        expect(head().id).toBe(theirs.id);
        expect(a.toasted("cloud.sync.conflict{0}")).toEqual([["Bracket"]]);

        const path = conflict!.result!.conflicts[0].path;
        const resolved = await a.engine.resolve("doc-1", [{ path, choice: "theirs" }]);
        expect(resolved.isOk).toBe(true);
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");

        expect(head().kind).toBe("merge");
        expect(head().parentIds).toEqual([theirs.id, base]);
        expect(headValues()).toEqual({ w: "30", h: "6" });
        expect(doc.values).toEqual({ w: "30", h: "6" });
        expect(doc.isDirty).toBe(false);
    });

    test("the conflict pill opens the conflict panel, which merges keeping this device's side", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "20");
        await doc.save("auto");
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }));
        a.network.down = false;
        a.engine.refreshAll();
        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");

        await a.documents.resolveConflict(doc as unknown as IDocument);
        const panel = a.documents.conflicts;
        expect(panel).not.toBeUndefined();
        expect(document.querySelector("dialog[open]")).toBeNull();
        panel!.querySelector<HTMLButtonElement>('[data-action="keepAllMine"]')!.click();
        await panel!.finish();
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");

        expect(head().kind).toBe("merge");
        expect(headValues()).toEqual({ w: "20" });
        expect(a.documents.conflicts).toBeUndefined();
    });

    test("'Open latest' drops this device's pending save and reopens the head", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "20");
        await doc.save("auto");
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }));
        a.network.down = false;
        a.engine.refreshAll();
        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");

        await a.documents.resolveConflict(doc as unknown as IDocument);
        a.documents.conflicts!.querySelector<HTMLButtonElement>('[data-action="openLatest"]')!.click();
        await until(() => [...a.app.documents].some((x) => x !== (doc as unknown as IDocument)), "reopened");
        await a.engine.settle();

        const reopened = [...a.app.documents].find((x) => x.id === "doc-1") as unknown as SyncDoc;
        expect(reopened).not.toBe(doc);
        expect(reopened.values).toEqual({ w: "30" });
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        expect(headValues()).toEqual({ w: "30" });
        expect(a.documents.conflicts).toBeUndefined();
    });
});

describe("ownership, storage, errors", () => {
    test("a closed document with pending changes keeps its lock and is pushed in the background", async () => {
        const locks = new SharedLocks();
        const a = await device(undefined, { locks: new EditLocks(locks, undefined) });
        const doc = await a.create("doc-1", { w: "10" });
        await until(() => locks.held.has("spicy3d.document.doc-1"), "the lock");
        a.network.down = true;
        doc.edit("w", "11");
        await doc.save("auto");
        await doc.close({ discardChanges: true });
        await sleep(20);
        expect(locks.held.has("spicy3d.document.doc-1")).toBe(true);

        a.network.down = false;
        await until(() => headValues()["w"] === "11", "pushed while closed");
        await until(() => !locks.held.has("spicy3d.document.doc-1"), "the lock let go once clean");
    });

    test("pending saves of an earlier session are pushed at startup by the tab that gets the lock", async () => {
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache();
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        const doc = await first.create("doc-1", { w: "10" });
        network.down = true;
        doc.edit("w", "12");
        await doc.save("manual");
        first.dispose();
        devices.splice(devices.indexOf(first), 1);
        network.down = false;

        const locks = new SharedLocks();
        locks.held.add("spicy3d.document.doc-1");
        const other = await device(network, { store, cache, locks: new EditLocks(locks, undefined) });
        await sleep(30);
        // Another tab holds it: that one pushes.
        expect(headValues()).toEqual({ w: "10" });
        other.dispose();
        devices.splice(devices.indexOf(other), 1);

        locks.held.delete("spicy3d.document.doc-1");
        await device(network, { store, cache, locks: new EditLocks(locks, undefined) });
        await until(() => headValues()["w"] === "12", "pushed at startup");
        expect(head().kind).toBe("manual");
    });

    test("a read-only tab shows newer versions but never pushes", async () => {
        const locks = new SharedLocks();
        const editor = await device(undefined, { locks: new EditLocks(locks, undefined) });
        const edited = await editor.create("doc-1", { w: "10" });
        const viewer = await device(undefined, { locks: new EditLocks(locks, undefined) });
        const shown = await viewer.open("doc-1");
        expect(viewer.documents.locks.isReadOnly("doc-1")).toBe(true);
        server.requests.length = 0;

        edited.edit("w", "20");
        await edited.save("auto");
        await until(() => shown.values["w"] === "20", "shown in the read-only tab");

        expect(shown.isDirty).toBe(false);
        const pushes = server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/versions"));
        expect(pushes.length).toBe(1);
        expect(
            (await viewer.repository.save({ id: "doc-1", name: "x", data: shown.serialize(), kind: "auto" }))
                .isOk,
        ).toBe(false);
    });

    test("the cache is kept under its cap without losing a pending save or its base", async () => {
        let clock = Date.now();
        const a = await device(undefined, { cache: new MemoryBlobCache(() => clock) });
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "11");
        await doc.save("auto");
        for (let i = 0; i < 5; i++) await a.cache.put(`junk-${i}`, new Uint8Array(1000));
        (a.engine.options as { cacheLimitBytes?: number }).cacheLimitBytes = 1;
        clock += 2 * 60_000;

        const freed = await a.engine.evict();

        expect(freed).toBe(5000);
        const record = await a.store.get("doc-1");
        expect(await a.cache.get(record!.localSnapshot!.manifestSha256)).not.toBeUndefined();
        expect(await a.cache.get(record!.baseVersion!.manifestSha256)).not.toBeUndefined();
        a.network.down = false;
        await until(() => headValues()["w"] === "11", "still pushed");
    });

    test("a full quota: error status and message, the save stays on this device, pushed on the next try", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        let full = true;
        server.on("POST /api/documents/doc-1/versions", (request) =>
            full ? problem(507, "quota_exceeded") : server.fallback!(request),
        );

        doc.edit("w", "11");
        await doc.save("manual");
        await until(() => a.repository.stateOf("doc-1") === "error", "error");
        expect(a.toasted("cloud.sync.quota")).toEqual([[]]);
        expect((await a.store.get("doc-1"))?.localDirty).toBe(true);

        full = false;
        doc.edit("w", "12");
        await doc.save("auto");
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed");
        expect(headValues()).toEqual({ w: "12" });
        expect(head().kind).toBe("manual");
    });

    test("an expired session: the pending save waits for the re-login and is pushed after it", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        let expired = true;
        server.on("POST /api/blobs/check", (request) =>
            expired ? problem(401, "unauthorized") : server.fallback!(request),
        );
        a.account.setReauthenticationHandler(() => {
            expired = false;
            server.on("POST /api/auth/login", json(200, USER));
            void a.account.signIn(USER.email, "secret");
        });

        doc.edit("w", "11");
        await doc.save("auto");
        await until(() => headValues()["w"] === "11", "pushed after signing in again");
        expect(a.account.isSignedIn).toBe(true);
    });

    test("signed out with offline copies removed: a closed document's unsynced save is kept on this device", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "33");
        await doc.save("auto");
        await doc.close({ discardChanges: true });

        // Offline: the sign-out is local only, the save never reached the server.
        await a.account.signOut();

        const local = await a.app.repositories.local.list();
        expect(local.isOk && local.value.items.map((x) => x.name)).toEqual(["Bracket"]);
        const copy = local.isOk ? await a.app.repositories.local.load(local.value.items[0].id) : undefined;
        expect(copy?.isOk && valuesOf(copy.value.data)).toEqual({ w: "33" });
        expect(a.toasted("cloud.sync.keptOnDevice{0}")).toEqual([["Bracket"]]);
        expect(await a.store.all()).toEqual([]);
    });

    test("a restore pushes this device's pending save first (never merged back after), and waits while it can't", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const first = head();
        a.network.down = true;
        doc.edit("w", "30");
        await doc.save("auto");
        const history = new VersionHistory({
            app: a.app,
            repository: a.repository,
            documentId: "doc-1",
            name: () => "Bracket",
        });

        const offline = await history.restore(first);
        expect(offline.isOk).toBe(false);
        expect(offline.error?.message).toBe("cloud.history.restoreUnsynced");

        a.network.down = false;
        const restored = await history.restore(first);
        expect(restored.isOk).toBe(true);
        await a.engine.settle();

        const kinds = docs.documents.get("doc-1")!.versions.map((x) => x.kind);
        expect(kinds.slice(-2)).toEqual(["auto", "restore"]);
        expect(headValues()).toEqual({ w: "10" });
        const reopened = [...a.app.documents].find((x) => x.id === "doc-1") as unknown as SyncDoc;
        expect(reopened.values).toEqual({ w: "10" });
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        history.dispose();
    });

    test("persistent storage is asked for once", async () => {
        const a = await device();
        const persist = rs.fn(async () => true);
        (a.engine.options as { requestPersistence?: () => Promise<boolean> }).requestPersistence = persist;
        (a.engine as unknown as { persistenceAsked: boolean }).persistenceAsked = false;
        const doc = await a.create("doc-1", { w: "10" });
        doc.edit("w", "11");
        await doc.save("auto");
        expect(persist).toHaveBeenCalledTimes(1);
    });
});

describe("fault injection", () => {
    /** Resolves a waiting conflict keeping this device's side, as the MVP dialog's merge does. */
    async function keepMine(a: Device) {
        const conflict = a.engine.syncConflictOf("doc-1");
        if (!conflict?.result) return;
        const choices = conflict.result.conflicts.map((x) => ({
            path: x.path,
            choice: keepMineChoice(x.choices),
        }));
        await a.engine.resolve("doc-1", choices);
    }

    test.each(
        Array.from({ length: 16 }, (_, i) => i + 1),
    )("a flapping network converges (seed %i): server head == local base, local clean, no lost edits", async (seed) => {
        const random = seeded(seed);
        const network = new FlakyNetwork(server, random);
        events.random = seeded(seed + 100);
        events.dropRate = 0.2;
        events.duplicateRate = 0.3;
        let clock = Date.now();
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache(() => clock);
        const options = { store, cache, sync: { cacheLimitBytes: 2048 } };
        let a = await device(network, options);
        const settings = a.account.deviceSettings;
        let doc = await a.create("doc-1", { a0: "0", b0: "0", s: "0" });

        network.faults = { drop: 0.15, loseAnswer: 0.15, duplicate: 0.1, timeout: 0.05 };
        const mine: Record<string, string> = {};
        const theirs: Record<string, string> = {};
        const shared = new Set<string>(["0"]);
        let reloads = 0;
        for (let step = 0; step < 30; step++) {
            clock += 2 * 60_000;
            const roll = random();
            if (roll < 0.3) {
                const key = `a${Math.floor(random() * 4)}`;
                mine[key] = `${step}`;
                doc.edit(key, `${step}`);
                await doc.save(random() < 0.3 ? "manual" : "auto");
            } else if (roll < 0.37) {
                // Unsaved: saved by a later save (or at the end).
                const key = `a${Math.floor(random() * 4)}`;
                mine[key] = `${step}`;
                doc.edit(key, `${step}`);
            } else if (roll < 0.5) {
                const key = `b${Math.floor(random() * 4)}`;
                theirs[key] = `${step}`;
                await docs.saveContentElsewhere(
                    "doc-1",
                    (current) => documentData("doc-1", { ...valuesOf(current), [key]: `${step}` }),
                    "Device B",
                );
            } else if (roll < 0.56) {
                // Both devices change the same variable: a conflict, resolved keeping mine.
                shared.add(`a${step}`).add(`b${step}`);
                doc.edit("s", `a${step}`);
                await doc.save("auto");
                await docs.saveContentElsewhere(
                    "doc-1",
                    (current) => documentData("doc-1", { ...valuesOf(current), s: `b${step}` }),
                    "Device B",
                );
            } else if (roll < 0.61) {
                // A full disk for one save: it fails, the edit stays unsaved.
                const key = `a${Math.floor(random() * 4)}`;
                mine[key] = `${step}`;
                doc.edit(key, `${step}`);
                cache.failWrites = true;
                await doc.save("auto");
                cache.failWrites = false;
            } else if (roll < 0.66) {
                await a.engine.evict();
            } else if (roll < 0.72) {
                if (!doc.isDirty) {
                    // A reload: a new tab (new client id) over the same storage and cookies.
                    await a.engine.settle();
                    a.dispose();
                    devices.splice(devices.indexOf(a), 1);
                    a = await device(network, { ...options, settings });
                    const reopened = await a.app.openDocument("doc-1", a.repository);
                    if (reopened) {
                        doc = reopened as unknown as SyncDoc;
                        reloads++;
                    } else {
                        // Offline and nothing cached yet: open once the network is back.
                        network.down = false;
                        doc = await a.open("doc-1");
                    }
                }
            } else if (roll < 0.8) {
                events.dropAll();
            } else if (roll < 0.9) {
                network.down = !network.down;
            }
            await keepMine(a);
            await sleep(random() * 15);
        }

        network.down = false;
        network.faults = {};
        events.dropRate = 0;
        events.duplicateRate = 0;
        if (doc.isDirty) await doc.save("auto");
        a.engine.refreshAll();
        try {
            const start = Date.now();
            while (
                !(a.repository.stateOf("doc-1") === "saved" && !doc.isDirty && doc.version === head().id)
            ) {
                if (Date.now() - start > 8000) throw new Error("timed out waiting for convergence");
                await keepMine(a);
                if (doc.isDirty && a.repository.stateOf("doc-1") !== "conflict") await doc.save("auto");
                await sleep(10);
            }
        } catch (error) {
            const record = await a.store.get("doc-1");
            throw new Error(
                `${error}: ${JSON.stringify({
                    state: a.repository.stateOf("doc-1"),
                    engine: a.engine.stateOf("doc-1"),
                    dirty: doc.isDirty,
                    version: doc.version,
                    head: head().id,
                    record: { ...record, localSnapshot: record?.localSnapshot?.manifestSha256 },
                    doc: doc.values,
                    server: headValues(),
                    toasts: a.toasts,
                    conflict: a.engine
                        .syncConflictOf("doc-1")
                        ?.result?.conflicts.map((x) => [x.kind, x.path]),
                })}`,
            );
        }
        await a.engine.settle();

        const record = await a.store.get("doc-1");
        expect(record?.localDirty).toBe(false);
        expect(record?.baseVersion?.id).toBe(head().id);
        const final = headValues();
        expect(doc.values).toEqual(final);
        for (const [key, value] of Object.entries({ ...mine, ...theirs })) {
            expect([key, final[key]]).toEqual([key, value]);
        }
        expect(shared.has(final["s"])).toBe(true);
        expect(Object.values(network.injected).reduce((sum, x) => sum + x, 0) + reloads).toBeGreaterThan(0);
    }, 30_000);
});

describe("review fixes", () => {
    test("a retry from a reloaded tab (new client id) resends the first attempt: replayed, one version", async () => {
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache();
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        const doc = await first.create("doc-1", { w: "10" });
        const versions = docs.documents.get("doc-1")!.versions.length;
        network.loseAnswerOnce((r) => r.method === "POST" && r.url.endsWith("/versions"), true);
        doc.edit("w", "11");
        await doc.save("manual");
        await until(() => network.injected.loseAnswer === 1, "the lost answer");
        await first.engine.settle();
        first.dispose();
        devices.splice(devices.indexOf(first), 1);
        network.down = false;

        const second = await device(network, { store, cache, settings: first.account.deviceSettings });
        const reopened = await second.open("doc-1");
        await until(() => second.repository.stateOf("doc-1") === "saved", "replayed");

        expect(docs.documents.get("doc-1")!.versions.length).toBe(versions + 1);
        expect(head().kind).toBe("manual");
        expect(reopened.version).toBe(head().id);
        const posts = server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/versions"));
        expect(new Set(posts.map((r) => r.headers["idempotency-key"])).size).toBe(1);
        expect(new Set(posts.map((r) => (r.body as { clientId: string }).clientId)).size).toBe(1);
    });

    test("idempotency_key_reused: a new key, and the version that landed is recognized", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const versions = docs.documents.get("doc-1")!.versions.length;
        a.network.loseAnswerOnce((r) => r.method === "POST" && r.url.endsWith("/versions"), true);
        doc.edit("w", "11");
        await doc.save("auto");
        await until(() => a.network.injected.loseAnswer === 1, "the lost answer");
        await a.engine.settle();
        // An attempt kept by an older client: same key, other fields.
        const record = (await a.store.get("doc-1"))!;
        await a.store.put({ ...record, attempt: { ...record.attempt!, deviceName: "renamed" } });
        a.network.down = false;
        a.engine.refreshAll();

        await until(() => a.repository.stateOf("doc-1") === "saved", "recovered");
        expect(server.requests.some((r) => r.path.endsWith("/versions") && r.method === "POST")).toBe(true);
        expect(docs.documents.get("doc-1")!.versions.length).toBe(versions + 1);
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        expect(doc.version).toBe(head().id);
    });

    test("a save that can't be stored on this device (full disk) fails as quota and changes nothing", async () => {
        const cache = new MemoryBlobCache();
        const a = await device(undefined, { cache });
        const doc = await a.create("doc-1", { w: "10" });
        cache.failWrites = true;
        doc.edit("w", "11");

        const saved = await doc.save("auto");

        expect(saved.isOk).toBe(false);
        expect(!saved.isOk && saved.error.kind).toBe("quota");
        expect(doc.isDirty).toBe(true);
        expect((await a.store.get("doc-1"))?.localDirty).toBe(false);
        cache.failWrites = false;
        await doc.save("auto");
        await until(() => headValues()["w"] === "11", "saved once there is room");
    });

    test("an unsaved-edits conflict saved meanwhile resolves as a pending one: pushed, no loop", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        doc.edit("w", "20");
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }));
        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");
        expect(a.engine.syncConflictOf("doc-1")?.local).toBe("unsaved");
        expect(AutosaveHolds.isHeld).toBe(true);

        await doc.save("manual");
        expect(a.engine.syncConflictOf("doc-1")?.local).toBe("pending");
        const path = a.engine.syncConflictOf("doc-1")!.result!.conflicts[0].path;
        expect((await a.engine.resolve("doc-1", [{ path, choice: "ours" }])).isOk).toBe(true);
        await until(() => a.repository.stateOf("doc-1") === "saved" && head().kind === "merge", "pushed");
        await sleep(30);

        expect(a.repository.stateOf("doc-1")).toBe("saved");
        expect(headValues()).toEqual({ w: "20" });
        expect(doc.isDirty).toBe(false);
        expect(AutosaveHolds.isHeld).toBe(false);
    });

    test("a manual save made while a push is in flight is pushed as manual", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;
        server.on("POST /api/documents/doc-1/versions", async (request) => {
            if (!held) {
                held = true;
                await gate;
            }
            return server.fallback!(request);
        });
        doc.edit("w", "11");
        await doc.save("auto");
        await until(() => held, "the push in flight");
        doc.edit("w", "12");
        await doc.save("manual");
        release();

        await until(
            () => headValues()["w"] === "12" && a.repository.stateOf("doc-1") === "saved",
            "both pushed",
        );
        const kinds = docs.documents.get("doc-1")!.versions.map((v) => v.kind);
        expect(kinds.slice(-2)).toEqual(["auto", "manual"]);
    });

    test("started offline from the cached user: nothing is pushed until the server confirms the session", async () => {
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache();
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        const doc = await first.create("doc-1", { w: "10" });
        network.down = true;
        doc.edit("w", "11");
        await doc.save("auto");
        first.dispose();
        devices.splice(devices.indexOf(first), 1);

        const second = await device(network, { store, cache, settings: first.account.deviceSettings });
        expect(second.account.isUnconfirmed).toBe(true);
        server.on("GET /api/me", json(401, { status: 401, code: "unauthorized" }));
        server.requests.length = 0;
        network.down = false;
        second.engine.refreshAll();
        await until(() => second.account.status === "expired", "the session checked");
        await sleep(30);

        expect(server.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
        expect(second.account.deviceSettings.lastUser()).toBeUndefined();
        expect((await store.get("doc-1"))?.localDirty).toBe(true);
    });

    test("a clean merge that breaks the model where neither side did waits as a rebuild-failure conflict", async () => {
        const nodes = [{ __cla$$__: "GroupNode", id: "n1", name: "Part", visible: true }];
        const evaluate = rs.fn(async (data: Serialized) => {
            const values = valuesOf(data);
            const broken = values["w"] === "99" && values["h"] === "6";
            return Result.ok(
                new Map(broken ? [["node/n1/rebuild", { nodeId: "n1", label: "Part", error: "boom" }]] : []),
            );
        });
        const a = await device(undefined, { sync: { evaluator: { evaluate } } });
        const doc = await a.create("doc-1", { w: "10", h: "5" }, nodes);
        a.network.down = true;
        doc.edit("h", "6");
        await doc.save("auto");
        const theirs = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "99", h: "5" }, "Bracket", nodes),
        );
        a.network.down = false;
        a.engine.refreshAll();

        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");
        expect(a.engine.syncConflictOf("doc-1")?.result?.conflicts.map((c) => c.kind)).toEqual([
            "rebuild-failure",
        ]);
        expect(head().id).toBe(theirs.id);
        expect(doc.values).toEqual({ w: "10", h: "6" });
        expect(evaluate).toHaveBeenCalled();
    });

    test("pending changes another tab let go are pushed on the next refresh", async () => {
        const store = new MemorySyncStore();
        const cache = new MemoryBlobCache();
        const network = new FlakyNetwork(server);
        const first = await device(network, { store, cache });
        const doc = await first.create("doc-1", { w: "10" });
        network.down = true;
        doc.edit("w", "11");
        await doc.save("auto");
        first.dispose();
        devices.splice(devices.indexOf(first), 1);
        network.down = false;
        const locks = new SharedLocks();
        locks.held.add("spicy3d.document.doc-1");
        const other = await device(network, { store, cache, locks: new EditLocks(locks, undefined) });
        await sleep(30);
        expect(headValues()).toEqual({ w: "10" });

        locks.held.delete("spicy3d.document.doc-1");
        other.engine.refreshAll();
        await until(() => headValues()["w"] === "11", "pushed by this tab");
    });

    test("a closed document in conflict lets its lock go (resumed when opened again)", async () => {
        const locks = new SharedLocks();
        const a = await device(undefined, { locks: new EditLocks(locks, undefined) });
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "20");
        await doc.save("auto");
        await doc.close({ discardChanges: true });
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }));
        a.network.down = false;
        a.engine.refreshAll();

        await until(() => a.repository.stateOf("doc-1") === "conflict", "conflict");
        await until(() => !locks.held.has("spicy3d.document.doc-1"), "the lock let go");
        expect((await a.store.get("doc-1"))?.localDirty).toBe(true);
        await sleep(30);
        expect(locks.held.has("spicy3d.document.doc-1")).toBe(false);
    });

    test("another device saving this device's unanswered content is not taken for this device's push", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10", h: "5" });
        const base = head().id;
        a.network.down = true;
        doc.edit("w", "11");
        await doc.save("auto");
        await until(() => a.repository.stateOf("doc-1") === "offline", "offline");
        await docs.saveContentElsewhere("doc-1", doc.serialize(), "Tablet");
        const theirs = await docs.saveContentElsewhere(
            "doc-1",
            documentData("doc-1", { w: "11", h: "7" }),
            "Tablet",
        );
        a.network.down = false;
        a.engine.refreshAll();

        await until(() => head().kind === "merge" && a.repository.stateOf("doc-1") === "saved", "merged");
        expect(head().parentIds).toEqual([theirs.id, base]);
        expect(headValues()).toEqual({ w: "11", h: "7" });
    });
});
