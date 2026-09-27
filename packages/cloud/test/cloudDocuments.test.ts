// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AutosaveStatus,
    type CloseDocumentOptions,
    formatTime,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    PubSub,
    Result,
    type SaveConflict,
    type SaveKind,
    type SaveOutcome,
    TitleBar,
} from "@spicy3d/core";
import { createMockApplication, MemoryDocumentRepository } from "@spicy3d/core/test-utils";
import type { Account } from "../src/account/account";
import { CloudConnection } from "../src/cloud";
import { MemoryBlobCache } from "../src/documents/blobCache";
import { CloudDocuments, keepMineChoice } from "../src/documents/cloudDocuments";
import { conflictMessage, showConflictDialog } from "../src/documents/conflictDialog";
import { EditLocks, type LockManagerLike } from "../src/documents/editLocks";
import { CloudDocumentRepository } from "../src/documents/repository";
import { DocumentStatusItem, documentStatus } from "../src/documents/statusItem";
import { CONFIG, FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeServer, json, signedInAccount, TestRequest } from "./_helpers/fakeServer";

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
});

/** An open document as far as the cloud code uses it. */
class FakeOpenDocument {
    name = "Bracket";
    version?: string;
    isDirty = false;
    closed: CloseDocumentOptions[] = [];
    saves: SaveKind[] = [];
    nextSave: Result<SaveOutcome, never> = Result.ok({ status: "saved", updatedAt: 1, version: "v-new" });
    constructor(
        readonly id: string,
        public repository: IDocumentRepository,
        readonly application: IApplication,
    ) {}
    serialize() {
        return { __cla$$__: "Document", formatVersion: 1, id: this.id, name: this.name, models: {} };
    }
    readonly events: string[] = [];
    async save(kind: SaveKind = "manual") {
        this.saves.push(kind);
        this.events.push(`save:${kind}`);
        return this.nextSave;
    }
    async settled() {
        this.events.push("settled");
    }
    async close(options: CloseDocumentOptions = {}) {
        this.closed.push(options);
        this.application.documents.delete(this as unknown as IDocument);
        return true;
    }
    onPropertyChanged() {}
    removePropertyChanged() {}
}

function openDocument(app: IApplication, id: string, repository: IDocumentRepository) {
    const doc = new FakeOpenDocument(id, repository, app);
    app.documents.add(doc as unknown as IDocument);
    return doc;
}

/** Web Locks where every name is taken by another tab. */
const takenLocks: LockManagerLike = {
    request: async (_name, _options, callback) => callback(null),
};

async function setup(options: { keepOfflineCopies?: boolean; locks?: EditLocks } = {}) {
    const server = new FakeServer();
    const account = await signedInAccount(server, options.keepOfflineCopies);
    const docs = new FakeDocumentServer(server);
    const app = createMockApplication();
    const cache = new MemoryBlobCache();
    const connection = new CloudConnection(CONFIG, server.client());
    (connection as { account: Account }).account = account;
    const documents = new CloudDocuments(connection, app, {
        cache,
        locks: options.locks ?? new EditLocks(undefined, undefined),
        repository: { encodeThumbnail: async () => undefined },
        titleBar: false,
    });
    return { server, account, app, cache, documents, docs };
}

