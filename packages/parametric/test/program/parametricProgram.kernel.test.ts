// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The program engine drives the same API the interactive commands do, so these assert the
 * three invariants the rest of the parametric suite is built on: no feature row reports an
 * error, an upstream edit carries the whole chain, and undoing it leaves no residue. On top
 * of that they pin the engine's own contract — a failed program throws so the caller's
 * transaction rolls the entire program back, leaving no half-built body behind.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    DocumentRebuilds,
    FolderNode,
    I18n,
    type IEdge,
    type IFace,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { buildParametricTools } from "../../../ai/src/tools/parametricTools";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import {
    type ParametricOp,
    type ProgramRunOptions,
    runParametricProgram,
} from "../../src/program/parametricProgram";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** Perimeter lines of a rectangle, closing back onto the first point. */
function rect(x0: number, y0: number, x1: number, y1: number) {
    return [
        { type: "line" as const, params: [x0, y0, x1, y0] },
        { type: "line" as const, params: [x1, y0, x1, y1] },
        { type: "line" as const, params: [x1, y1, x0, y1] },
        { type: "line" as const, params: [x0, y1, x0, y0] },
    ];
}

/** Runs a program inside a transaction — the way the AI tool drives it. */
function run(
    doc: TestDocument,
    ops: ParametricOp[],
    options: ProgramRunOptions = {},
): ReturnType<typeof runParametricProgram> {
    let result: ReturnType<typeof runParametricProgram> | undefined;
    Transaction.execute(doc, "test program", () => {
        result = runParametricProgram(doc, ops, options);
    });
    return result!;
}

/** Runs a program expected to fail; returns the thrown message after the rollback. */
function runExpectingFailure(doc: TestDocument, ops: ParametricOp[]): string {
    let message = "";
    try {
        Transaction.execute(doc, "test program", () => {
            runParametricProgram(doc, ops);
        });
    } catch (err) {
        message = (err as Error).message;
    }
    expect(message).toMatch(/failed/);
    return message;
}

const bodyOf = (doc: TestDocument, id: string) =>
    doc.modelManager.findNodes((n) => n.id === id)[0] as ParametricBodyNode;

/** The body a given op produced — `created` also lists the sketches, so look it up by op id. */
function createdBody(
    doc: TestDocument,
    result: { created: { id: string; nodeId: string }[] },
    id: string,
): ParametricBodyNode {
    const entry = result.created.find((created) => created.id === id);
    expect(entry).toBeDefined();
    return bodyOf(doc, entry!.nodeId);
}

/** Every top-level node id in the document, for the "nothing was left behind" assertions. */
const nodeIds = (doc: TestDocument) => doc.modelManager.findNodes(() => true).map((n) => n.id);

const round = (x: number) => {
    const rounded = Math.round(x * 1e6) / 1e6;
    // Geometry bounds can approach zero from either side; their sign is irrelevant after rounding.
    return Object.is(rounded, -0) ? 0 : rounded;
};

function extent(body: ParametricBodyNode): number[] {
    const box = body.shape.unchecked()!.boundingBox();
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map(round);
}

function expectClean(...bodies: ParametricBodyNode[]): void {
    const broken = bodies
        .flatMap((body) => body.featureItems())
        .filter((item) => item.error !== undefined)
        .map((item) => `${item.id}: ${item.error}`);
    expect(broken).toEqual([]);
}

const plate = (depth: number): ParametricOp[] => [
    { op: "sketch", id: "s1", plane: "XY", entities: rect(0, 0, 40, 30) },
    { op: "extrude", id: "b1", sketch: "s1", depth },
];

/** Cross the scheduling threshold with a single appended feature, without unnecessary booleans. */
function elevenFeaturePlate(doc: TestDocument): ParametricBodyNode {
    const body = createdBody(doc, run(doc, plate(20)), "b1");
    const base = body.features[0];
    body.setFeaturesEmitShapeChanged([
        base,
        ...Array.from({ length: 10 }, (_, index) => ({
            ...base,
            id: `suppressed-${index}`,
            suppressed: true,
        })),
    ]);
    expect(body.featureCount).toBe(11);
    expect(body.isRebuilding).toBe(false);
    return body;
}

