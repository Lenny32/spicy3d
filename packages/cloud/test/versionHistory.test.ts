// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type BannerOptions,
    type CloseDocumentOptions,
    type DocumentSource,
    decodeDocumentFile,
    formatDateTime,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    type IView,
    PubSub,
    parseUtc,
    repositoryErrorMessage,
    type SaveKind,
    type Serialized,
    SidePanels,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import type { Account } from "../src/account/account";
import { CloudConnection } from "../src/cloud";
import { MemoryBlobCache } from "../src/documents/blobCache";
import { CloudDocuments } from "../src/documents/cloudDocuments";
import { EditLocks } from "../src/documents/editLocks";
import { CloudDocumentRepository } from "../src/documents/repository";
import { DocumentStatusItem } from "../src/documents/statusItem";
import { VersionHistoryPanel } from "../src/history/historyPanel";
import { previewOf, VersionPreviewRepository } from "../src/history/previewRepository";
import { PREVIEW_BANNER_ID, type UnsavedBeforeRestore, VersionHistory } from "../src/history/versionHistory";
import { CONFIG, FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeServer, problem, signedInAccount, TestRequest } from "./_helpers/fakeServer";

let published: [string, unknown[]][];

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

beforeEach(() => {
    published = [];
    rs.spyOn(PubSub.default, "pub").mockImplementation((event: string, ...args: unknown[]) => {
        published.push([event, args]);
    });
});

afterEach(() => {
    rs.restoreAllMocks();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
    SidePanels.items.clear();
});

function node(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { __cla$$__: "BoxNode", id, name, visible: true, parentId: "root", ...extra };
}

function documentData(nodes: object[], formatVersion = 1): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion,
        moduleVersions: {},
        id: "doc-1",
        name: "Bracket",
        models: {
            components: [],
            materials: [],
            nodes: [{ __cla$$__: "FolderNode", id: "root", name: "Bracket", visible: true }, ...nodes],
        },
        variables: [],
        acts: [],
        userData: {},
    } as unknown as Serialized;
}

/** An open document as far as the history uses it; it saves through its repository. */
class FakeDocument {
    isDirty = false;
    closed: CloseDocumentOptions[] = [];
    saves: SaveKind[] = [];
    version?: string;
    /** The undo position (`history.position()`): a new object = an edit. */
    position: object = {};
    readonly history = { position: () => this.position };
    constructor(
        readonly application: IApplication,
        readonly id: string,
        public name: string,
        public repository: IDocumentRepository,
        public data: Serialized,
    ) {}
    serialize() {
        return this.data;
    }
    async save(kind: SaveKind = "manual") {
        this.saves.push(kind);
        const saved = await this.repository.save({
            id: this.id,
            name: this.name,
            data: this.data,
            kind,
            baseVersion: this.version,
        });
        if (saved.isOk && saved.value.status === "saved") {
            this.version = saved.value.version;
            this.isDirty = false;
        }
        return saved;
    }
    async settled() {}
    async close(options: CloseDocumentOptions = {}) {
        this.closed.push(options);
        this.application.documents.delete(this as unknown as IDocument);
        return true;
    }
    onPropertyChanged() {}
    removePropertyChanged() {}
}

const V1 = [node("box", "Box 1", { dx: 10 })];
const V2 = [node("box", "Box 1", { dx: 15 }), node("sketch", "Sketch 1")];