describe("cloud repository while signed in", () => {
    test("signed in: the cloud repository is set, new documents go to the cloud, conflicts get the dialog", async () => {
        const { app, documents } = await setup();

        expect(app.repositories.cloud).toBeInstanceOf(CloudDocumentRepository);
        expect(app.repositories.cloud).toBe(documents.cloud);
        expect(app.repositories.preferred).toBe("cloud");
        expect(app.repositories.forNewDocuments()).toBe(documents.cloud);
        expect(app.repositories.conflictHandler).toBeInstanceOf(Function);
        documents.dispose();
    });

    test("the device setting keeps new documents on this device", async () => {
        const { app, account, documents } = await setup();

        account.deviceSettings.newDocumentLocation = "local";

        expect(app.repositories.preferred).toBe("local");
        expect(app.repositories.forNewDocuments()).toBe(app.repositories.local);
        documents.dispose();
    });

    test.each([
        [false, true],
        [true, false],
    ])("sign-out (keep offline copies: %s) stops the cloud; cache cleared: %s", async (keep, cleared) => {
        const { server, app, account, cache, documents } = await setup({ keepOfflineCopies: keep });
        await cache.put("a".repeat(64), new Uint8Array([1]));
        const local = app.repositories.local;
        server.on("POST /api/auth/logout", json(204));

        await account.signOut();

        expect(app.repositories.cloud).toBeUndefined();
        expect(app.repositories.preferred).toBe("local");
        expect(app.repositories.conflictHandler).toBeUndefined();
        expect(app.repositories.local).toBe(local);
        expect(cache.entries.size).toBe(cleared ? 0 : 1);
        documents.dispose();
    });

    test("deleting the account always clears the cached cloud documents", async () => {
        const { server, account, cache, documents } = await setup({ keepOfflineCopies: true });
        await cache.put("a".repeat(64), new Uint8Array([1]));
        server.on("POST /api/me/delete", json(204));

        await account.deleteAccount("pw");

        expect(cache.entries.size).toBe(0);
        documents.dispose();
    });

    test("a cloud document open in another tab opens read-only here", async () => {
        const locks = new EditLocks(takenLocks, undefined);
        const { app, documents } = await setup({ locks });
        const doc = openDocument(app, "doc-1", documents.cloud!);
        const local = openDocument(app, "doc-2", app.repositories.local);

        // PubSub is stubbed here: tell the module about the opened documents directly.
        (documents as unknown as { onDocumentOpened(d: unknown): void }).onDocumentOpened(doc);
        (documents as unknown as { onDocumentOpened(d: unknown): void }).onDocumentOpened(local);

        await rs.waitFor(() => expect(locks.isReadOnly("doc-1")).toBe(true));
        expect(locks.isReadOnly("doc-2")).toBe(false);
        expect(published).toContainEqual(["showToast", ["cloud.status.openedReadOnly"]]);
        const saved = await documents.cloud!.save({
            id: "doc-1",
            name: "x",
            data: doc.serialize(),
            kind: "manual",
        });
        expect(saved.error).toEqual({ kind: "readOnly" });
        documents.dispose();
    });
});

describe("signing out with cloud documents open", () => {
    const dialogButton = (label: string) => {
        const found = Array.from(document.querySelectorAll("dialog button")).find(
            (b) => b.textContent === label,
        );
        expect(found?.textContent).toBe(label);
        return found as HTMLButtonElement;
    };

    test("clean ones close; unsaved ones are offered as a copy on this device first", async () => {
        const { server, app, account, documents } = await setup();
        const cloud = documents.cloud!;
        const clean = openDocument(app, "clean", cloud);
        const dirty = openDocument(app, "dirty", cloud);
        dirty.isDirty = true;
        const local = openDocument(app, "local", app.repositories.local);
        server.on("POST /api/auth/logout", json(204));

        const signingOut = account.signOut();
        await rs.waitFor(() => expect(document.querySelector("dialog")).not.toBeNull());
        expect(document.querySelector("dialog")!.textContent).toContain("cloud.signedOut.unsaved");
        dialogButton("cloud.document.saveCopyOnDevice").click();
        await signingOut;

        expect(clean.closed).toEqual([{ discardChanges: true }]);
        expect(dirty.closed).toEqual([{ discardChanges: true }]);
        expect(dirty.events[0]).toBe("settled");
        expect(local.closed).toEqual([]);
        const copies = (app.repositories.local as MemoryDocumentRepository).saves;
        expect(copies).toHaveLength(1);
        expect(copies[0].id).not.toBe("dirty");
        expect(app.repositories.cloud).toBeUndefined();
        documents.dispose();
    });

    test("Escape keeps the changes too; only 'discard' drops them", async () => {
        const { server, app, account, documents } = await setup();
        const dirty = openDocument(app, "dirty", documents.cloud!);
        dirty.isDirty = true;
        server.on("POST /api/auth/logout", json(204));

        const signingOut = account.signOut();
        await rs.waitFor(() => expect(document.querySelector("dialog")).not.toBeNull());
        document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
        await signingOut;

        expect((app.repositories.local as MemoryDocumentRepository).saves).toHaveLength(1);
        expect(dirty.closed).toEqual([{ discardChanges: true }]);
        documents.dispose();
    });

    test("a repository never saves for another user who signed in on this device", async () => {
        const { account, documents } = await setup();
        const cloud = documents.cloud!;
        (account as unknown as { setPrivateValue(k: string, v: unknown): void }).setPrivateValue("user", {
            ...account.user!,
            id: "someone-else",
        });

        const saved = await cloud.save({ id: "doc", name: "x", data: {} as never, kind: "manual" });
        const loaded = await cloud.load("doc");

        expect(saved.error).toEqual({ kind: "unauthorized" });
        expect(loaded.error).toEqual({ kind: "unauthorized" });
        documents.dispose();
    });
});