describe("program evaluation across the async scheduling threshold", () => {
    test("an invalid twelfth feature throws at that operation and rolls back the transaction", async () => {
        const doc = newDoc();
        try {
            const body = elevenFeaturePlate(doc);
            run(doc, [
                {
                    op: "sketch",
                    id: "open",
                    plane: "XY",
                    entities: [{ type: "line", params: [0, 0, 10, 0] }],
                },
            ]);
            const features = body.featuresJson;
            const previous = body.shape.value;
            const position = doc.history.position();
            const before = nodeIds(doc);
            const message = runExpectingFailure(doc, [
                { op: "extrude", id: "bad12", sketch: "open", depth: 5, body: "b1", operation: "fuse" },
                { op: "sketch", id: "must-not-run", plane: "XY", entities: rect(0, 0, 5, 5) },
            ]);
            expect(message).toContain('op 0 ("extrude") failed');
            expect(message).toContain("Sketch profile is not closed");
            expect(body.featuresJson).toBe(features);
            expect(body.shape.value).toBe(previous);
            expect(nodeIds(doc)).toEqual(before);
            expect(doc.history.position()).toBe(position);
            expect(DocumentRebuilds.pending(doc)).toBe(false);

            // Throwing out of the program must release its scope for subsequent interactive work.
            body.setFeaturesEmitShapeChanged([
                ...body.features,
                {
                    ...body.features[0],
                    id: "interactive-12",
                },
            ]);
            expect(body.isRebuilding).toBe(true);
            expect(await body.whenRebuilt()).toBe(true);
        } finally {
            doc.dispose();
        }
    });

    test("operations after the twelfth feature capture its new faces and edges before appending more", () => {
        const doc = newDoc();
        try {
            const body = elevenFeaturePlate(doc);
            const base = body.features[0];
            if (base.type !== "extrude") throw new Error("Expected the plate extrusion");
            const before = body.features;
            let topIndex = -1;
            let edgeIndex = -1;
            // Determine indexes on the expected 40-high result. The test then restores the
            // 20-high input before the single program that must capture that new topology.
            ParametricBodyNode.withSynchronousEvaluation(doc, () => {
                body.setFeaturesEmitShapeChanged([
                    ...before,
                    {
                        ...base,
                        id: "probe",
                        depth: 40,
                        operation: "fuse",
                    },
                ]);
                const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
                topIndex = faces.findIndex((face) => face.normal(0, 0)[1].z > 0.99);
                const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
                edgeIndex = edges.findIndex(
                    (edge) =>
                        Math.abs(edge.startPoint().z - 40) < 1e-6 && Math.abs(edge.endPoint().z - 40) < 1e-6,
                );
                body.setFeaturesEmitShapeChanged(before);
            });
            expect(topIndex).toBeGreaterThanOrEqual(0);
            expect(edgeIndex).toBeGreaterThanOrEqual(0);
            expect(extent(body)[5]).toBe(20);
            const result = run(doc, [
                { op: "extrude", id: "grow12", sketch: "s1", depth: 40, body: "b1", operation: "fuse" },
                {
                    op: "sketch",
                    id: "top",
                    plane: { nodeId: "grow12", faceIndex: topIndex },
                    entities: rect(5, 5, 10, 10),
                },
                { op: "fillet", id: "round13", body: "grow12", edgeIndexes: [edgeIndex], radius: 1 },
            ]);
            const top = result.created.find((entry) => entry.id === "top");
            expect(top).not.toBeUndefined();
            const sketch = doc.modelManager.findNode((node) => node.id === top?.nodeId) as SketchNode;
            expect(sketch.plane.origin.z).toBeCloseTo(40, 6);
            expect(body.features.at(-1)).toMatchObject({
                type: "fillet",
                edges: [{ kind: "line", start: { z: 40 }, end: { z: 40 } }],
            });
            expect(body.isRebuilding).toBe(false);
            expect(DocumentRebuilds.pending(doc)).toBe(false);
            expectClean(body);
        } finally {
            doc.dispose();
        }
    });
});

