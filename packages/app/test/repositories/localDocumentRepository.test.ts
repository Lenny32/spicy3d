// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { beforeEach, describe, expect, test } from "@rstest/core";
import { Constants, type IStorage, type Serialized } from "@spicy3d/core";
import { LocalDocumentRepository } from "../../src/repositories";

/** An in-memory IStorage paging like IndexedDBStorage (by key order), with a small page size. */
class MemoryStorage implements IStorage {
    readonly tables = new Map<string, Map<string, any>>();
    failure: unknown;

    constructor(private readonly pageSize = 2) {}

    private table(database: string, table: string) {
        const key = `${database}/${table}`;
        if (!this.tables.has(key)) this.tables.set(key, new Map());
        return this.tables.get(key)!;
    }

    private check() {
        if (this.failure !== undefined) throw this.failure;
    }

    async createDBIfNeeded(): Promise<void> {}

    async get(database: string, table: string, id: string) {
        this.check();
        return this.table(database, table).get(id);
    }

    async put(database: string, table: string, id: string, value: any) {
        this.check();
        this.table(database, table).set(id, value);
        return true;
    }

    async delete(database: string, table: string, id: string) {
        this.check();
        this.table(database, table).delete(id);
        return true;
    }

    async page(database: string, table: string, page: number) {
        this.check();
        const sorted = [...this.table(database, table).entries()].sort(([a], [b]) => a.localeCompare(b));
        return sorted.slice(page * this.pageSize, (page + 1) * this.pageSize).map(([, value]) => value);
    }
}

const data = (id: string): Serialized => ({ id, name: id, formatVersion: 1 }) as unknown as Serialized;

describe("LocalDocumentRepository", () => {
    let storage: MemoryStorage;
    let clock: number;
    let repository: LocalDocumentRepository;

    const save = (id: string, name = id, thumbnail?: string) =>
        repository.save({ id, name, data: data(id), kind: "manual", thumbnail });

    beforeEach(() => {
        storage = new MemoryStorage();
        clock = 1000;
        repository = new LocalDocumentRepository(storage, () => clock++);
    });

    test("is the local repository", () => {
        expect(repository.kind).toBe("local");
    });

    test("a saved document loads back", async () => {
        const saved = await save("a");
        const loaded = await repository.load("a");

        expect(saved.value).toEqual({ status: "saved", updatedAt: 1000 });
        expect(loaded.value).toEqual({ data: data("a") });
    });

    test("keeps today's IndexedDB layout: data in documents, the listing entry in recents", async () => {
        await save("a", "Part A", "data:image/png;base64,xx");

        expect(storage.tables.get(`${Constants.DBName}/${Constants.DocumentTable}`)?.get("a")).toEqual(
            data("a"),
        );
        expect(storage.tables.get(`${Constants.DBName}/${Constants.RecentTable}`)?.get("a")).toEqual({
            id: "a",
            name: "Part A",
            date: 1000,
            image: "data:image/png;base64,xx",
        });
    });

    test("loading an unknown id is notFound", async () => {
        const loaded = await repository.load("missing");

        expect(loaded.isOk).toBe(false);
        expect(loaded.error).toEqual({ kind: "notFound", id: "missing" });
    });

    test("lists every stored page, most recently saved first", async () => {
        for (const id of ["c", "a", "e", "b", "d"]) await save(id);
        await save("a", "a", "data:thumb");

        const page = await repository.list();

        expect(page.value.items.map((x) => x.id)).toEqual(["a", "d", "b", "e", "c"]);
        expect(page.value.items[0]).toEqual({
            id: "a",
            name: "a",
            updatedAt: 1005,
            thumbnail: "data:thumb",
            location: "local",
        });
        expect(page.value.items[1].thumbnail).toBeUndefined();
        expect(page.value.nextCursor).toBeUndefined();
    });

    test("pages with a cursor", async () => {
        for (const id of ["a", "b", "c"]) await save(id);

        const first = await repository.list({ limit: 2 });
        const second = await repository.list({ limit: 2, cursor: first.value.nextCursor });

        expect(first.value.items.map((x) => x.id)).toEqual(["c", "b"]);
        expect(first.value.nextCursor).toBe("2");
        expect(second.value.items.map((x) => x.id)).toEqual(["a"]);
        expect(second.value.nextCursor).toBeUndefined();
    });

    test("filters by name, case-insensitively", async () => {
        await save("1", "Bracket");
        await save("2", "Gear");
        await save("3", "big bracket");

        const page = await repository.list({ search: "BRACK" });

        expect(page.value.items.map((x) => x.name)).toEqual(["big bracket", "Bracket"]);
    });

    test("delete removes the document and its listing entry", async () => {
        await save("a");
        await save("b");

        const deleted = await repository.delete("a");

        expect(deleted.isOk).toBe(true);
        expect((await repository.load("a")).error).toEqual({ kind: "notFound", id: "a" });
        expect((await repository.list()).value.items.map((x) => x.id)).toEqual(["b"]);
    });

    test.each([
        ["a full quota", new DOMException("full", "QuotaExceededError"), { kind: "quota" }],
        [
            "an IndexedDB error event",
            { target: { error: new DOMException("full", "QuotaExceededError") } },
            { kind: "quota" },
        ],
        ["any other failure", new Error("disk on fire"), { kind: "failed", message: "disk on fire" }],
    ])("reports %s as a Result instead of throwing", async (_name, failure, expected) => {
        storage.failure = failure;

        const results = [
            await save("a"),
            await repository.load("a"),
            await repository.list(),
            await repository.delete("a"),
        ];

        for (const result of results) {
            expect(result.isOk).toBe(false);
            expect(result.error).toEqual(expected);
        }
    });
});
