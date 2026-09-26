// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentMigrations, migrateDocument, UnknownNode } from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { PARAMETRIC_FORMAT_VERSION, SKETCH_FORMAT_VERSION } from "../src/migrations";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

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

test("the parametric and sketch modules are registered with whole chains", () => {
    expect(DocumentMigrations.moduleVersions()).toMatchObject({
        parametric: PARAMETRIC_FORMAT_VERSION,
        sketch: SKETCH_FORMAT_VERSION,
    });
    expect(DocumentMigrations.findGaps()).toEqual([]);
});

describe.each(loadDocumentFixtures().map((x) => [x.name, x] as const))("fixture %s", (_name, fixture) => {
    test("rebuilds every body and sketch and saves the models back unchanged", async () => {
        const data = migrateDocument(fixture.data).value;
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        doc.variables.setItems(data["variables"]);

        await doc.modelManager.deserialize(structuredClone(data["models"]));

        const bodies = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode,
        ) as ParametricBodyNode[];
        const sketches = doc.modelManager.findNodes((n) => n instanceof SketchNode) as SketchNode[];
        expect(bodies.length + sketches.length).toBeGreaterThan(0);
        for (const body of bodies) expect(body.shape.isOk).toBe(true);
        for (const sketch of sketches) expect(sketch.shape.isOk).toBe(true);
        // Only classes from outside this package (app bodies) may stay placeholders.
        const unknown = doc.modelManager.findNodes((n) => n instanceof UnknownNode) as UnknownNode[];
        expect(unknown.map((n) => n.className)).not.toContain("ParametricBodyNode");
        expect(unknown.map((n) => n.className)).not.toContain("SketchNode");
        expect(doc.modelManager.serialize()).toEqual(data["models"]);
    });
});