describe("sketch and extrude", () => {
    test("a sketch plus an extrude produces a clean body with the expected extent", () => {
        const doc = newDoc();
        const result = run(doc, [
            { op: "sketch", id: "s1", plane: "XY", entities: rect(0, 0, 40, 30) },
            {
                op: "extrude",
                id: "b1",
                sketch: "s1",
                depth: 20,
                name: "Plate",
            },
        ]);

        const body = createdBody(doc, result, "b1");
        expectClean(body);
        expect(body.featureItems().map((item) => item.id)).toHaveLength(1);
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 20]);
        // The sketch is consumed into the feature list — hidden, but still present.
        const sketch = doc.modelManager.findNodes((n) => n instanceof SketchNode)[0];
        expect(sketch).toBeDefined();
        expect(sketch.visible).toBe(false);
    });

    test.each([
        "fuse",
        "cut",
    ] as const)("an appended %s extrusion uses its supplied feature name and keeps the body's name", (operation) => {
        const doc = newDoc();
        try {
            const result = run(doc, [
                { op: "sketch", id: "s1", plane: "XY", entities: rect(0, 0, 40, 30) },
                { op: "extrude", id: "b1", sketch: "s1", depth: 20, name: "Plate" },
            ]);
            const body = createdBody(doc, result, "b1");
            const name = operation === "fuse" ? "Raised boss" : "Pocket";
            const depth = operation === "fuse" ? 30 : 10;
            const appended = run(doc, [
                { op: "sketch", id: "s2", plane: "XY", entities: rect(10, 10, 20, 20) },
                { op: "extrude", id: "e2", sketch: "s2", depth, body: body.id, operation, name },
                { op: "features", id: "read", body: "e2" },
            ]);

            expectClean(body);
            expect(body.name).toBe("Plate");
            expect(body.features).toHaveLength(2);
            expect(body.features[0].name).toBeUndefined();
            expect(body.features[1]).toMatchObject({ type: "extrude", operation, name });
            expect((appended.results["read"] as { name?: string }[]).map((item) => item.name)).toEqual([
                undefined,
                name,
            ]);
            expect(appended.created.map((entry) => entry.id)).toEqual(["s2"]);
            expect(body.shape.value.volume()).toBeCloseTo(
                40 * 30 * 20 + (operation === "fuse" ? 100 * 10 : -100 * 10),
                3,
            );
        } finally {
            doc.dispose();
        }
    });

    test("unnamed extrusions preserve the default body and feature names", () => {
        const doc = newDoc();
        try {
            const body = createdBody(doc, run(doc, plate(20)), "b1");
            const defaultBodyName = body.name;
            const defaultDisplay = body.featureItems()[0].display;
            expect(defaultBodyName).toBe(`${I18n.translate(body.display())}1`);
            run(doc, [
                { op: "sketch", id: "s2", plane: "XY", entities: rect(10, 10, 20, 20) },
                { op: "extrude", id: "e2", sketch: "s2", depth: 30, body: body.id, operation: "fuse" },
            ]);

            expectClean(body);
            expect(body.name).toBe(defaultBodyName);
            expect(body.features.map((feature) => feature.name)).toEqual([undefined, undefined]);
            expect(body.featureItems().map((item) => item.display)).toEqual([defaultDisplay, defaultDisplay]);
        } finally {
            doc.dispose();
        }
    });
    test("an unclosed profile is rejected and the transaction leaves no node behind", () => {
        const doc = newDoc();
        const message = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s1",
                plane: "XY",
                entities: [
                    { type: "line", params: [0, 0, 40, 0] },
                    { type: "line", params: [40, 0, 40, 30] },
                    { type: "line", params: [40, 30, 0, 30] },
                ],
            },
            { op: "extrude", id: "b1", sketch: "s1", depth: 20 },
        ]);

        expect(message).toContain("extrude");
        expect(nodeIds(doc)).toEqual([]);
    });

    test("a sketch can be built on a planar face of an existing body", () => {
        const doc = newDoc();
        const first = run(doc, plate(20));
        const body = createdBody(doc, first, "b1");
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const topIndex = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        expect(topIndex).toBeGreaterThanOrEqual(0);

        const second = run(doc, [
            {
                op: "sketch",
                id: "s2",
                plane: { nodeId: body.id, faceIndex: topIndex },
                entities: rect(10, 10, 20, 20),
            },
            { op: "extrude", id: "b2", sketch: "s2", depth: 10, body: body.id, operation: "fuse" },
        ]);

        expectClean(body);
        // The boss rides on the plate's top face: 20 + 10 tall, still 40 x 30 across.
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 30]);
        // Only the sketch was created — the extrude joined the existing body.
        expect(second.created.map((created) => created.id)).toEqual(["s2"]);
    });
});