describe("edit locks and save state follow the documents", () => {
    test("a document moved to the cloud takes the lock; moved away, it lets go", async () => {
        const { app, documents } = await setup();
        const acquire = rs.spyOn(documents.locks, "acquire");
        const release = rs.spyOn(documents.locks, "release");
        const doc = openDocument(app, "doc", app.repositories.local);
        const changed = (documents as unknown as { onRepositoryChanged(d: unknown, p: unknown): void })
            .onRepositoryChanged;

        doc.repository = documents.cloud!;
        changed(doc, app.repositories.local);
        expect(acquire).toHaveBeenCalledWith("doc");

        doc.repository = app.repositories.local;
        changed(doc, documents.cloud!);
        expect(release).toHaveBeenCalledWith("doc");
        documents.dispose();
    });

    test("closing a cloud document forgets its last save state", async () => {
        const { app, documents } = await setup();
        const cloud = documents.cloud!;
        const doc = openDocument(app, "doc", cloud);
        (cloud as unknown as { setState(id: string, s: string): void }).setState("doc", "conflict");

        (documents as unknown as { onDocumentClosed(d: unknown): void }).onDocumentClosed(doc);

        expect(cloud.stateOf("doc")).toBe("idle");
        documents.dispose();
    });

    test("before handing over, a running save finishes, then unsaved changes are saved", async () => {
        const { app, documents } = await setup();
        const doc = openDocument(app, "doc", documents.cloud!);
        doc.isDirty = true;

        await (documents as unknown as { beforeHandover(id: string): Promise<void> }).beforeHandover("doc");

        expect(doc.events).toEqual(["settled", "save:auto"]);
        documents.dispose();
    });
});

describe("merge keeping mine", () => {
    test.each([
        [["ours", "theirs"], "ours"],
        [["ours-first", "theirs-first"], "ours-first"],
        [["accept"], "accept"],
        [["theirs", "ours"], "ours"],
    ] as const)("%j → %s", (choices, expected) => {
        expect(keepMineChoice(choices)).toBe(expected);
    });
});

