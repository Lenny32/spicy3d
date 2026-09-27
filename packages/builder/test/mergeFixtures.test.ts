// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyResolutions,
    DocumentMigrations,
    deepFreeze,
    type MergeConflict,
    type MergeResult,
    mergeDocuments,
    resolveMerge,
    type Serialized,
} from "@spicy3d/core";
import { loadMergeFixtures, type MergeFixture } from "@spicy3d/core/test-utils";
// Every package that registers merge rules.
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// The merge engine (CLOUD-12) on the CLOUD-11 fixture corpus: each case merges to its expected
// document and conflicts, deterministically and without touching its inputs, and every choice of
// every conflict applies. `rebuild-failure`s come from the kernel validation pass
// (packages/parametric/test/mergeValidation.kernel.test.ts).

const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fixtures = loadMergeFixtures();

function merge(fixture: MergeFixture): MergeResult {
    const [base, ours, theirs] = [fixture.base, fixture.ours, fixture.theirs].map(deepFreeze);
    const result = mergeDocuments(base, ours, theirs);
    expect(result.isOk).toBe(true);
    return result.value;
}

interface StoredNode {
    id: string;
    parentId?: string;
    [key: string]: unknown;
}

function nodesOf(doc: Serialized): StoredNode[] {
    return doc["models"].nodes;
}

/** A document the app can load: migrates, strictly pre-order, unique ids, parsable payloads. */
function expectLoadable(doc: Serialized): void {
    expect(DocumentMigrations.migrate(doc).isOk).toBe(true);
    const nodes = nodesOf(doc);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const children = new Map<string, string[]>();
    for (const node of nodes.slice(1))
        children.set(node.parentId!, [...(children.get(node.parentId!) ?? []), node.id]);
    const flattened: string[] = [];
    const visit = (id: string) => {
        flattened.push(id);
        for (const child of children.get(id) ?? []) visit(child);
    };
    visit(nodes[0].id);
    expect(flattened).toEqual(ids);
    for (const node of nodes) {
        for (const key of ["featuresJson", "dataJson", "definitionJson", "planeRefJson"]) {
            if (typeof node[key] === "string") expect(() => JSON.parse(node[key] as string)).not.toThrow();
        }
    }
}

describe.each(fixtures.map((f) => [f.name, f] as const))("merge fixture %s", (_name, fixture) => {
    test("merges to the expected document and conflicts, inputs untouched", () => {
        const copies = [fixture.base, fixture.ours, fixture.theirs].map((x) => structuredClone(x));
        const result = merge(fixture);
        const structural = fixture.conflicts.filter((c) => c.kind !== "rebuild-failure");
        expect(asStored(result.conflicts)).toEqual(structural);
        expect(result.merged).toEqual(fixture.expected);
        expect([fixture.base, fixture.ours, fixture.theirs]).toEqual(copies);
    });

    test("is deterministic: byte-identical merged, same conflicts in the same order", () => {
        const first = merge(fixture);
        const second = merge(fixture);
        expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
        expect(JSON.stringify(second.conflicts)).toBe(JSON.stringify(first.conflicts));
    });

    const structural = fixture.conflicts.filter((c) => c.kind !== "rebuild-failure");
    const choices = structural.flatMap((c) => c.choices.map((choice) => [c.path, choice] as const));
    if (choices.length > 0) {
        test.each(
            choices,
        )("resolving %s as %s gives a loadable document without that conflict", (path, choice) => {
            const resolved = resolveMerge(merge(fixture), [{ path, choice }]);
            expect(resolved.isOk).toBe(true);
            expectLoadable(resolved.value.merged);
            expect(resolved.value.conflicts.map((c) => c.path)).not.toContain(path);
        });
        test.each(
            structural.map((c) => [c.path, c.choices[0]] as const),
        )("%s resolved as its first choice (%s) is what the unresolved merge holds", (path, choice) => {
            const result = merge(fixture);
            expect(applyResolutions(result, [{ path, choice }]).value).toEqual(result.merged);
        });
    }
});

// ------------------------------------------------------------------ What each choice does

function fixture(name: string): MergeFixture {
    return fixtures.find((f) => f.name === name)!;
}

function resolved(name: string, path: string, choice: MergeConflict["choices"][number]): MergeResult {
    const result = resolveMerge(merge(fixture(name)), [{ path, choice }]);
    expect(result.isOk).toBe(true);
    return result.value;
}

function node(doc: Serialized, id: string): StoredNode | undefined {
    return nodesOf(doc).find((n) => n.id === id);
}

function features(doc: Serialized, body = "body-1"): { id: string; [key: string]: unknown }[] {
    return JSON.parse(node(doc, body)!["featuresJson"] as string);
}

