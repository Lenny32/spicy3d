// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    collectRebuildReport,
    type IMergeEvaluator,
    type MergeResult,
    mergeDocuments,
    migrateDocument,
    type RebuildOptions,
    type Serialized,
    validateMerge,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    loadMergeFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import "../src";
import "./sketch/setup";

// The merge's validation pass with the real kernel (docs/merge.md, "Validation pass"): every
// fixture merge is rebuilt with its parents, and only failures the merge introduced are reported —
// the fixture `rebuild-failure-thin-wall` (a thinner wall and a bigger fillet) is the one case.

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

/** Loads a version into a document without a visible view and rebuilds it (the app's evaluator does the same). */
function evaluator(calls: string[] = []): IMergeEvaluator {
    return {
        async evaluate(data: Serialized, options?: RebuildOptions) {
            calls.push(String(data["name"]));
            const migrated = migrateDocument(data).value;
            const doc = new TestDocument({ application: createMockApplication() });
            doc.visual = createMockVisualWithDocument(doc);
            doc.variables.setItems(migrated["variables"]);
            await doc.modelManager.deserialize(structuredClone(migrated["models"]));
            try {
                return await collectRebuildReport(doc, options);
            } finally {
                doc.dispose();
            }
        },
    };
}

const fixtures = loadMergeFixtures();

function merge(name: string): MergeResult {
    const fixture = fixtures.find((f) => f.name === name)!;
    const result = mergeDocuments(fixture.base, fixture.ours, fixture.theirs);
    expect(result.isOk).toBe(true);
    return result.value;
}

describe.each(
    fixtures.map((f) => [f.name, f] as const),
)("validation of merge fixture %s", (name, fixture) => {
    test("reports exactly the merge-introduced rebuild failures of the fixture", async () => {
        const structural = merge(name);
        const validated = await validateMerge(structural, { evaluator: evaluator() });
        expect(validated.isOk).toBe(true);
        const added = validated.value.conflicts.slice(structural.conflicts.length);
        const expected = fixture.conflicts.filter((c) => c.kind === "rebuild-failure");
        // args[1] is the kernel's message: compared as "some message"
        expect(added.map(({ args, ...c }) => ({ ...c, args: [args[0]] }))).toEqual(
            expected.map((c) => ({ ...c, base: undefined, ours: undefined, theirs: undefined })),
        );
        for (const conflict of added) expect(String(conflict.args[1]).length).toBeGreaterThan(0);
        expect(validated.value.conflicts.slice(0, structural.conflicts.length)).toEqual(structural.conflicts);
    });
});

describe("validateMerge", () => {
    test("rebuilds merged, then each side without a cached report; reports progress", async () => {
        const calls: string[] = [];
        const progress: [number, number][] = [];
        const result = merge("rebuild-failure-thin-wall");
        const validated = await validateMerge(result, {
            evaluator: evaluator(calls),
            onProgress: (done, total) => progress.push([done, total]),
        });
        expect(validated.isOk).toBe(true);
        expect(calls).toHaveLength(3);
        expect(progress.length).toBeGreaterThan(3);
        expect(progress.at(-1)![0]).toBe(progress.at(-1)![1]);
        for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThan(progress[i - 1][0]);
    });

    test("uses the sides' own reports when given: only the merge is rebuilt", async () => {
        const calls: string[] = [];
        const result = merge("rebuild-failure-thin-wall");
        const validated = await validateMerge(result, {
            evaluator: evaluator(calls),
            ours: new Map(),
            theirs: new Map(),
        });
        expect(calls).toHaveLength(1);
        expect(validated.value.conflicts.map((c) => c.kind)).toEqual(["rebuild-failure"]);
    });

    test("a failure one parent has already is not the merge's", async () => {
        const result = merge("rebuild-failure-thin-wall");
        const failing = new Map([
            [
                "node/body-1/feature/f2/rebuild",
                { nodeId: "body-1", featureId: "f2", label: "fillet f2", error: "x" },
            ],
        ]);
        const validated = await validateMerge(result, {
            evaluator: evaluator(),
            ours: failing,
            theirs: new Map(),
        });
        expect(validated.value.conflicts).toEqual([]);
    });

    test("cancels when the signal aborts, leaving the structural result as it was", async () => {
        const result = merge("rebuild-failure-thin-wall");
        const controller = new AbortController();
        const validated = await validateMerge(result, {
            evaluator: evaluator(),
            signal: controller.signal,
            onProgress: () => controller.abort(),
        });
        expect(!validated.isOk && validated.error).toEqual({ kind: "cancelled" });
        expect(result.conflicts).toEqual([]);
    });

    test("without an evaluator (no app), validation reports it cannot run", async () => {
        const validated = await validateMerge(merge("identity-unchanged"), { evaluator: undefined });
        expect(validated.isOk).toBe(false);
    });
});