describe("extrude extents", () => {
    /** The plate plus a sketch on its top face, and the indexes of its top and bottom faces. */
    function plateWithTopSketch(doc: TestDocument, depth = 20) {
        const body = createdBody(doc, run(doc, plate(depth)), "b1");
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const topIndex = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        const bottomIndex = faces.findIndex((face) => face.normal(0, 0)[1].z < -1 + 1e-6);
        expect(topIndex).toBeGreaterThanOrEqual(0);
        expect(bottomIndex).toBeGreaterThanOrEqual(0);
        return { body, topIndex, bottomIndex };
    }

    test("a cut up to the bottom face follows the plate when it grows", () => {
        const doc = newDoc();
        const { body, topIndex, bottomIndex } = plateWithTopSketch(doc);
        run(doc, [
            {
                op: "sketch",
                id: "s2",
                plane: { nodeId: body.id, faceIndex: topIndex },
                entities: rect(10, 10, 20, 20),
            },
            {
                op: "extrude",
                id: "hole",
                sketch: "s2",
                depth: 0,
                body: body.id,
                operation: "cut",
                extent: { type: "toObject", face: { nodeId: body.id, faceIndex: bottomIndex } },
            },
        ]);
        expectClean(body);
        expect(Math.abs(body.shape.value.volume())).toBeCloseTo(40 * 30 * 20 - 100 * 20, 3);

        const features = body.features;
        run(doc, [
            {
                op: "editFeature",
                body: body.id,
                featureId: features[0].id,
                action: "setParameter",
                key: "depth",
                value: 35,
            },
        ]);
        expectClean(body);
        expect(Math.abs(body.shape.value.volume())).toBeCloseTo(40 * 30 * 35 - 100 * 35, 3);
    });

    test("through all is stored as its extent type", () => {
        const doc = newDoc();
        const { body, topIndex } = plateWithTopSketch(doc);
        run(doc, [
            {
                op: "sketch",
                id: "s2",
                plane: { nodeId: body.id, faceIndex: topIndex },
                entities: rect(10, 10, 20, 20),
            },
            {
                op: "extrude",
                id: "hole",
                sketch: "s2",
                depth: -1,
                body: body.id,
                operation: "cut",
                extent: "throughAll",
            },
        ]);
        expectClean(body);
        expect(body.features.at(-1)).toMatchObject({ extent: { type: "throughAll" } });
        expect(Math.abs(body.shape.value.volume())).toBeCloseTo(40 * 30 * 20 - 100 * 20, 3);
    });

    test("a face index out of range and a second extent without symmetric are refused", () => {
        const doc = newDoc();
        const { body, topIndex } = plateWithTopSketch(doc);
        const sketch: ParametricOp = {
            op: "sketch",
            id: "s2",
            plane: { nodeId: body.id, faceIndex: topIndex },
            entities: rect(10, 10, 20, 20),
        };
        const outOfRange = runExpectingFailure(doc, [
            sketch,
            {
                op: "extrude",
                id: "hole",
                sketch: "s2",
                depth: 0,
                body: body.id,
                operation: "cut",
                extent: { type: "toObject", face: { nodeId: body.id, faceIndex: 99 } },
            },
        ]);
        expect(outOfRange).toContain("faceIndex 99 is out of range");
        const lonely = runExpectingFailure(doc, [
            sketch,
            {
                op: "extrude",
                id: "hole",
                sketch: "s2",
                depth: 1,
                body: body.id,
                operation: "cut",
                secondExtent: "throughAll",
            },
        ]);
        expect(lonely).toContain('it needs "symmetric": true');
        expect(body.features).toHaveLength(1);
    });
});

describe("loft", () => {
    const sections: ParametricOp[] = [
        { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 30 } },
        { op: "sketch", id: "s1", plane: "XY", entities: rect(-10, -10, 10, 10) },
        {
            op: "sketch",
            id: "s2",
            plane: { construction: "p1" },
            entities: [{ type: "circle", params: [0, 0, 6] }],
        },
    ];

    test("lofts its sections into a clean body that follows a section edit", () => {
        const doc = newDoc();
        const result = run(doc, [...sections, { op: "loft", id: "b1", sections: ["s1", "s2"] }]);
        const body = createdBody(doc, result, "b1");
        expectClean(body);
        expect(body.features[0]).toMatchObject({ type: "loft" });
        expect(body.shape.unchecked()!.shapeType).toBe(ShapeTypes.solid);
        expect(extent(body)).toEqual([-10, -10, 0, 10, 10, 30]);
        const s1 = result.created.find((created) => created.id === "s1")!.nodeId;
        expect((doc.modelManager.findNodes((n) => n.id === s1)[0] as SketchNode).visible).toBe(false);

        run(doc, [
            {
                op: "editSketch",
                sketch: s1,
                actions: [{ action: "move", entities: [1, 2, 3, 4], delta: [5, 0] }],
            } as ParametricOp,
        ]);

        expectClean(body);
        expect(extent(body)[3]).toBeCloseTo(15, 3);
    });

    test("stores the options it was given", () => {
        const doc = newDoc();
        const result = run(doc, [
            ...sections,
            { op: "loft", id: "b1", sections: ["s1", "s2"], solid: false, ruled: true },
        ]);
        const body = createdBody(doc, result, "b1");
        expectClean(body);
        expect(body.features[0]).toMatchObject({ solid: false, ruled: true });
        expect(body.shape.unchecked()!.shapeType).not.toBe(ShapeTypes.solid);
    });

    test.each([
        [[{ op: "loft", id: "b1", sections: ["s1"] }], "at least two sketches"],
        [[{ op: "loft", id: "b1", sections: ["s1", "s2"], continuity: "c9" }], "continuity"],
        [[{ op: "loft", id: "b1", sections: ["s1", "s1"] }], "same plane"],
    ])("refuses %j and leaves nothing behind", (loft, message) => {
        const doc = newDoc();
        const before = nodeIds(doc);
        expect(runExpectingFailure(doc, [...sections, ...(loft as ParametricOp[])])).toContain(message);
        expect(nodeIds(doc)).toEqual(before);
    });
});