async function setup(options: { ask?: UnsavedBeforeRestore; askAfter?: UnsavedBeforeRestore } = {}) {
    const server = new FakeServer();
    const account = await signedInAccount(server);
    account.deviceSettings.deviceName = "Desk – Firefox";
    const docs = new FakeDocumentServer(server);
    const repository = new CloudDocumentRepository({
        account,
        config: CONFIG,
        cache: new MemoryBlobCache(),
        clientId: "tab-1",
        encodeThumbnail: async () => undefined,
        createObjectUrl: (blob) => `blob:${blob.size}`,
    });
    const first = await repository.save({
        id: "doc-1",
        name: "Bracket",
        data: documentData(V1),
        kind: "manual",
    });
    const v1 = docs.head("doc-1")!;
    await repository.save({
        id: "doc-1",
        name: "Bracket",
        data: documentData(V2),
        kind: "manual",
        baseVersion: first.isOk && first.value.status === "saved" ? first.value.version : undefined,
    });
    const v2 = docs.head("doc-1")!;

    const app = createMockApplication();
    const loaded: { data: Serialized; source?: DocumentSource }[] = [];
    const opened: string[] = [];
    const add = (id: string, name: string, repo: IDocumentRepository, data: Serialized) => {
        const doc = new FakeDocument(app, id, name, repo, data);
        app.documents.add(doc as unknown as IDocument);
        app.activeView = { document: doc, toImage: () => undefined } as unknown as IView;
        return doc;
    };
    app.loadDocument = async (data, source) => {
        loaded.push({ data, source });
        return add(data["id"], data["name"], source!.repository!, data) as unknown as IDocument;
    };
    app.openDocument = async (id, repo) => {
        opened.push(id);
        const content = await repo!.load(id);
        const doc = add(id, "Bracket", repo!, content.isOk ? content.value.data : documentData([]));
        doc.version = content.isOk ? content.value.version : undefined;
        return doc as unknown as IDocument;
    };
    const open = add("doc-1", "Bracket", repository, documentData(V2));
    open.version = v2.id;

    const asked: string[] = [];
    const stages: string[] = [];
    const history = new VersionHistory({
        app,
        repository,
        documentId: "doc-1",
        name: () => "Bracket",
        askUnsaved: async (name, stage) => {
            asked.push(name);
            stages.push(stage);
            return (stage === "after" ? options.askAfter : options.ask) ?? "cancel";
        },
    });
    server.requests.length = 0;
    return { server, docs, repository, app, history, open, v1, v2, loaded, opened, asked, stages };
}

const banners = () =>
    published.filter(([event]) => event === "showBanner").map(([, args]) => args[0] as BannerOptions);

describe("listing", () => {
    test("pages newest first with the server's cursor until the last page", async () => {
        const { repository, docs, v1, v2 } = await setup();
        const v3 = docs.addVersion("doc-1");

        const page1 = await repository.listVersions("doc-1", { limit: 2 });
        expect(page1.isOk && page1.value.items.map((v) => v.id)).toEqual([v3.id, v2.id]);
        const cursor = page1.isOk ? page1.value.nextCursor : undefined;
        expect(cursor).toBe(v2.id);

        const page2 = await repository.listVersions("doc-1", { cursor, limit: 2 });
        expect(page2.isOk && page2.value.items.map((v) => v.id)).toEqual([v1.id]);
        expect(page2.isOk && page2.value.nextCursor).toBeUndefined();
    });

    test("a version's content is downloaded on demand, then read from the cache", async () => {
        const { repository, server, v1 } = await setup();
        const fresh = new CloudDocumentRepository({ ...repository.options, cache: new MemoryBlobCache() });

        const first = await fresh.loadVersion(v1);
        expect(first.isOk && (first.value["models"] as { nodes: unknown[] }).nodes).toHaveLength(2);
        expect(server.calls).toContain(`GET /api/versions/${v1.id}`);

        server.requests.length = 0;
        const again = await fresh.loadVersion(v1);
        expect(again.isOk).toBe(true);
        expect(server.calls).toEqual([]);
    });

    test("an unknown document is `notFound`", async () => {
        const { repository } = await setup();

        const listed = await repository.listVersions("nope");

        expect(!listed.isOk && listed.error).toEqual({ kind: "notFound", id: "nope" });
    });
});

