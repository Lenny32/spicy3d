// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConstructionNode, DocumentMigrations, migrateDocument, UnknownNode } from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { HybridShapeFactory, initWasm, ShapeFactory } from "@spicy3d/wasm";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
import { PARAMETRIC_FORMAT_VERSION, SKETCH_FORMAT_VERSION } from "../src/migrations";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

let asyncFactory: HybridShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    asyncFactory = new HybridShapeFactory(() => new NativeWorkerTransport().client);
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(asyncFactory, asyncFactory),
        writable: true,
        configurable: true,
    });
});
afterAll(() => asyncFactory.dispose());

test("the parametric and sketch modules are registered with whole chains", () => {
    expect(DocumentMigrations.moduleVersions()).toMatchObject({
        parametric: PARAMETRIC_FORMAT_VERSION,
        sketch: SKETCH_FORMAT_VERSION,
    });
    expect(DocumentMigrations.findGaps()).toEqual([]);
});

describe.each(loadDocumentFixtures().map((x) => [x.name, x] as const))("fixture %s", (_name, fixture) => {
    test("rebuilds every body, sketch and construction and saves the models back unchanged", async () => {
        const data = migrateDocument(fixture.data).value;
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        doc.variables.setItems(data["variables"]);

        await doc.modelManager.deserialize(structuredClone(data["models"]));

        const bodies = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode,
        ) as ParametricBodyNode[];
        const sketches = doc.modelManager.findNodes((n) => n instanceof SketchNode) as SketchNode[];
        const constructions = doc.modelManager.findNodes(
            (n) => n instanceof ConstructionNode,
        ) as ConstructionNode[];
        expect(bodies.length + sketches.length + constructions.length).toBeGreaterThan(0);
        // Frozen legacy fixtures include a square-to-circle skin whose thickened
        // corners cross. Loading/saving remains lossless; that wall is now refused.
        const hasCrossingWall = [
            "v2/parametric5-thicken.json",
            "v2/parametric15-tolerant-thicken.json",
        ].includes(fixture.name);
        if (hasCrossingWall) expect(bodies.map((body) => body.id)).toContain("body-wall");
        for (const body of bodies) {
            void body.shape;
            const rebuilt = await body.whenRebuilt();
            if (hasCrossingWall && body.id === "body-wall") {
                expect(rebuilt).toBe(false);
                const errors = body.featureItems().filter((item) => item.error);
                expect(errors).toHaveLength(1);
                expect(errors[0].id).toBe("feature-wall");
                expect(errors[0].error).toContain("Thicken result intersects itself");
                expect(errors[0].error).toMatch(/output face indices \(zero-based\): \d/);
                expect(errors[0].error).toContain("approximate faulty region center xyz (mm)");
            } else {
                expect(rebuilt).toBe(true);
                expect(body.shape.isOk).toBe(true);
                expect(body.featureItems().filter((item) => item.error)).toEqual([]);
            }
        }
        for (const sketch of sketches) expect(sketch.shape.isOk).toBe(true);
        for (const construction of constructions) {
            expect(construction.geometry.isOk, construction.errorMessage).toBe(true);
        }
        // Only classes from outside this package (app bodies) may stay placeholders.
        const unknown = doc.modelManager.findNodes((n) => n instanceof UnknownNode) as UnknownNode[];
        expect(unknown.map((n) => n.className)).not.toContain("ParametricBodyNode");
        expect(unknown.map((n) => n.className)).not.toContain("SketchNode");
        expect(doc.modelManager.serialize()).toEqual(data["models"]);
        doc.dispose();
    }, 180_000);
});

test("the approved next/from-face fixture rebuilds its exact depth and offset after load", async () => {
    const fixture = loadDocumentFixtures().find((item) => item.name === "v2/parametric8-next.json");
    expect(fixture).not.toBeUndefined();
    if (fixture === undefined) throw new Error("Missing approved next fixture");
    const data = migrateDocument(fixture.data).value;
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    doc.variables.setItems(data["variables"]);
    await doc.modelManager.deserialize(structuredClone(data["models"]));
    const boss = doc.modelManager.findNode((node) => node.id === "body-boss") as ParametricBodyNode;
    expect(boss).toBeInstanceOf(ParametricBodyNode);
    expect(boss.shape.isOk).toBe(true);
    expect(Math.abs(boss.shape.value.volume())).toBeCloseTo(16 * (10 - 2), 4);
    expect(doc.modelManager.serialize()).toEqual(data["models"]);
});

test("the approved guided loft fixture loads both real guides and preserves its exact section volume", async () => {
    const fixture = loadDocumentFixtures().find((item) => item.name === "v2/parametric13-guided-loft.json");
    expect(fixture).not.toBeUndefined();
    if (fixture === undefined) throw new Error("Missing approved guided loft fixture");
    const data = migrateDocument(fixture.data).value;
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    await doc.modelManager.deserialize(structuredClone(data["models"]));
    const body = doc.modelManager.findNode((node) => node.id === "body-guided-loft") as ParametricBodyNode;
    expect(body).toBeInstanceOf(ParametricBodyNode);
    void body.shape;
    expect(await body.whenRebuilt()).toBe(true);
    expect(body.featureItems().filter((item) => item.error)).toEqual([]);
    expect(body.shape.isOk).toBe(true);
    expect(Math.abs(body.shape.value.volume())).toBeCloseTo(1200, 4);
    expect(doc.modelManager.serialize()).toEqual(data["models"]);
    doc.dispose();
});