describe("thicken", () => {
    /** The index of the body's face whose outward normal is +z. */
    function topFaceIndex(body: ParametricBodyNode): number {
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const index = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
    }

    function setWall(doc: TestDocument, expression: string) {
        Transaction.execute(doc, "edit variables", () => {
            doc.variables.setItems([{ id: "v1", name: "wall_t", expression, type: "length" }]);
        });
    }

    test("shells a body open at the picked face, following the thickness variable", () => {
        const doc = newDoc();
        setWall(doc, "2");
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");

        run(doc, [
            {
                op: "thicken",
                id: "t1",
                body: body.id,
                thickness: "-wall_t",
                openFaceIndexes: [topFaceIndex(body)],
            },
        ]);

        expectClean(body);
        const feature = body.features[1];
        expect(feature).toMatchObject({ type: "thicken", thickness: "-wall_t" });
        expect(feature).not.toHaveProperty("joinType");
        expect(feature).not.toHaveProperty("mode");
        expect((feature as { openFaces?: unknown[] }).openFaces).toHaveLength(1);
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 3);

        setWall(doc, "3");

        expectClean(body);
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(40 * 30 * 20 - 34 * 24 * 17, 3);
    });

    test("thickens an open loft into a solid in the same program", () => {
        const doc = newDoc();
        const result = run(doc, [
            { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 20 } },
            { op: "sketch", id: "s1", plane: "XY", entities: [{ type: "circle", params: [0, 0, 10] }] },
            {
                op: "sketch",
                id: "s2",
                plane: { construction: "p1" },
                entities: [{ type: "circle", params: [0, 0, 10] }],
            },
            { op: "loft", id: "b1", sections: ["s1", "s2"], solid: false },
            { op: "thicken", id: "b1", body: "b1", thickness: 2, joinType: "intersection" },
        ]);
        const body = createdBody(doc, result, "b1");

        expectClean(body);
        expect(body.features.map((x) => x.type)).toEqual(["loft", "thicken"]);
        expect(body.features[1]).toMatchObject({ joinType: "intersection" });
        expect(body.shape.unchecked()!.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(body.shape.unchecked()!.volume()).toBeCloseTo(Math.PI * (144 - 100) * 20, 1);
    });

    test.each([
        [{ thickness: undefined }, '"thicken" requires "thickness"'],
        [{ thickness: "nope_t" }, '"thickness" is not usable'],
        [{ thickness: 2, joinType: "tangent" }, '"joinType" must be one of arc, intersection'],
        [{ thickness: 2, mode: "rectoVerso" }, '"mode" must be one of skin, pipe'],
        [{ thickness: 2, openFaceIndexes: [99] }, "faceIndex 99 is out of range"],
        [{ thickness: 0 }, "The thickness must not be zero"],
    ])("refuses %j and leaves nothing behind", (fields, message) => {
        const doc = newDoc();
        const before = nodeIds(doc);
        const thicken = { op: "thicken", id: "t1", body: "b1", ...fields } as unknown as ParametricOp;
        expect(runExpectingFailure(doc, [...plate(10), thicken])).toContain(message);
        expect(nodeIds(doc)).toEqual(before);
    });
});

describe("feature list editing", () => {
    test("a depth edit carries the geometry and editing back restores it exactly", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");
        const featureId = body.featureItems()[0].id;
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 20]);

        run(doc, [
            { op: "editFeature", body: body.id, featureId, action: "setParameter", key: "depth", value: 35 },
        ]);
        expectClean(body);
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 35]);

        run(doc, [
            { op: "editFeature", body: body.id, featureId, action: "setParameter", key: "depth", value: 20 },
        ]);
        expectClean(body);
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 20]);
    });

    test("the result envelope survives JSON serialization", () => {
        const doc = newDoc();
        const result = run(doc, [...plate(20), { op: "features", id: "read", body: "b1" }]);

        // featureItems() carries live nodes in `references` (the sketch an extrude holds),
        // and a node owns its parent and document. This is the whole reason the engine
        // projects the rows: returning them raw made the caller's JSON.stringify throw.
        // Wording differs by engine ("Converting circular structure" in node,
        // "cannot serialize cyclic structures" in the browser) — match either.
        expect(() => JSON.stringify(createdBody(doc, result, "b1").featureItems())).toThrow(
            /circular|cyclic/i,
        );

        const json = JSON.stringify(result);
        const items = JSON.parse(json).results["read"] as { references: { nodeId: string }[] }[];
        expect(items[0].references[0].nodeId).toBeTruthy();
    });

    test("an op that edits a body registers its own id as another name for that body", () => {
        const doc = newDoc();
        const first = run(doc, plate(20));
        const body = createdBody(doc, first, "b1");

        const second = run(doc, [
            { op: "sketch", id: "s2", plane: "XY", entities: rect(10, 10, 20, 20) },
            { op: "extrude", id: "e2", sketch: "s2", depth: 10, body: "b1", operation: "fuse" },
            // "e2" named an edit, but it resolves to the body it edited.
            { op: "features", id: "read", body: "e2" },
        ]);

        expectClean(body);
        const items = (second.results as { read: unknown[] }).read;
        expect(items).toHaveLength(2);
        expect(second.created.map((created) => created.id)).toEqual(["s2"]);
    });

    test("the features op reports the list, and remove drops the feature", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");

        const read = run(doc, [{ op: "features", id: "f", body: body.id }]);
        const items = (read.results as { f: { id: string; parameters: { key: string }[] }[] }).f;
        expect(items).toHaveLength(1);
        expect(items[0].parameters.map((p) => p.key)).toContain("depth");

        run(doc, [{ op: "editFeature", body: body.id, featureId: items[0].id, action: "remove" }]);
        expect(body.featureItems()).toHaveLength(0);
    });

    test("a feature that cannot rebuild is reported and nothing is committed", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");
        const featureId = body.featureItems()[0].id;
        const before = extent(body);

        const message = runExpectingFailure(doc, [
            { op: "editFeature", body: body.id, featureId, action: "setParameter", key: "depth", value: 0 },
        ]);

        expect(message).toContain("extrude");
        expect(extent(body)).toEqual(before);
    });
});

