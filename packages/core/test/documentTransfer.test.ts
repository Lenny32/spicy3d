// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import {
    type DocumentMeta,
    type ExistingDocument,
    type IDocument,
    type IDocumentRepository,
    PubSub,
    Result,
    type SaveKind,
    type SaveRequest,
    type Serialized,
    saveDocumentCopy,
    transferDocument,
} from "../src";
import { createMockApplication, MemoryDocumentRepository } from "../test-utils";

const data = (id: string, name = "Bracket") => ({ __cla$$__: "Document", id, name }) as unknown as Serialized;

function setup() {
    const local = new MemoryDocumentRepository("local");
    const cloud = new MemoryDocumentRepository("cloud");
    const app = createMockApplication({ localRepository: local });
    app.repositories.cloud = cloud;
    return { app, local, cloud };
}

async function store(repository: IDocumentRepository, id: string, thumbnail?: string): Promise<DocumentMeta> {
    await repository.save({ id, name: "Bracket", data: data(id), kind: "manual", thumbnail });
    return (await repository.list()).value!.items.find((x) => x.id === id)!;
}

/** An open document that saves through whatever repository it currently has. */
function openDocument(id: string, repository: IDocumentRepository) {
    const doc = {
        id,
        name: "Bracket (open)",
        repository,
        version: "v1" as string | undefined,
        saves: [] as SaveKind[],
        serialize: () => data(id, "Bracket (open)"),
        async save(kind: SaveKind = "manual") {
            doc.saves.push(kind);
            return doc.repository.save({ id, name: doc.name, data: doc.serialize(), kind });
        },
    };
    return doc;
}

