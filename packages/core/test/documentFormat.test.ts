// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
    DOCUMENT_FORMAT_VERSION,
    DOCUMENT_MODULE,
    DocumentMigrations,
    MigrationRegistry,
    migrateDocument,
    type Serialized,
} from "../src";
import { loadDocumentFixtures } from "../test-utils";

function envelope(extra: Record<string, unknown> = {}): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id: "doc",
        name: "Doc",
        models: { nodes: [], components: [], materials: [] },
        variables: [],
        acts: [],
        userData: { keep: [1, 2, 3] },
        ...extra,
    };
}

/** A format whose v0 stored the name under `title`; v1 renamed it to `name`. */
function renameRegistry() {
    const registry = new MigrationRegistry(1, 0);
    registry.registerMigration(DOCUMENT_MODULE, 0, ({ title, ...rest }) => ({ ...rest, name: title }));
    return registry;
}

describe("MigrationRegistry.migrate", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    test("a current-format document comes back unchanged, as a copy", () => {
        const data = envelope();

        const result = new MigrationRegistry(1).migrate(data);

        expect(result.isOk).toBe(true);
        expect(result.value).toEqual(data);
        expect(result.value).not.toBe(data);
    });

    test("a synthetic v0 document runs the chain up to v1", () => {
        const { name: _name, ...v0 } = envelope({ formatVersion: 0, title: "Old" });

        const result = renameRegistry().migrate(v0);

        expect(result.isOk).toBe(true);
        expect(result.value["name"]).toBe("Old");
        expect(result.value["title"]).toBeUndefined();
        expect(result.value["formatVersion"]).toBe(1);
    });

    test("steps run in order across several versions and modules", () => {
        const registry = new MigrationRegistry(3);
        registry.registerModule("sketch", 2);
        const trail = (tag: string) => (data: Serialized) => ({
            ...data,
            trail: [...(data["trail"] ?? []), tag],
        });
        registry.registerMigration(DOCUMENT_MODULE, 2, trail("doc2"));
        registry.registerMigration("sketch", 1, trail("sketch1"));
        registry.registerMigration(DOCUMENT_MODULE, 1, trail("doc1"));

        const result = registry.migrate(envelope({ formatVersion: 1, moduleVersions: { sketch: 1 } }));

        expect(result.value["trail"]).toEqual(["doc1", "doc2", "sketch1"]);
        expect(result.value["formatVersion"]).toBe(3);
        expect(result.value["moduleVersions"]).toEqual({ sketch: 2 });
    });

    test("a module missing from moduleVersions reads as its minimum version", () => {
        const registry = new MigrationRegistry(1);
        registry.registerModule("parametric", 2);
        const migrate = rs.fn((data: Serialized) => data);
        registry.registerMigration("parametric", 1, migrate);

        const result = registry.migrate(envelope({ moduleVersions: undefined }));

        expect(migrate).toHaveBeenCalledTimes(1);
        expect(result.value["moduleVersions"]).toEqual({ parametric: 2 });
    });

    test("versions of modules this build does not know pass through", () => {
        const result = new MigrationRegistry(1).migrate(envelope({ moduleVersions: { myPlugin: 7 } }));

        expect(result.value["moduleVersions"]).toEqual({ myPlugin: 7 });
    });

    test("userData is hidden from migrations and restored untouched", () => {
        const registry = new MigrationRegistry(2);
        const seen = rs.fn((data: Serialized) => ({ ...data, userData: "overwritten" }));
        registry.registerMigration(DOCUMENT_MODULE, 1, seen);
        const data = envelope();

        const result = registry.migrate(data);

        expect(seen.mock.calls[0][0]["userData"]).toBeUndefined();
        expect(result.value["userData"]).toEqual({ keep: [1, 2, 3] });
    });

    test("the input document is never modified", () => {
        const registry = new MigrationRegistry(2);
        registry.registerMigration(DOCUMENT_MODULE, 1, (data) => {
            data["models"].nodes.push({ __cla$$__: "FolderNode" });
            return data;
        });
        const data = envelope();
        const before = structuredClone(data);

        registry.migrate(data);

        expect(data).toEqual(before);
    });

    test("a document from a newer build is rejected with the versions involved", () => {
        const result = new MigrationRegistry().migrate(
            envelope({ formatVersion: DOCUMENT_FORMAT_VERSION + 1 }),
        );

        expect(result.isOk).toBe(false);
        expect(result.error).toEqual({
            kind: "newerFormat",
            module: DOCUMENT_MODULE,
            version: DOCUMENT_FORMAT_VERSION + 1,
            supported: DOCUMENT_FORMAT_VERSION,
        });
    });

    test("a module newer than the build is rejected", () => {
        const registry = new MigrationRegistry();
        registry.registerModule("sketch", 1);

        const result = registry.migrate(envelope({ moduleVersions: { sketch: 2 } }));

        expect(result.error).toEqual({ kind: "newerFormat", module: "sketch", version: 2, supported: 1 });
    });

    test.each([
        ["a Chili3D document", { __cla$$__: "Document", version: "0.6", name: "x" }],
        ["a missing format version", { __cla$$__: "Document", name: "x" }],
        ["a string format version", envelope({ formatVersion: "1" })],
        ["a fractional format version", envelope({ formatVersion: 1.5 })],
        ["a version older than the chain", envelope({ formatVersion: 0 })],
        ["malformed module versions", envelope({ moduleVersions: [1] })],
        ["an array", []],
        ["null", null],
        ["a string", "{}"],
    ])("%s is not a Spicy3D document", (_name, data) => {
        const result = new MigrationRegistry().migrate(data);

        expect(result.isOk).toBe(false);
        expect(result.error).toEqual({ kind: "notSpicy3D" });
    });

    test("a throwing step reports where the chain broke", () => {
        const registry = new MigrationRegistry(2);
        registry.registerMigration(DOCUMENT_MODULE, 1, () => {
            throw new Error("boom");
        });

        const result = registry.migrate(envelope());

        expect(result.error).toEqual({
            kind: "migrationFailed",
            module: DOCUMENT_MODULE,
            from: 1,
            message: "boom",
        });
    });

    test("a step that returns a non-object fails the chain", () => {
        const registry = new MigrationRegistry(2);
        registry.registerMigration(DOCUMENT_MODULE, 1, () => undefined as unknown as Serialized);

        const result = registry.migrate(envelope());

        expect(result.isOk).toBe(false);
        expect(result.error.kind).toBe("migrationFailed");
    });

    test("migrations run without DOM or WASM globals", () => {
        rs.stubGlobal("window", undefined);
        rs.stubGlobal("document", undefined);
        rs.stubGlobal("shapeFactory", undefined);
        const { name: _name, ...v0 } = envelope({ formatVersion: 0, title: "Old" });

        const result = renameRegistry().migrate(v0);

        expect(result.value["name"]).toBe("Old");
    });
});