describe("fillet and boolean", () => {
    test("a fillet takes edge indexes and reports an out-of-range index", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");

        const edges = body.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges.length).toBeGreaterThan(0);
        const message = runExpectingFailure(doc, [
            { op: "fillet", id: "f1", body: body.id, edgeIndexes: [edges.length], radius: 2 },
        ]);
        expect(message).toContain("out of range");

        // A top edge (z = 20) is fillet-able; the extent shrinks at the corners only.
        const topIndex = edges.findIndex((edge) => edge.boundingBox().min.z > 19.9);
        expect(topIndex).toBeGreaterThanOrEqual(0);
        run(doc, [{ op: "fillet", id: "f1", body: body.id, edgeIndexes: [topIndex], radius: 4 }]);
        expectClean(body);
        expect(body.featureItems()).toHaveLength(2);
    });

    test("a boolean adopts its tool nodes as hidden children instead of deleting them", () => {
        const doc = newDoc();
        const result = run(doc, [
            ...plate(20),
            { op: "sketch", id: "s2", plane: "XY", entities: rect(10, 10, 20, 20) },
            { op: "extrude", id: "b2", sketch: "s2", depth: 40 },
            { op: "boolean", id: "c1", body: "b1", operation: "cut", tools: ["b2"] },
        ]);

        const body = createdBody(doc, result, "b1");
        const tool = createdBody(doc, result, "b2");
        expectClean(body);
        expect(result.consumed.map((c) => c.nodeId)).toEqual([tool.id]);
        // Hidden by re-parenting, not by a visibility flag — the body's child list renders nothing.
        expect(body.firstChild?.id).toBe(tool.id);
        expect(tool.parent?.id).toBe(body.id);
        // The outer extent is unchanged by the pocket; the tool still exists as a node.
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 20]);
        expect(nodeIds(doc)).toContain(tool.id);
    });

    test("a common with a disjoint tool fails and rolls the whole program back", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");
        const before = nodeIds(doc);

        const message = runExpectingFailure(doc, [
            { op: "sketch", id: "s2", plane: "XY", entities: rect(100, 100, 120, 120) },
            { op: "extrude", id: "b2", sketch: "s2", depth: 20 },
            { op: "boolean", id: "c1", body: body.id, operation: "common", tools: ["b2"] },
        ]);

        expect(message).toContain('op 2 ("boolean") failed');
        expect(message).toContain("Boolean common produced an empty shape");
        // Nothing kept: no tool sketch/body, no boolean feature, the plate untouched.
        expect(nodeIds(doc)).toEqual(before);
        expect(body.featureItems()).toHaveLength(1);
        expectClean(body);
        expect(extent(body)).toEqual([0, 0, 0, 40, 30, 20]);
    });
});

describe("constraints", () => {
    test("a constrained sketch is solved before it is stored", () => {
        const doc = newDoc();
        run(doc, [
            {
                op: "sketch",
                id: "s1",
                plane: "XY",
                entities: [{ type: "line", params: [0, 0, 10, 0] }],
                // The drawn line is 10 long; the dimension has to move it to 60.
                constraints: [
                    {
                        kind: "P2PDistance",
                        refs: [
                            { entity: 1, point: 0 },
                            { entity: 1, point: 1 },
                        ],
                        datum: 60,
                    },
                ],
            },
        ]);

        const sketch = doc.modelManager.findNodes((n) => n instanceof SketchNode)[0] as SketchNode;
        const [x1, y1, x2, y2] = sketch.data.entities[0].params;
        expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(60, 1);
        expect(sketch.data.constraints).toHaveLength(1);
    });

    test("an unknown constraint kind names the valid ones", () => {
        const doc = newDoc();
        const message = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s1",
                plane: "XY",
                entities: rect(0, 0, 40, 30),
                constraints: [{ kind: "NotAKind", refs: [{ entity: 1, point: 0 }] }],
            },
        ]);
        expect(message).toContain("unknown constraint kind");
        expect(message).toContain("P2PCoincident");
    });
});

