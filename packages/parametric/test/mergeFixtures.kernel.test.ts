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
import { HybridShapeFactory, initWasm, ShapeFactory } from "@spicy3d/wasm";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
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

let boundedFactory: HybridShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    boundedFactory = new HybridShapeFactory(() => new NativeWorkerTransport().client);
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(undefined, boundedFactory),
        writable: true,
        configurable: true,
    });
});

afterAll(() => boundedFactory.dispose());

async function load(stored: Serialized) {
    const data = migrateDocument(stored).value;
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.variables.setItems(data["variables"]);
    await doc.modelManager.deserialize(structuredClone(data["models"]));
    const bodies = doc.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode[];
    for (const body of bodies) {
        void body.shape;
        await body.whenRebuilt();
    }
    return { doc, data };
}

const cases = loadMergeFixtures().flatMap((fixture) =>
    MERGE_FIXTURE_DOCUMENTS.filter(
        (file) => fixture.name !== "sketch-offset-source-vs-distance" || file !== "expected",
    ).map((file) => [`${fixture.name}/${file}`, fixture, file] as const),
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

test("merged offset source and distance regenerate only the derived target cache", async () => {
    const fixture = loadMergeFixtures().find((f) => f.name === "sketch-offset-source-vs-distance");
    expect(fixture).not.toBeUndefined();
    const { doc, data } = await load(fixture!.expected);
    const node = doc.modelManager.findNodes((n) => n.id === "sketch-offset")[0] as SketchNode;
    expect(node.shape.isOk).toBe(true);
    const expected = structuredClone(data["models"]);
    const sketch = expected.nodes.find((n: Serialized) => n["id"] === "sketch-offset");
    const payload = JSON.parse(sketch.dataJson);
    expect(payload.entities[0].params).toEqual([0, 0, 14]);
    expect(payload.constraints[0].datum).toBe("gap + 1 mm");
    expect(payload.entities[1].params).toEqual([0, 0, 16]);
    payload.entities[1].params = [0, 0, 17];
    sketch.dataJson = JSON.stringify(payload);
    expect(doc.modelManager.serialize()).toEqual(expected);
});
