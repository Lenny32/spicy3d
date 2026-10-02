// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    collectRebuildReport,
    type IMergeEvaluator,
    mergeDocuments,
    Plane,
    resolveMerge,
    type Serialized,
    validateMerge,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { ConstraintKind, type SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../../src";
import "./setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});

const ref = (entityId: number, pointIndex: number) => ({ entityId, pointIndex });
function joined(type: "line" | "bspline" = "line"): SketchData {
    return {
        entities: [
            { id: 10, type, construction: true, params: [0, 3, 10, 3] },
            { id: 20, type, derivation: "offset", params: [0, 5, 10, 5] },
            { id: 40, type: "line", params: [0, 5, 0, 0] },
            { id: 41, type: "line", params: [10, 5, 10, 0] },
            { id: 42, type: "line", params: [0, 0, 10, 0] },
        ],
        constraints: [
            { id: 1, kind: ConstraintKind.Offset, refs: [ref(10, 0), ref(20, 0)], datum: 2 },
            { id: 2, kind: ConstraintKind.Fix, refs: [ref(10, 0)], datums: [0, "height"] },
            { id: 3, kind: ConstraintKind.Fix, refs: [ref(10, 1)], datums: [10, "height"] },
            { id: 4, kind: ConstraintKind.Block, refs: [ref(42, 0), ref(42, 1)] },
            { id: 5, kind: ConstraintKind.P2PCoincident, refs: [ref(20, 0), ref(40, 0)] },
            { id: 6, kind: ConstraintKind.P2PCoincident, refs: [ref(20, 1), ref(41, 0)] },
            { id: 7, kind: ConstraintKind.P2PCoincident, refs: [ref(40, 1), ref(42, 0)] },
            { id: 8, kind: ConstraintKind.P2PCoincident, refs: [ref(41, 1), ref(42, 1)] },
        ],
    };
}
function newDocument() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    doc.variables.setItems([{ id: "height", name: "height", expression: "3", type: "length" }]);
    return doc;
}
function volume(body: ParametricBodyNode): number {
    expect(body.shape.isOk).toBe(true);
    return Math.abs(body.shape.value.volume());
}

test.each([
    "line",
    "bspline",
] as const)("joined open %s offset forms an extrudable region following a source variable, including save/load", async (type) => {
    const doc = newDocument();
    const copy = newDocument();
    try {
        const sketch = new SketchNode({ document: doc, id: "joined", plane: Plane.XY, data: joined(type) });
        doc.modelManager.addNode(sketch);
        const profiles = sketchProfiles(sketch);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outerEntities).toEqual([expect.arrayContaining([20, 40, 41, 42])]);
        expect(profiles.value.outer).toHaveLength(1);
        const body = new ParametricBodyNode({
            document: doc,
            id: "body",
            features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 4 }],
        });
        doc.modelManager.addNode(body);
        expect(volume(body)).toBeCloseTo(200, 6);
        doc.variables.setItems([{ id: "height", name: "height", expression: "7", type: "length" }]);
        expect(volume(body)).toBeCloseTo(360, 6);
        expect(sketch.data.entities.find((e) => e.id === 40)!.params).toEqual([0, 9, 0, 0]);
        copy.variables.setItems(doc.variables.items);
        await copy.modelManager.deserialize(doc.modelManager.serialize());
        const loaded = copy.modelManager.findNode((n) => n.id === "body") as ParametricBodyNode;
        expect(loaded).not.toBeUndefined();
        expect(volume(loaded)).toBeCloseTo(360, 6);
    } finally {
        copy.dispose();
        doc.dispose();
    }
});

const evaluator: IMergeEvaluator = {
    async evaluate(serialized, options) {
        const doc = newDocument();
        try {
            doc.variables.setItems(serialized["variables"]);
            await doc.modelManager.deserialize(structuredClone(serialized["models"]));
            return await collectRebuildReport(doc, options);
        } finally {
            doc.dispose();
        }
    },
};

describe.each([false, true])("regenerated snapshots=%s", (savedSnapshots) => {
    test.each([
        false,
        true,
    ])("source vs connector edit merges and validates deterministically (reverse=%s)", async (reverse) => {
        const doc = newDocument();
        try {
            const sketch = new SketchNode({ document: doc, id: "joined", plane: Plane.XY, data: joined() });
            doc.modelManager.addNode(sketch);
            const body = new ParametricBodyNode({
                document: doc,
                id: "body",
                features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 4 }],
            });
            doc.modelManager.addNode(body);
            expect(volume(body)).toBeCloseTo(200, 6);
            const fixture = loadDocumentFixtures().find(
                (f) => f.name === "v2/sketch6-associative-offset.json",
            );
            expect(fixture).not.toBeUndefined();
            const base: Serialized = {
                ...structuredClone(fixture!.data),
                models: doc.modelManager.serialize(),
                variables: doc.variables.items,
            };
            const sourceEdit = structuredClone(base);
            sourceEdit["variables"][0].expression = "7";
            const connectorEdit = structuredClone(base);
            const node = connectorEdit["models"].nodes.find((n: Serialized) => n["id"] === "joined");
            expect(node).not.toBeUndefined();
            const data: SketchData = JSON.parse(node["dataJson"]);
            // A normal connector dimension controls the bottom, independently of the derived top.
            data.constraints = data.constraints.filter((c) => c.id !== 4);
            data.constraints.push(
                { id: 9, kind: ConstraintKind.Fix, refs: [ref(42, 0)], datums: [0, -2] },
                { id: 11, kind: ConstraintKind.Fix, refs: [ref(42, 1)], datums: [10, -2] },
            );
            node["dataJson"] = JSON.stringify(data);
            const other = newDocument();
            try {
                await other.modelManager.deserialize(connectorEdit["models"]);
                expect(
                    volume(other.modelManager.findNode((n) => n.id === "body") as ParametricBodyNode),
                ).toBeCloseTo(280, 6);
                if (savedSnapshots) {
                    doc.variables.setItems(sourceEdit["variables"]);
                    sourceEdit["models"] = doc.modelManager.serialize();
                    connectorEdit["models"] = other.modelManager.serialize();
                }
            } finally {
                other.dispose();
            }
            expect(volume(body)).toBeCloseTo(savedSnapshots ? 360 : 200, 6);
            const merged = mergeDocuments(
                base,
                reverse ? connectorEdit : sourceEdit,
                reverse ? sourceEdit : connectorEdit,
            );
            expect(merged.isOk).toBe(true);
            expect(merged.value.conflicts.map((c) => c.path)).toEqual(
                savedSnapshots ? ["node/joined/entity/40/params", "node/joined/entity/41/params"] : [],
            );
            const resolved = resolveMerge(
                merged.value,
                merged.value.conflicts.map((c) => ({ path: c.path, choice: "ours" as const })),
            );
            expect(resolved.isOk).toBe(true);
            expect(resolved.value.conflicts).toEqual([]);
            const validated = await validateMerge(resolved.value, { evaluator });
            expect(validated.isOk).toBe(true);
            expect(validated.value.conflicts).toEqual([]);
            const loaded = newDocument();
            try {
                loaded.variables.setItems(validated.value.merged["variables"]);
                await loaded.modelManager.deserialize(validated.value.merged["models"]);
                expect(
                    volume(loaded.modelManager.findNode((n) => n.id === "body") as ParametricBodyNode),
                ).toBeCloseTo(440, 6);
            } finally {
                loaded.dispose();
            }
        } finally {
            doc.dispose();
        }
    });
});