describe("model tree icons", () => {
    test("a sketch reads apart from the solid it feeds", () => {
        const doc = newDoc();
        const result = run(doc, plate(20));
        const body = createdBody(doc, result, "b1");
        const sketch = doc.modelManager.findNodes((n) => n instanceof SketchNode)[0] as SketchNode;

        expect(sketch.icon).toBe("icon-sketchEdit");
        expect(body.icon).toBe("icon-shape");
        expect(new FolderNode({ document: doc, name: "folder" }).icon).toBe("icon-folder");
        // The point of the contract: a sketch must not read as another solid.
        expect(sketch.icon).not.toBe(body.icon);
    });
});

describe("undo", () => {
    test("one program is one undo step", () => {
        const doc = newDoc();
        run(doc, plate(20));
        expect(nodeIds(doc)).toHaveLength(2);

        doc.history.undo();
        expect(nodeIds(doc)).toEqual([]);

        doc.history.redo();
        expect(nodeIds(doc)).toHaveLength(2);
        expectClean(
            doc.modelManager.findNodes((n) => n instanceof ParametricBodyNode)[0] as ParametricBodyNode,
        );
    });
});

describe("cancellation and op timing", () => {
    test("a signal aborted after op 0 stops the program before op 1 and rolls it back", () => {
        const doc = newDoc();
        const before = nodeIds(doc);
        const controller = new AbortController();
        const finished: string[] = [];

        let message = "";
        try {
            Transaction.execute(doc, "test program", () => {
                runParametricProgram(doc, plate(20), {
                    signal: controller.signal,
                    onOpFinished: (op, milliseconds) => {
                        expect(milliseconds).toBeGreaterThanOrEqual(0);
                        finished.push(op);
                        controller.abort();
                    },
                });
            });
        } catch (err) {
            message = (err as Error).message;
        }

        expect(message).toBe('cancelled before op 1 ("extrude"); the whole program was rolled back');
        expect(finished).toEqual(["sketch"]);
        // The sketch op 0 created is gone with the rollback.
        expect(nodeIds(doc)).toEqual(before);
        expect(doc.modelManager.findNodes((n) => n instanceof SketchNode)).toEqual([]);
    });

    test("every op, a failing one included, reports its wall time", () => {
        const doc = newDoc();
        const finished: string[] = [];

        expect(() =>
            runParametricProgram(doc, [...plate(20), { op: "features", body: "missing" } as ParametricOp], {
                onOpFinished: (op) => finished.push(op),
            }),
        ).toThrow('op 2 ("features") failed');
        expect(finished).toEqual(["sketch", "extrude", "features"]);
    });
});