describe("title bar status", () => {
    test.each([
        ["saving", {}, "saving"],
        ["saved", {}, "saved"],
        ["saved", { dirty: true }, "unsaved"],
        ["conflict", {}, "conflict"],
        ["offline", {}, "offline"],
        ["saved", { online: false }, "offline"],
        ["error", {}, "error"],
        ["saving", { readOnly: true }, "readOnly"],
        ["pending", {}, "pending"],
        ["pending", { dirty: true }, "unsaved"],
        ["pending", { online: false }, "offline"],
        ["merging", {}, "merging"],
        ["merging", { online: false }, "merging"],
        ["remotePending", {}, "remotePending"],
        ["remotePending", { dirty: true }, "remotePending"],
    ] as const)("%s %o → %s", (state, flags, expected) => {
        expect(documentStatus(state, { dirty: false, readOnly: false, online: true, ...flags })).toBe(
            expected,
        );
    });

    test("shows where the active document lives and the cloud status", async () => {
        const { app, documents } = await setup();
        const doc = openDocument(app, "doc-1", documents.cloud!);
        (app as { activeView: unknown }).activeView = { document: doc };
        const item = new DocumentStatusItem({
            app,
            locks: documents.locks,
            repository: () => documents.cloud,
            takeOver: async () => {},
        });
        document.body.append(item);

        expect(item.querySelector("[data-location]")?.textContent).toBe("cloud.location.cloud");
        expect(item.querySelector("[role=status]")?.getAttribute("data-status")).toBe("saved");

        await documents.cloud!.save({ id: "doc-1", name: "Bracket", data: doc.serialize(), kind: "manual" });
        // Saved on this device first, then pushed by the sync.
        expect(item.querySelector("[role=status]")?.textContent).toBe("cloud.status.pending");
        await documents.syncEngine!.settle();
        expect(item.querySelector("[role=status]")?.textContent).toBe("cloud.status.saved");

        doc.repository = app.repositories.local;
        item.render();
        expect(item.querySelector("[data-location]")?.textContent).toBe("cloud.location.device");
        expect(item.querySelector("[role=status]")).toBeNull();

        (item.querySelector("[data-location]") as HTMLButtonElement).click();
        const menu = Array.from(item.querySelectorAll("[role=menu] button"), (b) => b.textContent);
        expect(menu).toEqual(["cloud.document.saveToCloud", "cloud.document.download"]);
        item.remove();
        documents.dispose();
    });

    test("read-only offers 'edit here instead'", async () => {
        const locks = new EditLocks(takenLocks, undefined);
        const { app, documents } = await setup({ locks });
        const doc = openDocument(app, "doc-1", documents.cloud!);
        await locks.acquire("doc-1");
        (app as { activeView: unknown }).activeView = { document: doc };
        const takeOver = rs.fn(async (_d: IDocument) => {});
        const item = new DocumentStatusItem({ app, locks, repository: () => documents.cloud, takeOver });
        document.body.append(item);

        const button = Array.from(item.querySelectorAll("button")).find(
            (b) => b.textContent === "cloud.status.editHere",
        );
        expect(button?.textContent).toBe("cloud.status.editHere");
        button!.click();

        expect(takeOver).toHaveBeenCalledWith(doc);
        item.remove();
        documents.dispose();
    });

    test("after an autosave, 'Autosaved' with the local time instead of 'Saved'", async () => {
        const { app, documents } = await setup();
        const doc = openDocument(app, "doc-1", documents.cloud!);
        (app as { activeView: unknown }).activeView = { document: doc };
        const autosave = new AutosaveStatus();
        const item = new DocumentStatusItem({
            app,
            locks: documents.locks,
            repository: () => documents.cloud,
            takeOver: async () => {},
            autosave,
        });
        document.body.append(item);
        await documents.cloud!.save({ id: "doc-1", name: "Bracket", data: doc.serialize(), kind: "auto" });
        await documents.syncEngine!.settle();

        const at = Date.UTC(2026, 8, 27, 12, 5);
        autosave.recordAutosave(doc as unknown as IDocument, at);

        expect(item.querySelector("[role=status]")?.textContent).toBe(
            `autosave.status.autosaved${formatTime(at)}`,
        );
        expect(published).toEqual([]);
        autosave.clear(doc as unknown as IDocument);
        expect(item.querySelector("[role=status]")?.textContent).toBe("cloud.status.saved");
        item.remove();
        documents.dispose();
    });

    test("a conflict an autosave met opens the dialog only when the status is clicked", async () => {
        const { app, documents, docs } = await setup();
        // The repository on its own (the sync merges instead, see sync.test.ts).
        documents.syncEngine!.stop();
        const doc = openDocument(app, "doc-1", documents.cloud!);
        (app as { activeView: unknown }).activeView = { document: doc };
        const first = await documents.cloud!.save({
            id: "doc-1",
            name: "Bracket",
            data: doc.serialize(),
            kind: "manual",
        });
        const base = first.isOk && first.value.status === "saved" ? first.value.version : undefined;
        expect(base).toBe(docs.head("doc-1")?.id);
        await docs.saveElsewhere("doc-1");
        const item = new DocumentStatusItem({
            app,
            locks: documents.locks,
            repository: () => documents.cloud,
            takeOver: async () => {},
            resolveConflict: documents.resolveConflict,
        });
        document.body.append(item);

        const saved = await documents.cloud!.save({
            id: "doc-1",
            name: "Bracket",
            data: doc.serialize(),
            kind: "auto",
            baseVersion: base,
        });
        expect(saved.isOk && saved.value.status).toBe("conflict");
        expect(document.querySelector("dialog[open]")).toBeNull();

        const status = item.querySelector("[role=status]") as HTMLButtonElement;
        expect(status.tagName).toBe("BUTTON");
        expect(status.dataset["status"]).toBe("conflict");
        status.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.querySelector("dialog[open]")).not.toBeNull();
        item.remove();
        documents.dispose();
    });

    test("nothing shows while signed out", async () => {
        const app = createMockApplication();
        const item = new DocumentStatusItem({
            app,
            locks: new EditLocks(undefined, undefined),
            repository: () => undefined,
            takeOver: async () => {},
        });
        document.body.append(item);

        expect(item.childElementCount).toBe(0);
        item.remove();
    });

    test("the status joins the title bar, left of the account button, and leaves with the teardown", async () => {
        const server = new FakeServer();
        const account = await signedInAccount(server);
        const connection = new CloudConnection(CONFIG, server.client());
        (connection as { account: Account }).account = account;
        const accountButton = document.createElement("div");
        TitleBar.items.push(accountButton);

        const documents = new CloudDocuments(connection, createMockApplication(), {
            cache: new MemoryBlobCache(),
            locks: new EditLocks(undefined, undefined),
        });

        expect(TitleBar.items.at(0)).toBeInstanceOf(DocumentStatusItem);
        expect(TitleBar.items.at(1)).toBe(accountButton);
        documents.dispose();
        expect(TitleBar.items.find((x) => x instanceof DocumentStatusItem)).toBeUndefined();
        TitleBar.items.remove(accountButton);
    });
});

