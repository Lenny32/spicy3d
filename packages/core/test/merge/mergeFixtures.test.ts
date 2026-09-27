// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    CONFLICT_KINDS,
    DocumentMigrations,
    I18N_KEYS,
    isWithinMergePath,
    mergePath,
    parseMergePath,
    type Serialized,
} from "../../src";
import { loadMergeFixtures, MERGE_FIXTURE_DOCUMENTS, MERGE_FIXTURE_ROOT } from "../../test-utils";
import { buildMergeFixtureCases } from "./fixtureCases";

// The merge fixture corpus is well-formed and matches its generator (`fixtureCases.ts`). The merge
// itself is CLOUD-12's; this only guards the inputs and the expected answers it will be held to.

/** JSON as the files hold it: `undefined` sides dropped. */
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

if (process.env["SPICY3D_UPDATE_MERGE_FIXTURES"] === "1") {
    rmSync(MERGE_FIXTURE_ROOT, { recursive: true, force: true });
    for (const fixture of buildMergeFixtureCases()) {
        const folder = path.join(MERGE_FIXTURE_ROOT, fixture.name);
        mkdirSync(folder, { recursive: true });
        for (const file of MERGE_FIXTURE_DOCUMENTS) {
            writeFileSync(path.join(folder, `${file}.json`), `${JSON.stringify(fixture[file], null, 4)}\n`);
        }
        const conflicts = { description: fixture.description, conflicts: fixture.conflicts };
        writeFileSync(path.join(folder, "conflicts.json"), `${JSON.stringify(conflicts, null, 4)}\n`);
    }
}

interface StoredNode {
    id: string;
    parentId?: string;
    __cla$$__: string;
    featuresJson?: string;
    dataJson?: string;
    [key: string]: unknown;
}

function nodesOf(doc: Serialized): StoredNode[] {
    return doc["models"].nodes;
}

function expectUniqueIds(items: readonly { id: unknown }[]): void {
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
}

/** A document the app could have saved: migrates, a pre-order tree, unique ids, parsable payloads. */
function expectWellFormed(doc: Serialized): void {
    expect(DocumentMigrations.migrate(doc).isOk).toBe(true);
    const nodes = nodesOf(doc);
    expect(nodes[0].parentId).toBeUndefined();
    expectUniqueIds(nodes);
    // strictly pre-order: re-flattening the tree depth-first gives the stored order back
    const children = new Map<string, string[]>();
    for (const node of nodes.slice(1))
        children.set(node.parentId!, [...(children.get(node.parentId!) ?? []), node.id]);
    const flattened: string[] = [];
    const visit = (id: string) => {
        flattened.push(id);
        for (const child of children.get(id) ?? []) visit(child);
    };
    visit(nodes[0].id);
    expect(flattened).toEqual(nodes.map((node) => node.id));
    for (const node of nodes) {
        if (node.featuresJson !== undefined) expectUniqueIds(JSON.parse(node.featuresJson));
        if (node.dataJson !== undefined) {
            const data = JSON.parse(node.dataJson);
            expectUniqueIds(data.entities);
            expectUniqueIds(data.constraints);
            for (const entity of data.entities) expect(Number.isSafeInteger(entity.id)).toBe(true);
        }
    }
    expectUniqueIds(doc["variables"]);
}

const fixtures = loadMergeFixtures();

test("the corpus covers the ticket's cases and more", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    expect(fixtures.map((x) => x.name)).toEqual(
        expect.arrayContaining([
            "feature-params-different-features",
            "feature-same-param-conflict",
            "delete-sketch-vs-add-constraint",
            "timeline-insert-same-position",
            "delete-feature-vs-fillet-on-its-edge",
            "rename-variable-vs-new-expression",
            "both-add-sketch-line",
            "tree-move-cycle",
            "identity-unchanged",
        ]),
    );
    const kinds = new Set(fixtures.flatMap((x) => x.conflicts.map((c) => c.kind)));
    // every kind (rebuild-failure is observed by the kernel validation pass)
    expect([...kinds].sort()).toEqual([...CONFLICT_KINDS].sort());
});

test("the files are what fixtureCases.ts generates (npm run merge:fixtures rewrites them)", () => {
    const generated = buildMergeFixtureCases();
    expect(fixtures.map((x) => x.name)).toEqual(generated.map((x) => x.name));
    for (const [index, fixture] of generated.entries()) {
        const stored = fixtures[index];
        for (const file of MERGE_FIXTURE_DOCUMENTS) expect(stored[file]).toEqual(asStored(fixture[file]));
        expect(stored.description).toBe(fixture.description);
        expect(stored.conflicts).toEqual(asStored(fixture.conflicts));
    }
    for (const folder of readdirSync(MERGE_FIXTURE_ROOT)) {
        expect(readdirSync(path.join(MERGE_FIXTURE_ROOT, folder)).sort()).toEqual(
            ["base.json", "conflicts.json", "expected.json", "ours.json", "theirs.json"].sort(),
        );
    }
});

describe.each(fixtures.map((x) => [x.name, x] as const))("merge fixture %s", (_name, fixture) => {
    test.each(MERGE_FIXTURE_DOCUMENTS)("%s is a well-formed document", (file) => {
        expectWellFormed(fixture[file]);
    });

    test("ours and theirs each differ from the base unless it is an identity case", () => {
        const base = JSON.stringify(fixture.base);
        const changed = [fixture.ours, fixture.theirs].filter((doc) => JSON.stringify(doc) !== base);
        expect(changed.length > 0).toBe(fixture.name !== "identity-unchanged");
    });

    test("the expected conflicts are well-formed", () => {
        const paths = fixture.conflicts.map((c) => c.path);
        expect(new Set(paths).size).toBe(paths.length);
        for (const conflict of fixture.conflicts) {
            expect(CONFLICT_KINDS).toContain(conflict.kind);
            expect(I18N_KEYS).toContain(conflict.messageKey);
            expect(conflict.choices.length).toBeGreaterThan(0);
            const [root, ...segments] = parseMergePath(conflict.path);
            expect(mergePath(root as "node", ...segments)).toBe(conflict.path);
            expect(["doc", "variable", "act", "material", "component", "node"]).toContain(root);
            // the node a conflict is about exists on some side
            if (root === "node") {
                const all = [fixture.base, fixture.ours, fixture.theirs].flatMap(nodesOf).map((n) => n.id);
                expect(all).toContain(segments[0]);
                expect(isWithinMergePath(conflict.path, mergePath("node", segments[0]))).toBe(true);
            }
        }
    });
});