describe("resolutions", () => {
    test("a property conflict resolved theirs takes theirs' value", () => {
        const merged = resolved(
            "feature-same-param-conflict",
            "node/body-1/feature/f1/param/depth",
            "theirs",
        ).merged;
        expect(features(merged).find((f) => f.id === "f1")!["depth"]).toBe(15);
    });

    test("delete-vs-modify: theirs restores the node this device deleted, or deletes the one it kept", () => {
        const box = "seFZEYsHrtzwpOiyaxckw";
        const restored = resolved("delete-node-vs-modify", `node/${box}`, "theirs").merged;
        expect(node(restored, box)?.["dx"]).toBe(25);
        const deleted = resolved("delete-node-vs-modify-theirs-deleted", `node/${box}`, "theirs").merged;
        expect(node(deleted, box)).toBeUndefined();
    });

    test("concurrent inserts: theirs-first swaps them, ours / theirs drops the other side's", () => {
        const path = "node/body-1/insertAfter/f3";
        const ids = (choice: MergeConflict["choices"][number]) =>
            features(resolved("timeline-insert-same-position", path, choice).merged).map((f) => f.id);
        expect(ids("theirs-first")).toEqual(["f1", "f2", "f3", "theirs-cut", "ours-boss"]);
        expect(ids("ours")).toEqual(["f1", "f2", "f3", "ours-boss"]);
        expect(ids("theirs")).toEqual(["f1", "f2", "f3", "theirs-cut"]);
    });

    test("a feature reordered differently: theirs takes theirs' position", () => {
        const merged = resolved(
            "timeline-reorder-conflict",
            "node/body-1/feature/f4/position",
            "theirs",
        ).merged;
        expect(features(merged).map((f) => f.id)).toEqual(["f1", "f2", "f4", "f3"]);
    });

    test("a dangling reference: ours takes this device's referrer and target, theirs the other's", () => {
        const path = "node/body-1/feature/boss-fillet/param/edges";
        const ours = resolved("delete-feature-vs-fillet-on-its-edge", path, "ours");
        expect(features(ours.merged).map((f) => f.id)).toEqual(["f1", "f2"]);
        const theirs = resolved("delete-feature-vs-fillet-on-its-edge", path, "theirs");
        expect(features(theirs.merged).map((f) => f.id)).toEqual(["f1", "f2", "f3", "boss-fillet"]);
        expect(theirs.conflicts).toEqual([]);
    });

    test("taking theirs' side of a renamed variable makes the other expression dangle: a new conflict", () => {
        const result = resolved(
            "rename-variable-vs-new-expression",
            "node/body-1/feature/f1/param/depth",
            "theirs",
        );
        expect(result.merged["variables"].map((v: { name: string }) => v.name)).toEqual(["w", "h"]);
        expect(result.conflicts.map((c) => [c.kind, c.path])).toEqual([
            ["dangling-ref", "variable/v2/expression"],
        ]);
    });

    test("a duplicate variable name: theirs keeps the other device's definition instead", () => {
        const merged = resolved("variables-same-name-both-add", "variable/var-theirs/name", "theirs").merged;
        const added = merged["variables"].filter((v: { name: string }) => v.name === "thickness");
        expect(added).toEqual([{ id: "var-theirs", name: "thickness", expression: "3 mm", type: "length" }]);
    });

    test("a cycle resolved theirs keeps theirs' move and reverts ours'", () => {
        const merged = resolved("tree-move-cycle", "node/folder-b/parent", "theirs").merged;
        expect(node(merged, "folder-b")?.parentId).toBe("folder-a");
        expect(node(merged, "folder-a")?.parentId).toBe(nodesOf(merged)[0].id);
    });

    test("an unknown path or a choice the conflict does not offer is refused", () => {
        const result = merge(fixture("feature-same-param-conflict"));
        const unknown = applyResolutions(result, [{ path: "node/nope", choice: "ours" }]);
        expect(!unknown.isOk && unknown.error).toEqual({ kind: "unknownConflict", path: "node/nope" });
        const path = "node/body-1/feature/f1/param/depth";
        const invalid = applyResolutions(result, [{ path, choice: "theirs-first" }]);
        expect(!invalid.isOk && invalid.error).toEqual({
            kind: "invalidChoice",
            path,
            choice: "theirs-first",
        });
    });
});

describe("inputs", () => {
    test("versions of different documents, or of a newer format, are not merged", () => {
        const { base, ours, theirs } = fixture("identity-unchanged");
        const other = mergeDocuments(base, { ...ours, id: "another" }, theirs);
        expect(!other.isOk && other.error).toEqual({ kind: "differentDocuments" });
        const newer = mergeDocuments(base, ours, { ...theirs, formatVersion: 99 });
        expect(!newer.isOk && newer.error.kind).toBe("format");
    });
});
