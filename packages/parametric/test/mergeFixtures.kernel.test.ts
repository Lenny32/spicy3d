// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type INode, migrateDocument, parseMergePath, type Serialized, UnknownNode } from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    loadMergeFixtures,
    MERGE_FIXTURE_DOCUMENTS,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

// Every document of the merge fixture corpus (packages/core/test/fixtures/merge) loads into a real
// document and saves back unchanged, and every body and sketch of base / ours / theirs rebuilds —
// they are states the app could have saved. In `expected`, only the nodes a dangling-ref or a
// rebuild-failure conflict points at may fail (that is what the conflict reports).

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

async function load(stored: Serialized) {
    const data = migrateDocument(stored).value;
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.variables.setItems(data["variables"]);
    await doc.modelManager.deserialize(structuredClone(data["models"]));
    return { doc, data };
}

const cases = loadMergeFixtures().flatMap((fixture) =>
    MERGE_FIXTURE_DOCUMENTS.map((file) => [`${fixture.name}/${file}`, fixture, file] as const),
);

describe.each(cases)("merge fixture %s", (_name, fixture, file) => {
    test("loads, rebuilds and saves the models back unchanged", async () => {
        const { doc, data } = await load(fixture[file]);
        const unknown = doc.modelManager.findNodes((n) => n instanceof UnknownNode) as UnknownNode[];
        expect(unknown.map((n) => n.className)).not.toContain("ParametricBodyNode");
        expect(unknown.map((n) => n.className)).not.toContain("SketchNode");

        const expectedFailures =
            file === "expected"
                ? new Set(
                      fixture.conflicts
                          .filter((c) => c.kind === "dangling-ref" || c.kind === "rebuild-failure")
                          .map((c) => parseMergePath(c.path)[1]),
                  )
                : new Set<string>();
        const parts = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode || n instanceof SketchNode,
        ) as (INode & { shape: { isOk: boolean } })[];
        expect(parts.length).toBeGreaterThan(0);
        const failing = parts.filter((n) => !n.shape.isOk).map((n) => n.id);
        expect(failing.filter((id) => !expectedFailures.has(id))).toEqual([]);

        expect(doc.modelManager.serialize()).toEqual(data["models"]);
    });
});