describe("conflict dialog", () => {
    const conflict: SaveConflict = {
        status: "conflict",
        headVersion: "v-head",
        headCreatedAt: Date.parse("2026-09-27T12:30:00Z"),
        headDeviceName: "Laptop – Chrome",
    };

    function dialogSetup() {
        const cloud = new MemoryDocumentRepository();
        const app = createMockApplication();
        const openDocumentSpy = rs.fn(async (_id: string, _repository?: IDocumentRepository) => undefined);
        app.openDocument = openDocumentSpy;
        const doc = openDocument(app, "doc-1", cloud);
        doc.version = "v-old";
        doc.isDirty = true;
        const closed = showConflictDialog(app, doc as unknown as IDocument, conflict, cloud);
        const dialog = document.querySelector("dialog")!;
        expect(dialog).not.toBeNull();
        const button = (label: string) => {
            const found = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === label);
            expect(found?.textContent).toBe(label);
            return found!;
        };
        return { app, cloud, doc, dialog, closed, openDocumentSpy, button };
    }

    test("says which device saved the newer version and when, in local time", () => {
        const { dialog } = dialogSetup();

        expect(conflictMessage(conflict)).toContain("Laptop – Chrome");
        expect(dialog.textContent).toContain(conflictMessage(conflict));
        expect(conflictMessage({ status: "conflict" })).toBe(
            "cloud.conflict.message{0}{1}"
                .replace("{0}", "cloud.conflict.unknownDevice")
                .replace("{1}", "cloud.conflict.unknownTime"),
        );
    });

    test("open latest: closes without saving and opens the head", async () => {
        const { doc, closed, openDocumentSpy, button, cloud } = dialogSetup();

        button("cloud.conflict.openLatest").click();
        await closed;

        expect(doc.closed).toEqual([{ discardChanges: true }]);
        expect(doc.saves).toEqual([]);
        expect(openDocumentSpy).toHaveBeenCalledWith("doc-1", cloud);
    });

    test("download mine keeps the dialog open and downloads a .spicy", async () => {
        const { dialog, button } = dialogSetup();
        const created = rs.fn((_blob: Blob | MediaSource) => "blob:x");
        rs.spyOn(URL, "createObjectURL").mockImplementation(created);
        rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

        button("cloud.conflict.downloadMine").click();

        await rs.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
        await rs.waitFor(() => expect(dialog.hasAttribute("aria-busy")).toBe(false));
        expect(dialog.isConnected).toBe(true);
    });

    test("save mine as a copy: a new cloud document with my content, opened instead", async () => {
        const { doc, cloud, closed, openDocumentSpy, button } = dialogSetup();

        button("cloud.conflict.saveCopy").click();
        await closed;

        expect(cloud.saves).toHaveLength(1);
        const copy = cloud.saves[0];
        expect(copy.id).not.toBe("doc-1");
        expect(copy.name).toBe("cloud.conflict.copyNameBracket");
        expect(copy.data).toMatchObject({ id: copy.id, name: copy.name });
        expect(copy.baseVersion).toBeUndefined();
        expect(doc.closed).toEqual([{ discardChanges: true }]);
        expect(openDocumentSpy).toHaveBeenCalledWith(copy.id, cloud);
    });

    test("without a known head, 'save mine as the latest version' is not offered", () => {
        const app = createMockApplication();
        const doc = openDocument(app, "doc-1", new MemoryDocumentRepository("cloud"));
        void showConflictDialog(app, doc as unknown as IDocument, { status: "conflict" }, doc.repository);

        const labels = Array.from(document.querySelectorAll("dialog button"), (b) => b.textContent);
        expect(labels).toContain("cloud.conflict.openLatest");
        expect(labels).not.toContain("cloud.conflict.saveLatest");
    });

    test("save mine as the latest version: saved on top of the head", async () => {
        const { doc, closed, button } = dialogSetup();

        button("cloud.conflict.saveLatest").click();
        await closed;

        expect(doc.version).toBe("v-head");
        expect(doc.saves).toEqual(["manual"]);
        expect(doc.closed).toEqual([]);
        expect(published).toContainEqual(["showToast", ["toast.document.saved"]]);
    });
});
