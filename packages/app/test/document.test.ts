// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    type DialogButton,
    DOCUMENT_FORMAT_VERSION,
    DocumentMigrations,
    DocumentRebuilds,
    History,
    type I18nKeys,
    type IApplication,
    type IDocument,
    InternalClassName,
    type IView,
    ModelManager,
    migrateDocument,
    ObservableCollection,
    PubSub,
    Result,
    type SaveConflict,
    type SaveRequest,
    type Serialized,
    Transaction,
    UnknownNode,
} from "@spicy3d/core";
import {
    createMockApplication,
    loadDocumentFixtures,
    MemoryDocumentRepository,
} from "@spicy3d/core/test-utils";
import { Document } from "../src/document";

describe("Document", () => {
    let mockApp: IApplication;
    let document: Document;

    beforeEach(() => {
        mockApp = createMockApplication();
        document = new Document(mockApp, "test-document");
    });

    afterEach(() => {
        document.dispose();
    });

    describe("constructor", () => {
        test("should create document with given name", () => {
            expect(document.name).toBe("test-document");
        });

        test("should generate unique id by default", () => {
            const doc2 = new Document(mockApp, "doc2");
            expect(document.id).not.toBe(doc2.id);
            doc2.dispose();
        });

        test("should use provided id", () => {
            const customId = "custom-document-id";
            const doc = new Document(mockApp, "doc", customId);
            expect(doc.id).toBe(customId);
            doc.dispose();
        });

        test("should add document to application documents", () => {
            expect(mockApp.documents.has(document)).toBe(true);
        });

        test("should initialize modelManager", () => {
            expect(document.modelManager).toBeInstanceOf(ModelManager);
        });

        test("should initialize history", () => {
            expect(document.history).toBeInstanceOf(History);
        });

        test("should initialize acts collection", () => {
            expect(document.acts).toBeInstanceOf(ObservableCollection);
            expect(document.acts.length).toBe(0);
        });

        test("should initialize visual", () => {
            expect(document.visual).toBeDefined();
        });

        test("should initialize selection", () => {
            expect(document.selection).toBeDefined();
        });
    });

    describe("name property", () => {
        test("should get name correctly", () => {
            expect(document.name).toBe("test-document");
        });

        test("should set name correctly", () => {
            document.name = "new-name";
            expect(document.name).toBe("new-name");
        });

        test("should not trigger update if name is same", () => {
            const originalName = document.name;
            document.name = originalName;
            expect(document.name).toBe(originalName);
        });
    });

    describe("serialize", () => {
        test("should serialize document correctly", () => {
            const serialized = document.serialize();

            expect(serialized[InternalClassName]).toBe("Document");
            expect(serialized["id"]).toBe(document.id);
            expect(serialized["name"]).toBe(document.name);
            expect(serialized["models"]).toBeDefined();
            expect(serialized["acts"]).toEqual([]);
            expect(serialized["userData"]).toBeDefined();
        });

        test("should include userData in serialization", () => {
            document.userData = { key: "value" };
            const serialized = document.serialize();

            expect(serialized["userData"]).toEqual({ key: "value" });
        });
    });

    describe("save", () => {
        let repository: MemoryDocumentRepository;

        beforeEach(() => {
            repository = new MemoryDocumentRepository();
            document.repository = repository;
        });

        test("a new document saves to the application's local repository", () => {
            const fresh = new Document(mockApp, "fresh");
            try {
                expect(fresh.repository).toBe(mockApp.repositories.local);
            } finally {
                fresh.dispose();
            }
        });

        test("saves the serialized document through its repository", async () => {
            const result = await document.save("auto");

            expect(result.isOk).toBe(true);
            expect(repository.saves).toHaveLength(1);
            const request = repository.saves[0];
            expect(request.id).toBe(document.id);
            expect(request.name).toBe("test-document");
            expect(request.kind).toBe("auto");
            expect(request.data).toEqual(document.serialize());
        });

        test("defaults to a manual save", async () => {
            await document.save();
            expect(repository.saves[0].kind).toBe("manual");
        });

        test("the thumbnail comes from a view of this document, not another document's", async () => {
            const own = { document, toImage: () => "data:own" } as unknown as IView;
            const other = { document: {} as IDocument, toImage: () => "data:other" } as unknown as IView;
            mockApp.views.push(other, own);
            mockApp.activeView = other;

            await document.save();

            expect(repository.saves[0].thumbnail).toBe("data:own");
        });

        test("sends the loaded version as the base and keeps the one the save returns", async () => {
            document.version = "v1";
            repository.save = async (request) => {
                repository.saves.push(request);
                return Result.ok({ status: "saved", updatedAt: 1, version: "v2" });
            };

            await document.save();

            expect(repository.saves[0].baseVersion).toBe("v1");
            expect(document.version).toBe("v2");
        });

        test("saves run one at a time; requests made meanwhile share one follow-up on the new base", async () => {
            document.version = "v1";
            const release: (() => void)[] = [];
            let version = 1;
            repository.save = async (request) => {
                repository.saves.push(request);
                await new Promise<void>((resolve) => release.push(resolve));
                version++;
                return Result.ok({ status: "saved", updatedAt: version, version: `v${version}` });
            };

            const first = document.save("auto");
            const second = document.save("auto");
            const third = document.save("manual");
            await Promise.resolve();
            expect(repository.saves).toHaveLength(1);

            release.shift()!();
            await first;
            await rs.waitFor(() => expect(repository.saves).toHaveLength(2));
            release.shift()!();
            const [a, b] = await Promise.all([second, third]);

            expect(a).toBe(b);
            expect(repository.saves.map((x) => [x.baseVersion, x.kind])).toEqual([
                ["v1", "auto"],
                ["v2", "manual"],
            ]);
            expect(document.version).toBe("v3");
            await document.settled();
        });

        test("passes the label; a shared follow-up takes the agent's kind over an autosave, and its label", async () => {
            const release: (() => void)[] = [];
            repository.save = async (request) => {
                repository.saves.push(request);
                await new Promise<void>((resolve) => release.push(resolve));
                return Result.ok({ status: "saved", updatedAt: 1 });
            };

            const first = document.save("mcp", { label: "first" });
            const second = document.save("auto");
            const third = document.save("mcp", { label: "Agent: hole" });
            release.shift()!();
            await first;
            await rs.waitFor(() => expect(repository.saves).toHaveLength(2));
            release.shift()!();
            await Promise.all([second, third]);

            expect(repository.saves.map((x) => [x.kind, x.label])).toEqual([
                ["mcp", "first"],
                ["mcp", "Agent: hole"],
            ]);
        });

        test("a manual request still wins a follow-up shared with an agent's save", async () => {
            const release: (() => void)[] = [];
            repository.save = async (request) => {
                repository.saves.push(request);
                await new Promise<void>((resolve) => release.push(resolve));
                return Result.ok({ status: "saved", updatedAt: 1 });
            };

            const first = document.save("auto");
            const second = document.save("mcp");
            const third = document.save("manual");
            release.shift()!();
            await first;
            await rs.waitFor(() => expect(repository.saves).toHaveLength(2));
            release.shift()!();
            await Promise.all([second, third]);

            expect(repository.saves.map((x) => x.kind)).toEqual(["auto", "manual"]);
            expect(repository.saves[1].label).toBeUndefined();
        });

        test("an autosave joining an agent's queued save makes it the user's: auto, the label dropped", async () => {
            const release: (() => void)[] = [];
            repository.save = async (request) => {
                repository.saves.push(request);
                await new Promise<void>((resolve) => release.push(resolve));
                return Result.ok({ status: "saved", updatedAt: 1 });
            };

            const first = document.save("manual");
            const second = document.save("mcp", { label: "Agent: hole" });
            const third = document.save("auto");
            release.shift()!();
            await first;
            await rs.waitFor(() => expect(repository.saves).toHaveLength(2));
            release.shift()!();
            await Promise.all([second, third]);

            expect(repository.saves[1].kind).toBe("auto");
            expect(repository.saves[1].label).toBeUndefined();
        });

        test("settled waits for the running and queued saves", async () => {
            let finish!: () => void;
            repository.save = async (request) => {
                repository.saves.push(request);
                await new Promise<void>((resolve) => {
                    finish = resolve;
                });
                return Result.ok({ status: "saved", updatedAt: 1 });
            };
            void document.save();
            let settled = false;
            const waiting = document.settled().then(() => {
                settled = true;
            });
            await Promise.resolve();
            expect(settled).toBe(false);

            finish();
            await waiting;

            expect(settled).toBe(true);
        });

        test("settled drains a deferred save requested while it is waiting for a rebuild", async () => {
            const rebuilt = Promise.withResolvers<void>();
            const saved = Promise.withResolvers<void>();
            const saving = Promise.withResolvers<void>();
            const release = DocumentRebuilds.add(document, {
                settled: rebuilt.promise,
                flush: () => {
                    release();
                    rebuilt.resolve();
                },
            });
            repository.save = async (request) => {
                repository.saves.push(request);
                saving.resolve();
                await saved.promise;
                return Result.ok({ status: "saved", updatedAt: 1 });
            };
            let settled = false;
            const waiting = document.settled().then(() => {
                settled = true;
            });
            const save = document.save();
            try {
                expect(repository.saves).toHaveLength(0);
                release();
                rebuilt.resolve();
                await saving.promise;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                expect(repository.saves).toHaveLength(1);
                expect(settled).toBe(false);
                saved.resolve();
                await Promise.all([save, waiting]);
                expect(settled).toBe(true);
            } finally {
                release();
                rebuilt.resolve();
                saved.resolve();
                await Promise.all([save, waiting]);
            }
        });

        test("a failed save is returned and does not throw", async () => {
            repository.failWith = { kind: "quota" };

            const result = await document.save();

            expect(result.isOk).toBe(false);
            expect(result.error).toEqual({ kind: "quota" });
        });
    });

    describe("isDirty", () => {
        let repository: MemoryDocumentRepository;
        const edit = (name: string) =>
            Transaction.execute(document, "rename", () => {
                document.modelManager.rootNode.name = name;
            });

        beforeEach(() => {
            repository = new MemoryDocumentRepository();
            document.repository = repository;
        });

        test("a new document is clean", () => {
            expect(document.isDirty).toBe(false);
        });

        test("an edit makes it dirty and saving makes it clean", async () => {
            edit("changed");
            expect(document.isDirty).toBe(true);

            await document.save();
            expect(document.isDirty).toBe(false);
        });

        // How the project tree and the agent's rename_document rename a document: the setter
        // renames the root inside the transaction, which is what history records.
        test("renaming the document in a transaction makes it dirty and undoes as one step", () => {
            Transaction.execute(document, "rename", () => {
                document.name = "Mouse side";
            });

            expect(document.modelManager.rootNode.name).toBe("Mouse side");
            expect(document.isDirty).toBe(true);
            document.history.undo();
            expect(document.name).toBe("test-document");
            expect(document.isDirty).toBe(false);
        });

        test("undoing back to the saved point makes it clean, redoing makes it dirty", async () => {
            edit("saved");
            await document.save();
            edit("after save");
            expect(document.isDirty).toBe(true);

            document.history.undo();
            expect(document.isDirty).toBe(false);

            document.history.undo();
            expect(document.isDirty).toBe(true);

            document.history.redo();
            expect(document.isDirty).toBe(false);
        });

        test("a new edit after undoing past the saved point stays dirty", async () => {
            edit("a");
            await document.save();
            document.history.undo();
            edit("b");

            expect(document.isDirty).toBe(true);
        });

        test("a failed save leaves it dirty", async () => {
            edit("changed");
            repository.failWith = { kind: "offline" };

            await document.save();

            expect(document.isDirty).toBe(true);
        });

        test("a conflicting save leaves it dirty", async () => {
            edit("changed");
            repository.save = async () => Result.ok({ status: "conflict", headVersion: "other" });

            await document.save();

            expect(document.isDirty).toBe(true);
        });

        test("notifies observers when it flips", async () => {
            const changes: boolean[] = [];
            document.onPropertyChanged((property) => {
                if (property === "isDirty") changes.push(document.isDirty);
            });

            edit("a");
            edit("b");
            await document.save();

            expect(changes).toEqual([true, false]);
        });

        test("a loaded document is clean", async () => {
            edit("changed");
            const loaded = await Document.load(mockApp, document.serialize());

            try {
                expect(loaded!.isDirty).toBe(false);
            } finally {
                loaded?.dispose();
            }
        });
    });

    describe("close", () => {
        let repository: MemoryDocumentRepository;
        let pub: ReturnType<typeof rs.spyOn>;
        let dialogs: DialogButton[][];

        const answer = async (choice: I18nKeys) => {
            const button = dialogs.at(-1)?.find((x) => x.content === choice);
            expect(button).not.toBeUndefined();
            await button!.onclick?.();
        };

        beforeEach(() => {
            repository = new MemoryDocumentRepository();
            document.repository = repository;
            dialogs = [];
            const original = PubSub.default.pub.bind(PubSub.default);
            pub = rs.spyOn(PubSub.default, "pub").mockImplementation(((event: string, ...args: any[]) => {
                if (event === "showDialog") {
                    dialogs.push(args[2] as DialogButton[]);
                    return;
                }
                (original as any)(event, ...args);
            }) as any);
            Transaction.execute(document, "rename", () => {
                document.modelManager.rootNode.name = "edited";
            });
        });

        afterEach(() => {
            pub.mockRestore();
        });

        test("a clean document closes without asking", async () => {
            await document.save();

            expect(await document.close()).toBe(true);
            expect(dialogs).toHaveLength(0);
            expect(mockApp.documents.has(document)).toBe(false);
        });

        test("asks in the app dialog instead of window.confirm", async () => {
            const confirm = rs.spyOn(window, "confirm");
            try {
                const closing = document.close();
                await Promise.resolve();
                expect(dialogs).toHaveLength(1);
                expect(dialogs[0].map((x) => x.content)).toEqual([
                    "common.save",
                    "common.dontSave",
                    "common.cancel",
                ]);
                await answer("common.cancel");
                await closing;
                expect(confirm).not.toHaveBeenCalled();
            } finally {
                confirm.mockRestore();
            }
        });

        test("save: saves through the repository, then closes", async () => {
            const closing = document.close();
            await Promise.resolve();
            await answer("common.save");

            expect(await closing).toBe(true);
            expect(repository.saves).toHaveLength(1);
            expect(mockApp.documents.has(document)).toBe(false);
        });

        test("don't save: closes without saving", async () => {
            const closing = document.close();
            await Promise.resolve();
            await answer("common.dontSave");

            expect(await closing).toBe(true);
            expect(repository.saves).toHaveLength(0);
            expect(mockApp.documents.has(document)).toBe(false);
        });

        test("cancel: keeps the document open", async () => {
            const closing = document.close();
            await Promise.resolve();
            await answer("common.cancel");

            expect(await closing).toBe(false);
            expect(mockApp.documents.has(document)).toBe(true);
            expect(document.isDirty).toBe(true);
        });

        test("a failed save keeps the document open and says why", async () => {
            repository.failWith = { kind: "quota" };
            const closing = document.close();
            await Promise.resolve();
            await answer("common.save");

            expect(await closing).toBe(false);
            expect(mockApp.documents.has(document)).toBe(true);
            expect(pub).toHaveBeenCalledWith("showToast", "error.repository.quota");
        });

        test("a save queued behind the close prompt's save never serializes the closed document", async () => {
            let release!: () => void;
            const slow = new (class extends MemoryDocumentRepository {
                override async save(request: SaveRequest) {
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    return super.save(request);
                }
            })();
            document.repository = slow;
            const closing = document.close();
            await answer("common.save");
            const queued = document.save("auto");

            release();
            expect(await closing).toBe(true);
            const refused = await queued;

            expect(refused.isOk).toBe(false);
            expect(slow.saves.map((x) => x.kind)).toEqual(["manual"]);
        });

        test("closing twice while the first close asks opens one dialog and shares its answer", async () => {
            const first = document.close();
            const second = document.close();
            await Promise.resolve();

            expect(dialogs).toHaveLength(1);
            await answer("common.dontSave");

            expect(await first).toBe(true);
            expect(await second).toBe(true);
        });

        test("after a cancelled close, closing asks again", async () => {
            const first = document.close();
            await Promise.resolve();
            await answer("common.cancel");
            expect(await first).toBe(false);

            const second = document.close();
            await Promise.resolve();

            expect(dialogs).toHaveLength(2);
            await answer("common.dontSave");
            expect(await second).toBe(true);
        });

        test("discardChanges closes a dirty document without asking or saving", async () => {
            expect(document.isDirty).toBe(true);

            expect(await document.close({ discardChanges: true })).toBe(true);

            expect(dialogs).toHaveLength(0);
            expect(repository.saves).toHaveLength(0);
            expect(mockApp.documents.has(document)).toBe(false);
        });

        test("a conflicting save goes to the conflict handler and keeps the document open", async () => {
            const handler = rs.fn(async (_doc: IDocument, _conflict: SaveConflict) => {});
            mockApp.repositories.conflictHandler = handler;
            repository.save = async () =>
                Result.ok({ status: "conflict", headVersion: "h", headDeviceName: "Laptop" });
            const closing = document.close();
            await Promise.resolve();
            await answer("common.save");

            expect(await closing).toBe(false);
            expect(handler).toHaveBeenCalledWith(document, {
                status: "conflict",
                headVersion: "h",
                headDeviceName: "Laptop",
            });
            expect(mockApp.documents.has(document)).toBe(true);
        });

        test("without a conflict handler a conflict is only reported", async () => {
            repository.save = async () => Result.ok({ status: "conflict" });
            const closing = document.close();
            await Promise.resolve();
            await answer("common.save");

            expect(await closing).toBe(false);
            expect(pub).toHaveBeenCalledWith("showToast", "error.repository.conflict");
        });

        test("closes the document's views", async () => {
            await document.save();
            const close = rs.fn();
            const view = { document, close } as unknown as IView;
            mockApp.views.push(view);

            await document.close();

            expect(close).toHaveBeenCalledTimes(1);
            expect(mockApp.views.length).toBe(0);
        });
    });

    describe("open", () => {
        test("should return undefined and say why for a document the repository does not have", async () => {
            const pub = rs.spyOn(PubSub.default, "pub");
            try {
                const openedDoc = await Document.open(mockApp, "non-existent");

                expect(openedDoc).toBeUndefined();
                expect(pub).toHaveBeenCalledWith("showToast", "error.repository.notFound");
            } finally {
                pub.mockRestore();
            }
        });

        test("opens from the given repository and remembers it and the version", async () => {
            const repository = new MemoryDocumentRepository();
            repository.load = async () => Result.ok({ data: document.serialize(), version: "v7" });

            const opened = await Document.open(mockApp, document.id, repository);

            try {
                expect(opened!.repository).toBe(repository);
                expect(opened!.version).toBe("v7");
                expect(opened!.isDirty).toBe(false);
            } finally {
                opened?.dispose();
            }
        });
    });

    describe("userData", () => {
        test("should allow setting userData", () => {
            document.userData["foo"] = "bar";
            expect(document.userData["foo"]).toBe("bar");
        });

        test("should preserve userData after serialize", () => {
            document.userData = { test: "data" };
            const serialized = document.serialize();
            expect(serialized["userData"]).toEqual({ test: "data" });
        });
    });

    describe("variables", () => {
        test("starts empty", () => {
            expect(document.variables.items).toEqual([]);
        });

        test("should include variables in serialization", () => {
            document.variables.setItems([{ id: "v1", name: "w", expression: "50", type: "length" }]);

            const serialized = document.serialize();

            expect(serialized["variables"]).toEqual([
                { id: "v1", name: "w", expression: "50", type: "length" },
            ]);
        });

        test("should restore variables through Document.load", async () => {
            document.variables.setItems([
                { id: "v1", name: "w", expression: "50", type: "length", description: "总宽" },
            ]);
            const serialized = document.serialize();

            const loaded = await Document.load(mockApp, serialized);

            try {
                expect(loaded).not.toBeUndefined();
                expect(loaded!.variables.items).toEqual([
                    { id: "v1", name: "w", expression: "50", type: "length", description: "总宽" },
                ]);
                // Restored BEFORE the models deserialize, so a body rebuilding during
                // that load already resolves its parameters.
                expect(loaded!.variables.evaluate().scope.get("w")?.value).toBe(50);
            } finally {
                loaded?.dispose();
            }
        });
    });

    describe("project settings", () => {
        test("a new project reads in millimetres", () => {
            expect(document.settings.lengthUnit).toBe("mm");
            expect(document.serialize()["settings"]).toEqual({ lengthUnit: "mm" });
        });

        test("the length unit is saved per project and restored on reopening", async () => {
            document.settings.lengthUnit = "in";
            const loaded = await Document.load(mockApp, document.serialize());

            try {
                expect(loaded!.settings.lengthUnit).toBe("in");
            } finally {
                loaded?.dispose();
            }
        });

        test("a project saved before project settings existed opens in millimetres", async () => {
            const serialized = document.serialize();
            delete serialized["settings"];

            const loaded = await Document.load(mockApp, serialized);

            try {
                expect(loaded!.settings.lengthUnit).toBe("mm");
            } finally {
                loaded?.dispose();
            }
        });
    });

    describe("serialize → deserialize roundtrip", () => {
        test("should restore id, name and userData through Document.load", async () => {
            document.userData = { layer: "roundtrip", count: 3 };
            const serialized = document.serialize();

            const loaded = await Document.load(mockApp, serialized);

            try {
                expect(loaded).not.toBeUndefined();
                expect(loaded!.id).toBe(document.id);
                expect(loaded!.name).toBe(document.name);
                expect(loaded!.userData).toEqual({ layer: "roundtrip", count: 3 });
                // The loaded document is registered on the application
                expect(mockApp.documents.has(loaded!)).toBe(true);
            } finally {
                loaded?.dispose();
            }
        });

        test("should restore the model tree root through Document.load", async () => {
            const serialized = document.serialize();

            const loaded = (await Document.load(mockApp, serialized)) as Document;

            try {
                expect(loaded.modelManager.rootNode.name).toBe(document.modelManager.rootNode.name);
                expect(loaded.acts.length).toBe(0);
                // History is re-enabled after loading
                expect(loaded.history.disabled).toBe(false);
            } finally {
                loaded.dispose();
            }
        });
    });

    describe("document format", () => {
        let pub: ReturnType<typeof rs.spyOn>;
        const toasts = () =>
            pub.mock.calls.filter(([event]) => event === "showToast").map(([, ...args]) => args);

        beforeEach(() => {
            pub = rs.spyOn(PubSub.default, "pub");
        });

        afterEach(() => {
            pub.mockRestore();
        });

        test("a saved document records the format and module versions", () => {
            const serialized = document.serialize();

            expect(serialized["formatVersion"]).toBe(DOCUMENT_FORMAT_VERSION);
            expect(serialized["moduleVersions"]).toEqual(DocumentMigrations.moduleVersions());
            expect(serialized["version"]).toBeUndefined();
        });

        test.each(
            loadDocumentFixtures().map((x) => [x.name, x] as const),
        )("fixture %s loads and saves back unchanged", async (_name, fixture) => {
            const loaded = await Document.load(mockApp, fixture.data);

            try {
                expect(loaded).not.toBeUndefined();
                expect(toasts()).toEqual([]);
                // Nodes of classes this test does not register (bodies, sketches) are kept raw.
                expect(loaded!.serialize()).toEqual(migrateDocument(fixture.data).value);
            } finally {
                loaded?.dispose();
            }
        });

        test.each([
            [
                "a newer format",
                { formatVersion: DOCUMENT_FORMAT_VERSION + 1, moduleVersions: {} },
                "error.document.newerFormat",
            ],
            ["a Chili3D file", { version: "0.6" }, "error.document.notSpicy3D"],
        ])("%s shows an error and leaves the data untouched", async (_name, versions, key) => {
            const { formatVersion: _f, moduleVersions: _m, ...base } = document.serialize();
            const data = { ...base, ...versions } as Serialized;
            const before = structuredClone(data);
            const count = mockApp.documents.size;

            const loaded = await Document.load(mockApp, data);

            expect(loaded).toBeUndefined();
            expect(toasts()).toEqual([[key]]);
            expect(data).toEqual(before);
            expect(mockApp.documents.size).toBe(count);
        });

        test("nodes of an unregistered class survive load and save", async () => {
            const serialized = document.serialize();
            const rootId = serialized["models"].nodes[0].id;
            const pluginNode = {
                __cla$$__: "PluginGearNode",
                id: "gear",
                name: "Gear",
                visible: true,
                teeth: 24,
                parentId: rootId,
            };
            serialized["models"].nodes.push(pluginNode);

            const loaded = await Document.load(mockApp, serialized);

            try {
                expect(loaded!.modelManager.findNode((n) => n.id === "gear")).toBeInstanceOf(UnknownNode);
                expect(loaded!.serialize()["models"].nodes).toContainEqual(pluginNode);
            } finally {
                loaded?.dispose();
            }
        });

        test("module versions of plugins that are not loaded are saved back", async () => {
            const serialized = document.serialize();
            serialized["moduleVersions"] = { ...serialized["moduleVersions"], myPlugin: 4 };

            const loaded = await Document.load(mockApp, serialized);

            try {
                expect(loaded!.serialize()["moduleVersions"]).toEqual({
                    ...DocumentMigrations.moduleVersions(),
                    myPlugin: 4,
                });
            } finally {
                loaded?.dispose();
            }
        });
    });

    describe("dispose", () => {
        test("should dispose modelManager, visual, history and selection", () => {
            const modelManagerSpy = rs.spyOn(document.modelManager, "dispose");
            const visualSpy = rs.spyOn(document.visual, "dispose");
            const historySpy = rs.spyOn(document.history, "dispose");
            const selectionSpy = rs.spyOn(document.selection, "dispose");

            document.dispose();

            expect(modelManagerSpy).toHaveBeenCalledTimes(1);
            expect(visualSpy).toHaveBeenCalledTimes(1);
            expect(historySpy).toHaveBeenCalledTimes(1);
            expect(selectionSpy).toHaveBeenCalledTimes(1);
        });

        test("should dispose all acts and clear the acts collection", () => {
            const actDispose = rs.fn();
            document.acts.push({ dispose: actDispose } as any);
            expect(document.acts.length).toBe(1);

            document.dispose();

            expect(actDispose).toHaveBeenCalledTimes(1);
            expect(document.acts.length).toBe(0);
        });
    });
});