describe("MigrationRegistry registration", () => {
    test("rejects duplicate modules and steps", () => {
        const registry = new MigrationRegistry(2);
        registry.registerMigration(DOCUMENT_MODULE, 1, (data) => data);

        expect(() => registry.registerModule(DOCUMENT_MODULE, 1)).toThrow(/already registered/);
        expect(() => registry.registerMigration(DOCUMENT_MODULE, 1, (data) => data)).toThrow(
            /already registered/,
        );
    });

    test("rejects steps outside the module's chain or for unknown modules", () => {
        const registry = new MigrationRegistry(2);

        expect(() => registry.registerMigration(DOCUMENT_MODULE, 0, (data) => data)).toThrow(
            /outside the chain/,
        );
        expect(() => registry.registerMigration(DOCUMENT_MODULE, 2, (data) => data)).toThrow(
            /outside the chain/,
        );
        expect(() => registry.registerMigration("nope", 1, (data) => data)).toThrow(/not registered/);
    });

    test("findGaps lists every missing step", () => {
        const registry = new MigrationRegistry(3);
        registry.registerModule("sketch", 2, 0);
        registry.registerMigration(DOCUMENT_MODULE, 2, (data) => data);
        registry.registerMigration("sketch", 0, (data) => data);

        expect(registry.findGaps()).toEqual([
            { module: DOCUMENT_MODULE, from: 1 },
            { module: "sketch", from: 1 },
        ]);
    });

    test("the application registry has no gaps", () => {
        expect(DocumentMigrations.findGaps()).toEqual([]);
        expect(DocumentMigrations.currentVersion(DOCUMENT_MODULE)).toBe(DOCUMENT_FORMAT_VERSION);
    });
});