describe("compact parametric responses", () => {
    test("a small edit on a hundred-feature body omits untouched rows and preserves explicit reads", () => {
        const doc = newDoc();
        try {
            const created = run(doc, plate(20), { responseMode: "compact" });
            const body = createdBody(doc, created, "b1");
            expect(created.bodies[0].features.map((feature) => feature.id)).toEqual([body.features[0].id]);
            const base = body.features[0];
            body.setFeaturesEmitShapeChanged([
                base,
                ...Array.from({ length: 99 }, (_, index) => ({
                    ...base,
                    id: `quiet-${index}`,
                    suppressed: true,
                })),
            ]);
            const ops: ParametricOp[] = [
                {
                    op: "editFeature",
                    body: body.id,
                    featureId: base.id,
                    action: "setParameter",
                    key: "depth",
                    value: 25,
                },
            ];
            const compact = run(doc, ops, { responseMode: "compact" });
            expect(compact.bodies[0].features.map((feature) => feature.id)).toEqual([base.id]);
            expect(compact.bodies[0].featureCount).toBe(100);
            expect(compact.bodies[0].status).toBe("ok");
            expect(compact.bodies[0].diagnostics).toEqual([]);
            expect(compact.bodies[0].removedFeatureIds).toEqual([]);
            expect(JSON.stringify(compact)).not.toContain("quiet-0");
            const full = run(doc, ops);
            expect(full.bodies[0].features).toHaveLength(100);
            expect(full.bodies[0]).not.toHaveProperty("featureCount");
            expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 10);
            const read = run(doc, [{ op: "features", body: body.id, id: "all" }], {
                responseMode: "compact",
            });
            expect(read.results["all"]).toHaveLength(100);
            expect(read.bodies).toEqual([]);
        } finally {
            doc.close();
        }
    });

    test("compact edits report renames, suppression, moves, removals and appended feature ids", () => {
        const doc = newDoc();
        try {
            const body = elevenFeaturePlate(doc);
            const id = body.features[1].id;
            const compact = { responseMode: "compact" as const };
            const renamed = run(
                doc,
                [{ op: "editFeature", body: body.id, featureId: id, action: "rename", value: "Renamed" }],
                compact,
            );
            expect(renamed.bodies[0].features).toHaveLength(1);
            expect(renamed.bodies[0].features[0].name).toBe("Renamed");
            const moved = run(
                doc,
                [{ op: "editFeature", body: body.id, featureId: id, action: "moveTo", index: 3 }],
                compact,
            );
            expect(moved.bodies[0].features.map((feature) => feature.id)).toEqual([id]);
            const suppressed = run(
                doc,
                [{ op: "editFeature", body: body.id, featureId: id, action: "suppress", value: true }],
                compact,
            );
            expect(suppressed.bodies[0].features[0].suppressed).toBe(true);
            const removed = run(
                doc,
                [{ op: "editFeature", body: body.id, featureId: id, action: "remove" }],
                compact,
            );
            expect(removed.bodies[0].features).toEqual([]);
            expect(removed.bodies[0].removedFeatureIds).toEqual([id]);
            expect(removed.bodies[0].featureCount).toBe(10);
            const added = run(
                doc,
                [{ op: "extrude", id: "joined", body: body.id, sketch: "s1", depth: 25, operation: "fuse" }],
                compact,
            );
            const latest = body.features.at(-1)!;
            expect(added.bodies[0].features.map((feature) => feature.id)).toEqual([latest.id]);
            expect(added.bodies[0].featureCount).toBe(11);
            expect(
                added.bodies[0].features[0].parameters.find((parameter) => parameter.key === "depth")?.value,
            ).toBe(25);
        } finally {
            doc.close();
        }
    });

    test("compact responses retain untouched error/warning diagnostics", () => {
        const doc = newDoc();
        try {
            const body = elevenFeaturePlate(doc);
            const realItems = body.featureItems.bind(body);
            const staleId = body.features[1].id;
            body.featureItems = () =>
                realItems().map((item) =>
                    item.id === staleId
                        ? { ...item, error: "Existing rebuild failure", warning: "Reselect reference" }
                        : item,
                );
            try {
                const result = run(
                    doc,
                    [
                        {
                            op: "editFeature",
                            body: body.id,
                            featureId: body.features[0].id,
                            action: "rename",
                            value: "Base",
                        },
                    ],
                    { responseMode: "compact" },
                );
                expect(result.bodies[0].features.map((feature) => feature.id)).toEqual([body.features[0].id]);
                expect(result.bodies[0].status).toBe("error");
                expect(result.bodies[0].diagnostics).toEqual([
                    { featureId: staleId, error: "Existing rebuild failure", warning: "Reselect reference" },
                ]);
            } finally {
                body.featureItems = realItems;
            }
        } finally {
            doc.close();
        }
    });

    test("compact mode preserves rollback errors and validates the mode", () => {
        const doc = newDoc();
        try {
            const body = elevenFeaturePlate(doc);
            const before = body.featuresJson;
            expect(() =>
                run(
                    doc,
                    [
                        {
                            op: "editFeature",
                            body: body.id,
                            featureId: body.features[0].id,
                            action: "setParameter",
                            key: "depth",
                            value: 0,
                        },
                    ],
                    { responseMode: "compact" },
                ),
            ).toThrow(/op 0.*failed/);
            expect(body.featuresJson).toBe(before);
            expect(() => run(doc, plate(10), { responseMode: "quiet" as "compact" })).toThrow(/responseMode/);
        } finally {
            doc.close();
        }
    });
});

test("the MCP compact handler returns only the edited feature from a large body", async () => {
    const doc = newDoc();
    const app = createMockApplication();
    (app as any).activeView = { document: doc };
    doc.selection = createMockSelection();
    const clearSelection = rs.spyOn(doc.selection, "clearSelection");
    rs.stubGlobal("app", app);
    try {
        const body = elevenFeaturePlate(doc);
        const tool = buildParametricTools()[0];
        const response = await tool.handler({
            responseMode: "compact",
            ops: [
                {
                    op: "editFeature",
                    body: body.id,
                    featureId: body.features[0].id,
                    action: "setParameter",
                    key: "depth",
                    value: 25,
                },
            ],
        });
        const result = JSON.parse(response as string);
        expect(result.bodies[0].features.map((feature: { id: string }) => feature.id)).toEqual([
            body.features[0].id,
        ]);
        expect(result.bodies[0].featureCount).toBe(11);
        expect(result.bodies[0].status).toBe("ok");
        expect(clearSelection).toHaveBeenCalledOnce();
    } finally {
        clearSelection.mockRestore();
        rs.unstubAllGlobals();
        doc.close();
    }
});
