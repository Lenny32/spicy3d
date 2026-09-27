// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import {
    DOCUMENT_FORMAT_VERSION,
    DocumentMigrations,
    History,
    type IApplication,
    InternalClassName,
    ModelManager,
    migrateDocument,
    ObservableCollection,
    PubSub,
    type Serialized,
    UnknownNode,
} from "@spicy3d/core";
import { createMockApplication, loadDocumentFixtures } from "@spicy3d/core/test-utils";
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
        test("should save document to storage", async () => {
            let saved = false;
            const originalPut = mockApp.storage.put;
            mockApp.storage.put = async () => {
                saved = true;
                return true;
            };
            await document.save();
            expect(saved).toBe(true);
            mockApp.storage.put = originalPut;
        });
    });

    describe("open", () => {
        test("should return undefined for non-existent document", async () => {
            mockApp.storage.get = async () => undefined;

            const openedDoc = await Document.open(mockApp, "non-existent");

            expect(openedDoc).toBeUndefined();
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