describe("document fixture corpus", () => {
    const fixtures = loadDocumentFixtures();

    test("holds at least one document for every format version up to the current one", () => {
        const versions = new Set(fixtures.map((x) => x.version));
        for (let version = 1; version <= DOCUMENT_FORMAT_VERSION; version++) {
            expect(versions.has(version)).toBe(true);
        }
    });

    test.each(
        fixtures.map((x) => [x.name, x] as const),
    )("%s migrates to the current format", (_name, fixture) => {
        expect(fixture.data["formatVersion"]).toBe(fixture.version);

        const result = migrateDocument(fixture.data);

        expect(result.isOk).toBe(true);
        expect(result.value["formatVersion"]).toBe(DOCUMENT_FORMAT_VERSION);
        expect(result.value["userData"]).toEqual(fixture.data["userData"]);
    });
});

describe("document format 2 (construction expressions)", () => {
    const fixtures = loadDocumentFixtures();
    const fixture = (name: string) => {
        const found = fixtures.find((x) => x.name === name);
        expect(found).not.toBeUndefined();
        return found!;
    };
    const definitions = (data: Serialized) =>
        (data["models"] as { nodes: Record<string, any>[] }).nodes
            .filter((x) => x["__cla$$__"] === "ConstructionNode")
            .map((x) => JSON.parse(x["definitionJson"]));

    test("is the running version, reached from 1 without a gap", () => {
        expect(DOCUMENT_FORMAT_VERSION).toBe(2);
        expect(DocumentMigrations.currentVersion(DOCUMENT_MODULE)).toBe(2);
        expect(DocumentMigrations.findGaps()).toEqual([]);
    });

    test.each(
        fixtures.filter((x) => x.version === 1).map((x) => [x.name, x] as const),
    )("%s (document 1) migrates with its models and variables untouched", (_name, { data }) => {
        const original = structuredClone(data);

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["formatVersion"]).toBe(2);
        expect(migrated.value["models"]).toEqual(original["models"]);
        expect(migrated.value["variables"]).toEqual(original["variables"]);
        // Pure: the input is left as it was.
        expect(data).toEqual(original);
    });

    test("a document 1 construction keeps its number distance through the migration", () => {
        const v1 = {
            ...envelope(),
            models: {
                nodes: [
                    {
                        __cla$$__: "ConstructionNode",
                        id: "plane-1",
                        definitionJson: JSON.stringify({
                            kind: "plane-offset",
                            source: { kind: "origin-plane", plane: "YZ" },
                            distance: 12.5,
                        }),
                    },
                ],
                components: [],
                materials: [],
            },
        };

        const migrated = migrateDocument(v1);

        expect(migrated.isOk).toBe(true);
        expect(definitions(migrated.value)).toEqual([
            { kind: "plane-offset", source: { kind: "origin-plane", plane: "YZ" }, distance: 12.5 },
        ]);
    });

    test("a document 2 with expression parameters needs no migration", () => {
        const { data } = fixture("v2/construction-expressions.json");
        expect(data["formatVersion"]).toBe(2);

        const migrated = migrateDocument(data);

        expect(migrated.isOk).toBe(true);
        expect(migrated.value["models"]).toEqual(data["models"]);
        expect(definitions(migrated.value).map((x) => [x.kind, x.distance ?? x.angle, x.offset])).toEqual([
            ["plane-offset", "sec_x_1", undefined],
            ["plane-offset", "sec_x_1 * 2 + 5 mm", undefined],
            ["plane-offset", 7.5, undefined],
            ["plane-angle", "tilt", "sec_x_1 / 4"],
        ]);
    });
});
