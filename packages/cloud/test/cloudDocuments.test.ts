// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type CloseDocumentOptions,
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
import { CloudDocuments } from "../src/documents/cloudDocuments";
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
    async save(kind: SaveKind = "manual") {
        this.saves.push(kind);
        return this.nextSave;
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
    new FakeDocumentServer(server);
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
    return { server, account, app, cache, documents };
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
        expect(button).toBeDefined();
        button!.click();

        expect(takeOver).toHaveBeenCalledWith(doc);
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
            expect(found).toBeDefined();
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