describe("panel", () => {
    async function panelWith(pageSize = 50) {
        const ctx = await setup();
        const panel = new VersionHistoryPanel({
            history: ctx.history,
            retention: CONFIG.storage.autosaveRetention,
            onClose: rs.fn(() => {}),
            pageSize,
        });
        document.body.append(panel);
        await panel.loadMore();
        return { ...ctx, panel };
    }

    const rows = (panel: HTMLElement) =>
        Array.from(panel.querySelectorAll<HTMLElement>("[data-version-id]")).map(
            (x) => x.dataset["versionId"],
        );

    test("lists the versions with kind, device and local time; consecutive autosaves fold and expand", async () => {
        const { panel, docs, v1, v2 } = await panelWith();
        const autos = [docs.addVersion("doc-1"), docs.addVersion("doc-1"), docs.addVersion("doc-1")];
        const head = docs.addVersion("doc-1", { kind: "manual", deviceName: "Laptop – Chrome" });
        await panel.reload();

        expect(rows(panel)).toEqual([head.id, v2.id, v1.id]);
        const fold = panel.querySelector<HTMLButtonElement>("[data-autosaves]");
        expect(fold).not.toBeNull();
        expect(fold!.textContent).toBe("cloud.history.autosaves3");
        expect(fold!.dataset["autosaves"]).toBe("3");

        const headRow = panel.querySelector<HTMLElement>(`[data-version-id="${head.id}"]`)!;
        expect(headRow.dataset["kind"]).toBe("manual");
        expect(headRow.textContent).toContain("Laptop – Chrome");
        expect(headRow.textContent).toContain("cloud.history.current");
        const time = headRow.querySelector<HTMLElement>("[data-relative-time]");
        expect(time).not.toBeNull();
        expect(time!.title).not.toBe("");

        fold!.click();
        expect(rows(panel)).toEqual([head.id, ...autos.map((x) => x.id).reverse(), v2.id, v1.id]);
        expect(panel.querySelector("[data-autosaves]")!.getAttribute("aria-expanded")).toBe("true");
        expect(panel.textContent).toContain("cloud.history.retention24730");
    });

    test("“Manual only” hides the unnamed autosaves", async () => {
        const { panel, docs, v1, v2 } = await panelWith();
        const named = docs.addVersion("doc-1", { label: "Sent to supplier" });
        docs.addVersion("doc-1");
        const head = docs.addVersion("doc-1", { kind: "manual" });
        docs.addVersion("doc-1");
        await panel.reload();
        const filter = panel.querySelector<HTMLInputElement>("[data-filter=manualOnly]")!;
        expect(filter).not.toBeNull();

        filter.checked = true;
        filter.dispatchEvent(new Event("change"));

        expect(rows(panel)).toEqual([head.id, named.id, v2.id, v1.id]);
        expect(panel.textContent).toContain("Sent to supplier");
    });

    test("more pages load on “Load more” and on scrolling to the end", async () => {
        const { panel, docs, server } = await panelWith(2);
        for (let i = 0; i < 4; i++) docs.addVersion("doc-1", { kind: "manual" });
        await panel.reload();
        expect(rows(panel)).toHaveLength(2);
        expect(panel.hasMore).toBe(true);

        const more = Array.from(panel.querySelectorAll("button")).find(
            (b) => b.textContent === "cloud.history.loadMore",
        );
        expect(more).toBeInstanceOf(HTMLButtonElement);
        more!.click();
        await panel.loadMore(); // shares the load the click started
        expect(rows(panel)).toHaveLength(4);

        server.requests.length = 0;
        const list = panel.querySelector<HTMLElement>("[data-list]")!;
        expect(list).not.toBeNull();
        list.dispatchEvent(new Event("scroll")); // Happy-DOM: 0 + 0 >= 0 - margin, i.e. at the end
        await panel.loadMore();
        expect(rows(panel)).toHaveLength(6);
        expect(panel.hasMore).toBe(false);
        expect(server.calls).toEqual(["GET /api/documents/doc-1/versions"]);
        expect(server.requests[0].search).toContain("limit=2");
    });

    test("with “Manual only”, pages of autosaves only are read through until a row shows", async () => {
        const { panel, docs, v2 } = await panelWith(2);
        for (let i = 0; i < 5; i++) docs.addVersion("doc-1");
        await panel.reload();
        const filter = panel.querySelector<HTMLInputElement>("[data-filter=manualOnly]")!;
        filter.checked = true;
        filter.dispatchEvent(new Event("change"));
        expect(rows(panel)).toEqual([]);

        await panel.loadMore();

        expect(rows(panel)).toEqual([v2.id]);
    });

    test("a merge is one row: “merged changes from” the device of the head it merged", async () => {
        const { panel, docs, v2 } = await panelWith();
        const theirs = docs.addVersion("doc-1", { kind: "manual", deviceName: "Laptop – Chrome" });
        const merge = docs.addVersion("doc-1", { kind: "merge", parentIds: [theirs.id, v2.id] });
        await panel.reload();

        const row = panel.querySelector<HTMLElement>(`[data-version-id="${merge.id}"]`)!;
        expect(row).not.toBeNull();
        expect(row.textContent).toContain("cloud.history.mergedFromLaptop – Chrome");
        expect(panel.querySelectorAll(`[data-version-id="${merge.id}"]`)).toHaveLength(1);
    });

    test("a version of a newer format offers no preview nor restore, and says why", async () => {
        const { panel, docs } = await panelWith();
        const newer = docs.addVersion("doc-1", { kind: "manual", formatVersion: 99 });
        await panel.reload();

        panel.querySelector<HTMLButtonElement>(`[data-version-id="${newer.id}"] button`)!.click();

        const row = panel.querySelector<HTMLElement>(`[data-version-id="${newer.id}"]`)!;
        expect(row.textContent).toContain("cloud.history.needsUpdate");
        const button = (action: string) => row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
        expect(button("preview").disabled).toBe(true);
        expect(button("restore").disabled).toBe(true);
        expect(button("name").disabled).toBe(false);
    });

    test("“Name this version” sends the label; a labeled autosave survives pruning (mocked SRV-06)", async () => {
        const { panel, docs, server } = await panelWith();
        const named = docs.addVersion("doc-1", { createdAt: "2026-09-20T08:00:00Z" });
        const unnamed = docs.addVersion("doc-1", { createdAt: "2026-09-20T09:00:00Z" });
        docs.addVersion("doc-1", { kind: "manual" });
        await panel.reload();
        server.requests.length = 0;

        const asking = panel.askLabel(panel.loaded.find((v) => v.id === named.id)!);
        const dialog = document.querySelector("dialog")!;
        expect(dialog).not.toBeNull();
        dialog.querySelector<HTMLInputElement>("input[name=label]")!.value = "  Sent to supplier ";
        dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
        await asking;

        expect(server.requests.map((r) => [`${r.method} ${r.path}`, r.body])).toEqual([
            [`PATCH /api/versions/${named.id}`, { label: "Sent to supplier", pinned: null }],
        ]);
        expect(panel.loaded.find((v) => v.id === named.id)!.label).toBe("Sent to supplier");
        expect(panel.querySelector(`[data-version-id="${named.id}"]`)!.textContent).toContain(
            "Sent to supplier",
        );

        const pruned = docs.pruneAutosaves("doc-1", 24, Date.parse("2026-09-27T12:00:00Z"));
        await panel.reload();
        expect(pruned).toEqual([unnamed.id]);
        expect(panel.loaded.map((v) => v.id)).toContain(named.id);
        expect(panel.loaded.map((v) => v.id)).not.toContain(unnamed.id);
    });

    test("a restore (from the panel or the preview banner) reloads the list with the new head on top", async () => {
        const { panel, history, v1, v2 } = await panelWith();

        await history.restore(v1);
        await rs.waitFor(() => expect(panel.loaded).toHaveLength(3));

        const head = panel.loaded[0];
        expect(head.kind).toBe("restore");
        expect(rows(panel)).toEqual([head.id, v2.id, v1.id]);
        const headRow = panel.querySelector<HTMLElement>(`[data-version-id="${head.id}"]`)!;
        expect(headRow.textContent).toContain("cloud.history.current");
    });

    test("a list shorter than the panel loads on until it fills or ends — bounded, no recursion", async () => {
        const ctx = await setup();
        for (let i = 0; i < 5; i++) ctx.docs.addVersion("doc-1", { kind: "manual" });
        const panel = new VersionHistoryPanel({
            history: ctx.history,
            retention: CONFIG.storage.autosaveRetention,
            onClose: () => {},
            pageSize: 2,
        });
        const list = panel.querySelector<HTMLElement>("[data-list]")!;
        // Laid out, and always shorter than the panel (a real browser with a tall panel).
        Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 500 });
        Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 100 });
        ctx.server.requests.length = 0;

        document.body.append(panel); // starts the first load
        await rs.waitFor(() => expect(panel.hasMore).toBe(false));

        // 7 versions, 2 per page: exactly 4 requests.
        expect(ctx.server.calls).toEqual(Array(4).fill("GET /api/documents/doc-1/versions"));
        expect(panel.loaded).toHaveLength(7);
        panel.remove();
    });

    test("a reload during a load: the stale load neither ends the new one nor duplicates rows", async () => {
        const ctx = await setup();
        const panel = new VersionHistoryPanel({
            history: ctx.history,
            retention: CONFIG.storage.autosaveRetention,
            onClose: () => {},
        });
        const gates: (() => void)[] = [];
        const listVersions = ctx.repository.listVersions.bind(ctx.repository);
        const list = rs.spyOn(ctx.repository, "listVersions").mockImplementation(async (id, query) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return listVersions(id, query);
        });

        const stale = panel.loadMore();
        void panel.reload();
        expect(list).toHaveBeenCalledTimes(2);
        gates[0]();
        await stale;
        void panel.loadMore(); // the reload's load still runs: shared, no third request
        expect(list).toHaveBeenCalledTimes(2);
        gates[1]();
        await rs.waitFor(() => expect(panel.loaded).toHaveLength(2));

        expect(new Set(panel.loaded.map((v) => v.id)).size).toBe(2);
    });

    test("pin and unpin", async () => {
        const { panel, docs, server } = await panelWith();
        const auto = docs.addVersion("doc-1");
        docs.addVersion("doc-1", { kind: "manual" });
        await panel.reload();
        server.requests.length = 0;

        await panel.update(panel.loaded.find((v) => v.id === auto.id)!, { pinned: true });

        expect(server.requests[0].body).toEqual({ label: null, pinned: true });
        expect(docs.documents.get("doc-1")!.versions.find((v) => v.id === auto.id)!.pinned).toBe(true);
        expect(panel.querySelector(`[data-version-id="${auto.id}"]`)!.textContent).toContain(
            "cloud.history.pinned",
        );
    });
});