describe("transferDocument", () => {
    test("moves a stored local document to the cloud: saved there, removed here", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(local, "a", "data:image/png;base64,AA");

        const moved = await transferDocument(app, meta, cloud, { keepSource: false });

        expect(moved.value?.status).toBe("saved");
        expect(cloud.documents.get("a")).toMatchObject({
            id: "a",
            name: "Bracket",
            thumbnail: meta.thumbnail,
        });
        expect(local.documents.has("a")).toBe(false);
    });

    test("keeping the source copies instead", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(local, "a");

        await transferDocument(app, meta, cloud, { keepSource: true });

        // The copy gets a new id, so the two never overwrite each other later.
        expect(cloud.documents.has("a")).toBe(false);
        const [copy] = [...cloud.documents.values()];
        expect(copy.data).toMatchObject({ id: copy.id, name: "Bracket" });
        expect(local.documents.has("a")).toBe(true);
    });

    describe("the target has a document with the same id", () => {
        async function withExisting() {
            const context = setup();
            const meta = await store(context.cloud, "a");
            await context.local.save({
                id: "a",
                name: "Kept copy",
                data: data("a", "Kept copy"),
                kind: "manual",
            });
            return { ...context, meta };
        }

        test("without a resolver both are kept: nothing is overwritten", async () => {
            const { app, local, cloud, meta } = await withExisting();

            const moved = await transferDocument(app, meta, local, { keepSource: false });

            expect(moved.value?.status).toBe("saved");
            expect(local.documents.get("a")?.name).toBe("Kept copy");
            expect([...local.documents.values()].map((x) => x.name).sort()).toEqual(["Bracket", "Kept copy"]);
            expect(cloud.documents.has("a")).toBe(false);
        });

        test.each([
            ["replace", "Bracket", false],
            ["cancel", "Kept copy", true],
        ] as const)("%s", async (choice, localName, stillInCloud) => {
            const { app, local, cloud, meta } = await withExisting();
            const asked: ExistingDocument[] = [];

            const moved = await transferDocument(app, meta, local, {
                keepSource: false,
                resolveExisting: async (existing) => {
                    asked.push(existing);
                    return choice;
                },
            });

            expect(asked).toEqual([{ name: "Kept copy", canReplace: true }]);
            expect(moved.value?.status).toBe(choice === "cancel" ? "cancelled" : "saved");
            expect(local.documents.get("a")?.name).toBe(localName);
            expect(local.documents.size).toBe(1);
            expect(cloud.documents.has("a")).toBe(stillInCloud);
        });

        test("an open document with the id, even in another repository, can't be replaced", async () => {
            const { app, local, meta } = await withExisting();
            app.documents.add(openDocument("a", local) as unknown as IDocument);
            const asked: ExistingDocument[] = [];

            await transferDocument(app, meta, local, {
                keepSource: false,
                resolveExisting: async (existing) => {
                    asked.push(existing);
                    return "replace";
                },
            });

            expect(asked[0].canReplace).toBe(false);
            expect(local.documents.get("a")?.name).toBe("Kept copy");
            expect(local.documents.size).toBe(2);
        });

        test("a replaced cloud document gets a new version on top of its head, restored from the trash", async () => {
            const { app, local } = setup();
            const meta = await store(local, "a");
            const saves: SaveRequest[] = [];
            const restored: string[] = [];
            const cloud: IDocumentRepository = {
                kind: "cloud",
                list: async () => Result.ok({ items: [] }),
                load: async () => Result.err({ kind: "notFound", id: "a" }),
                delete: async () => Result.ok(undefined),
                stat: async () => Result.ok({ name: "Old", version: "head-1", trashed: true }),
                restore: async (id) => {
                    restored.push(id);
                    return Result.ok(undefined);
                },
                save: async (request) => {
                    saves.push(request);
                    return Result.ok({ status: "saved", updatedAt: 1, version: "head-2" });
                },
            };

            await transferDocument(app, meta, cloud, {
                keepSource: false,
                resolveExisting: async () => "replace",
            });

            expect(restored).toEqual(["a"]);
            expect(saves.map((x) => [x.id, x.baseVersion])).toEqual([["a", "head-1"]]);
        });
    });

    test("an open document that moves announces its new repository (edit locks follow)", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(local, "a");
        const doc = openDocument("a", local);
        app.documents.add(doc as unknown as IDocument);
        const changes: [unknown, unknown][] = [];
        const listener = (document: IDocument, previous: IDocumentRepository) =>
            changes.push([document, previous]);
        PubSub.default.sub("documentRepositoryChanged", listener);
        try {
            await transferDocument(app, meta, cloud, { keepSource: false });
        } finally {
            PubSub.default.remove("documentRepositoryChanged", listener);
        }

        expect(changes).toEqual([[doc, local]]);
    });

    test("moves back from the cloud to this device", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(cloud, "a");

        await transferDocument(app, meta, local, { keepSource: false });

        expect(local.documents.get("a")?.data).toEqual(data("a"));
        expect(cloud.documents.has("a")).toBe(false);
    });

    test("an open document is saved from memory and from then on saves to the target", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(local, "a");
        const doc = openDocument("a", local);
        app.documents.add(doc as unknown as IDocument);

        await transferDocument(app, meta, cloud, { keepSource: false });

        expect(doc.repository).toBe(cloud);
        expect(doc.version).toBeUndefined();
        expect(cloud.documents.get("a")?.data).toEqual(data("a", "Bracket (open)"));
        expect(local.documents.has("a")).toBe(false);
    });

    test("a failed save keeps the source and the open document where they were", async () => {
        const { app, local, cloud } = setup();
        const meta = await store(local, "a");
        const doc = openDocument("a", local);
        app.documents.add(doc as unknown as IDocument);
        cloud.failWith = { kind: "offline" };

        const moved = await transferDocument(app, meta, cloud, { keepSource: false });

        expect(moved.error).toEqual({ kind: "offline" });
        expect(doc.repository).toBe(local);
        expect(doc.version).toBe("v1");
        expect(local.documents.has("a")).toBe(true);
    });

    test("a conflict (the id exists in the target) keeps the source", async () => {
        const { app, local } = setup();
        const meta = await store(local, "a");
        const conflicting: IDocumentRepository = {
            kind: "cloud",
            list: async () => Result.ok({ items: [] }),
            load: async () => Result.err({ kind: "notFound", id: "a" }),
            delete: async () => Result.ok(undefined),
            save: async () => Result.ok({ status: "conflict", headVersion: "h" }),
        };

        const moved = await transferDocument(app, meta, conflicting, { keepSource: false });

        expect(moved.value).toEqual({ status: "conflict", headVersion: "h" });
        expect(local.documents.has("a")).toBe(true);
    });
});

describe("saveDocumentCopy", () => {
    test("saves the open content under a new id and name", async () => {
        const { app, local, cloud } = setup();
        const doc = openDocument("a", cloud);

        const copy = await saveDocumentCopy(app, doc as unknown as IDocument, local, "Bracket (copy)");

        expect(copy.isOk).toBe(true);
        expect(copy.value!.id).not.toBe("a");
        const saved = local.documents.get(copy.value!.id)!;
        expect(saved.name).toBe("Bracket (copy)");
        expect(saved.data).toMatchObject({ id: copy.value!.id, name: "Bracket (copy)" });
        expect(saved.baseVersion).toBeUndefined();
        expect(doc.repository).toBe(cloud);
    });
});