describe("preview", () => {
    test("opens the version as a separate read-only document; the open one is untouched", async () => {
        const { history, loaded, open, v1, app, server } = await setup();
        open.isDirty = true;

        const shown = await history.showPreview(v1);

        expect(shown.isOk).toBe(true);
        expect(loaded).toHaveLength(1);
        const { data, source } = loaded[0];
        expect(data["id"]).not.toBe("doc-1");
        expect(data["name"]).toBe(
            `cloud.history.versionNameBracket${formatDateTime(parseUtc(v1.createdAt))}`,
        );
        expect((data["models"] as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual([
            "root",
            "box",
        ]);
        expect(source?.repository).toBeInstanceOf(VersionPreviewRepository);
        expect(source?.version).toBe(v1.id);
        expect(app.documents.has(open as unknown as IDocument)).toBe(true);
        expect(open.closed).toEqual([]);
        expect(open.isDirty).toBe(true);
        // Saved from this tab: the manifest and blobs come from the cache.
        expect(server.calls).toEqual([]);
    });

    test("can't overwrite the head: saving is refused, autosave skips it (read-only), nothing is sent", async () => {
        const { history, v1, server, docs, v2 } = await setup();
        const shown = await history.showPreview(v1);
        expect(shown.isOk).toBe(true);
        const preview = shown.isOk ? (shown.value as unknown as FakeDocument) : undefined;
        const repository = previewOf(preview as unknown as IDocument)!;
        expect(repository.isReadOnly()).toBe(true);
        server.requests.length = 0;

        const manual = await preview!.save("manual");
        const auto = await preview!.save("auto");

        expect(!manual.isOk && manual.error).toEqual({ kind: "readOnly", reason: "preview" });
        expect(!auto.isOk && auto.error).toEqual({ kind: "readOnly", reason: "preview" });
        expect(repositoryErrorMessage({ kind: "readOnly", reason: "preview" })).toEqual([
            "error.repository.readOnlyPreview",
        ]);
        expect(server.requests.filter((r) => r.method !== "GET")).toEqual([]);
        expect(docs.head("doc-1")!.id).toBe(v2.id);
        expect((await repository.load("doc-1")).isOk).toBe(false);
    });

    test("the banner says which version is shown, with Restore / Back to latest", async () => {
        const { history, v1, app, open } = await setup();

        await history.showPreview(v1);

        const banner = banners().at(-1)!;
        expect(banner).toMatchObject({
            id: PREVIEW_BANNER_ID,
            message: "cloud.history.viewing{0}",
            dismissible: false,
        });
        expect(banner.actions!.map((a) => a.label)).toEqual([
            "cloud.history.restore",
            "cloud.history.backToLatest",
        ]);

        const openView = { document: open } as unknown as IView;
        app.views.push(openView);
        banner.actions![1].run();
        await rs.waitFor(() => expect(history.previewDocument).toBeUndefined());
        expect(app.activeView).toBe(openView);
        expect(published.some(([e, args]) => e === "hideBanner" && args[0] === PREVIEW_BANNER_ID)).toBe(true);
    });

    test("a version of a newer format says “needs a newer Spicy3D” without downloading anything", async () => {
        const { history, docs, server, loaded } = await setup();
        const newer = docs.addVersion("doc-1", { formatVersion: 2 });
        server.requests.length = 0;

        const shown = await history.showPreview(newer);

        expect(!shown.isOk && shown.error.message).toBe("cloud.history.needsUpdate");
        expect(server.requests).toEqual([]);
        expect(loaded).toEqual([]);
    });
});

describe("restore", () => {
    test("creates a new head (kind restore, parent = the head) with that content; the previous head stays", async () => {
        const { history, v1, v2, docs, server, open, opened } = await setup();

        const restored = await history.restore(v1);

        expect(restored.isOk).toBe(true);
        const head = docs.head("doc-1")!;
        expect(restored.isOk && restored.value?.version.id).toBe(head.id);
        expect(restored.isOk && restored.value?.onTopOf).toBeUndefined();
        expect(head).toMatchObject({
            kind: "restore",
            parentIds: [v2.id],
            manifestSha256: v1.manifestSha256,
        });
        expect(docs.documents.get("doc-1")!.versions.map((v) => v.id)).toEqual([v1.id, v2.id, head.id]);
        const post = server.requests.find((r) => r.method === "POST")!;
        expect(post.headers["if-match"]).toBe(`"${v2.id}"`);
        expect(post.body).toMatchObject({
            kind: "restore",
            parentIds: [v2.id],
            deviceName: "Desk – Firefox",
        });
        // Referenced, not uploaded again.
        expect(server.requests.filter((r) => r.method === "PUT")).toEqual([]);
        // The open document reloads at the new head.
        expect(open.closed).toEqual([{ discardChanges: true }]);
        expect(opened).toEqual(["doc-1"]);
    });

    test("another save moving the head in between: the restore goes on top of that one", async () => {
        const { history, v1, docs, server } = await setup();
        const elsewhere = await docs.saveElsewhere("doc-1");
        let first = true;
        server.on("POST /api/documents/doc-1/versions", (request) => {
            if (!first) return server.fallback!(request);
            first = false;
            return problem(409, "version_conflict", {
                headVersionId: elsewhere.id,
                headDeviceName: elsewhere.deviceName,
                headCreatedAt: elsewhere.createdAt,
            });
        });

        const restored = await history.restoreAndReport(v1);

        expect(restored).toBe(true);
        expect(docs.head("doc-1")).toMatchObject({ kind: "restore", parentIds: [elsewhere.id] });
        // Not silent: the user learns it went on top of another device's newer save.
        expect(published).toContainEqual([
            "showToast",
            ["cloud.history.restoredOnTop{0}{1}", "Laptop – Chrome", expect.any(String)],
        ]);
        const keys = server.requests
            .filter((r) => r.method === "POST")
            .map((r) => r.headers["idempotency-key"]);
        expect(new Set(keys).size).toBe(2);
    });

    test("unsaved changes in the open document, “Cancel”: nothing is saved nor restored", async () => {
        const { history, v1, open, asked, docs } = await setup({ ask: "cancel" });
        open.isDirty = true;

        const restored = await history.restore(v1);

        expect(asked).toEqual(["Bracket"]);
        expect(restored.isOk && restored.value).toBeUndefined();
        expect(open.saves).toEqual([]);
        expect(open.closed).toEqual([]);
        expect(docs.documents.get("doc-1")!.versions).toHaveLength(2);
    });

    test.each([
        ["discard", [], 3],
        ["saveFirst", ["manual"], 4],
    ] as const)("unsaved changes in the open document, %s: restored on top", async (choice, saves, count) => {
        const { history, v1, open, asked, docs } = await setup({ ask: choice });
        open.isDirty = true;
        open.data = documentData([node("box", "Box 1", { dx: 99 })]);

        const restored = await history.restore(v1);

        expect(asked).toEqual(["Bracket"]);
        expect(restored.isOk).toBe(true);
        expect(open.saves).toEqual(saves);
        const all = docs.documents.get("doc-1")!.versions;
        expect(all).toHaveLength(count);
        expect(all.at(-1)).toMatchObject({ kind: "restore", parentIds: [all.at(-2)!.id] });
        expect(open.closed).toEqual([{ discardChanges: true }]);
    });

    test("a second restore while one runs (a double click) shares it: one new version, one reopen", async () => {
        const { history, v1, docs, opened, open } = await setup();
        const first = history.restore(v1);
        // No buttons on the banner meanwhile.
        const second = history.restore(v1);

        expect(second).toBe(first);
        const [a, b] = await Promise.all([first, second]);
        expect(a).toBe(b);
        expect(docs.documents.get("doc-1")!.versions.filter((v) => v.kind === "restore")).toHaveLength(1);
        expect(opened).toEqual(["doc-1"]);
        expect(open.closed).toEqual([{ discardChanges: true }]);
    });

    test("the preview banner offers no buttons while a restore runs", async () => {
        const { history, v1, v2 } = await setup();
        await history.showPreview(v1);
        published.length = 0;

        const restoring = history.restore(v2);
        const during = banners().at(-1)!;
        await restoring;

        expect(during.id).toBe(PREVIEW_BANNER_ID);
        expect(during.actions).toEqual([]);
    });

    test.each([
        ["saveFirst", 1, false],
        ["discard", 0, false],
        ["cancel", 0, true],
    ] as const)("edited again while restoring (%s): asked again, never dropped silently", async (choice, copies, keptOpen) => {
        const { history, v1, open, repository, docs, stages, opened } = await setup({ askAfter: choice });
        const restoreVersion = repository.restoreVersion.bind(repository);
        rs.spyOn(repository, "restoreVersion").mockImplementation(async (id, version) => {
            const restored = await restoreVersion(id, version);
            open.isDirty = true;
            open.position = {}; // an edit while the restore ran
            return restored;
        });

        const restored = await history.restore(v1);

        expect(restored.isOk).toBe(true);
        expect(stages).toEqual(["after"]);
        expect([...docs.documents.keys()].filter((id) => id !== "doc-1")).toHaveLength(copies);
        expect(open.closed).toEqual(keptOpen ? [] : [{ discardChanges: true }]);
        expect(opened).toEqual(keptOpen ? [] : ["doc-1"]);
    });

    test("refused while another tab edits the document", async () => {
        const { history, v1, repository, docs } = await setup();
        (repository.options as { editGuard?: { isReadOnly: () => boolean } }).editGuard = {
            isReadOnly: () => true,
        };

        const restored = await history.restore(v1);

        expect(!restored.isOk && restored.error.message).toBe("cloud.history.restoreReadOnly");
        expect(docs.documents.get("doc-1")!.versions).toHaveLength(2);
    });
});

describe("preview races", () => {
    test("a newer preview wins: the older one, still loading, is closed and reports nothing", async () => {
        const { history, v1, v2, app } = await setup();

        const [older, newer] = await Promise.all([history.showPreview(v1), history.showPreview(v2)]);

        expect(!older.isOk && older.error.cancelled).toBe(true);
        expect(newer.isOk).toBe(true);
        const previews = [...app.documents].filter((x) => previewOf(x));
        expect(previews).toHaveLength(1);
        expect(previewOf(previews[0])!.version.id).toBe(v2.id);
        expect(history.previewed?.id).toBe(v2.id);
    });

    test("the history closing while a preview loads: the loaded document is closed, the banner hidden", async () => {
        const { history, v1, app, repository } = await setup();
        const loadVersion = repository.loadVersion.bind(repository);
        rs.spyOn(repository, "loadVersion").mockImplementation(async (version) => {
            const data = await loadVersion(version);
            history.dispose();
            return data;
        });

        const shown = await history.showPreview(v1);

        expect(!shown.isOk && shown.error.cancelled).toBe(true);
        expect([...app.documents].filter((x) => previewOf(x))).toEqual([]);
        expect(published.filter(([e]) => e === "showBanner")).toEqual([]);
        expect(published).toContainEqual(["hideBanner", [PREVIEW_BANNER_ID]]);
    });
});

describe("copies and compare", () => {
    test("“Save as new document” creates a cloud document with a new id and opens it", async () => {
        const { history, v1, docs, opened } = await setup();

        const saved = await history.saveAsNew(v1);

        expect(saved.isOk).toBe(true);
        const id = saved.isOk ? saved.value : "";
        expect(id).not.toBe("doc-1");
        const copy = docs.documents.get(id)!;
        expect(copy.name).toBe(`cloud.history.versionNameBracket${formatDateTime(parseUtc(v1.createdAt))}`);
        expect(copy.versions).toHaveLength(1);
        expect(copy.versions[0].parentIds).toEqual([]);
        expect(docs.documents.get("doc-1")!.versions).toHaveLength(2);
        expect(opened).toEqual([id]);
    });

    test("“Download” writes the version as a .spicy file", async () => {
        const { history, v1 } = await setup();
        const blobs: Blob[] = [];
        rs.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
            blobs.push(blob as Blob);
            return "blob:x";
        });
        rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const names: string[] = [];
        rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            names.push(this.download);
        });

        const downloaded = await history.download(v1);

        expect(downloaded.isOk).toBe(true);
        expect(names).toEqual([`Bracket ${v1.createdAt.slice(0, 10)}.spicy`]);
        const decoded = await decodeDocumentFile(blobs[0]);
        expect(decoded.isOk && (decoded.value["models"] as { nodes: unknown[] }).nodes).toHaveLength(2);
    });

    test("compare with previous and with current go through the registered differ", async () => {
        const { history, v1, v2, open } = await setup();

        const previous = await history.compareVersions(v1, v2);
        expect(previous.isOk && previous.value.map((c) => [c.kind, c.target])).toEqual([
            ["modified", "node/box/prop/dx"],
            ["added", "node/sketch"],
        ]);

        open.data = documentData([node("box", "Bolt", { dx: 15 }), node("sketch", "Sketch 1")]);
        const current = await history.compareWithCurrent(v1, v2);
        expect(current.isOk && current.value.map((c) => [c.kind, c.target])).toEqual([
            ["renamed", "node/box/prop/name"],
            ["modified", "node/box/prop/dx"],
            ["added", "node/sketch"],
        ]);
    });
});

describe("entry points", () => {
    async function withCloudDocuments() {
        const ctx = await setup();
        const connection = new CloudConnection(CONFIG, ctx.server.client());
        (connection as { account: Account }).account = ctx.repository.account;
        ctx.app.repositories.cloud = undefined;
        const documents = new CloudDocuments(connection, ctx.app, {
            cache: new MemoryBlobCache(),
            locks: new EditLocks(undefined, undefined),
            repository: { encodeThumbnail: async () => undefined },
            titleBar: false,
        });
        const cloud = documents.cloud!;
        ctx.open.repository = cloud;
        return { ...ctx, documents, cloud };
    }

    test("“Version history” docks one panel next to the viewport; closing it closes its preview", async () => {
        const { documents, open, app, v1 } = await withCloudDocuments();

        const panel = documents.openHistory(open as unknown as IDocument)!;
        expect(panel).toBeInstanceOf(VersionHistoryPanel);
        expect(SidePanels.items.length).toBe(1);
        expect(documents.openHistory(open as unknown as IDocument)).toBe(panel);
        expect(SidePanels.items.length).toBe(1);

        const shown = await panel.history.showPreview(v1);
        const preview = shown.isOk ? shown.value : undefined;
        expect(preview && app.documents.has(preview)).toBe(true);
        // The preview's own status opens the same history.
        expect(documents.openHistory(preview!)).toBe(panel);

        await documents.closeHistory();
        expect(SidePanels.items.length).toBe(0);
        expect(preview && app.documents.has(preview)).toBe(false);
        documents.dispose();
    });

    test("a local document has no history", async () => {
        const { documents, open, app } = await withCloudDocuments();
        open.repository = app.repositories.local;

        expect(documents.openHistory(open as unknown as IDocument)).toBeUndefined();
        expect(SidePanels.items.length).toBe(0);
        documents.dispose();
    });

    test("the title bar has a history button for cloud documents and a read-only status for a preview", async () => {
        const { app, open, cloud, history, v1 } = await withCloudDocuments();
        const openHistory = rs.fn((_document: IDocument) => {});
        const item = new DocumentStatusItem({
            app,
            locks: new EditLocks(undefined, undefined),
            repository: () => cloud,
            takeOver: async () => {},
            openHistory,
        });
        app.activeView = { document: open } as unknown as IView;
        document.body.append(item);
        try {
            item.querySelector<HTMLButtonElement>("[data-action=history]")!.click();
            expect(openHistory.mock.calls).toEqual([[open]]);

            const shown = await history.showPreview(v1);
            expect(shown.isOk).toBe(true);
            item.render();
            expect(item.querySelector<HTMLElement>("[data-status]")!.dataset["status"]).toBe("preview");
            expect(item.textContent).toContain("cloud.status.preview");
            expect(item.querySelector("[data-location]")).toBeNull();
        } finally {
            item.remove();
        }
    });
});
