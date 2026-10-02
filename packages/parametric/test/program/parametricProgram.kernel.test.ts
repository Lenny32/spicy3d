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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rs } from "@rstest/core";
import {
    DocumentMutations,
    DocumentRebuilds,
    FolderNode,
    I18n,
    type IEdge,
    type IFace,
    PerformanceTrace,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { createMcpServer, SerialQueue } from "../../../ai/src/mcp/server";
import { buildParametricTools, runParametric } from "../../../ai/src/tools/parametricTools";
import { buildParametricJobTools, buildProgramJobTools } from "../../../ai/src/tools/programJobs";
import { buildReadTools } from "../../../ai/src/tools/readTools";
import { waitForTerminalJob } from "../../../ai/test/_helpers/waitForTerminalJob";
import type { FilletFeatureData } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import {
    type EdgesReport,
    type ParametricOp,
    type ProgramRunOptions,
    runParametricProgram,
} from "../../src/program/parametricProgram";
import type { SketchData } from "../../src/sketch/sketchModel";
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

describe("sweep program operations", () => {
    test("the published MCP tool accepts plain JSON sweep creation and editing", async () => {
        const doc = newDoc();
        const app = createMockApplication();
        app.activeView = { document: doc } as unknown as typeof app.activeView;
        doc.selection = createMockSelection();
        rs.stubGlobal("app", app);
        try {
            const tool = buildParametricTools()[0];
            const response = JSON.parse(
                (await tool.handler({
                    responseMode: "compact",
                    ops: [
                        { op: "sketch", id: "section", entities: rect(-1, -1, 1, 1) },
                        {
                            op: "sketch",
                            id: "path",
                            plane: "ZX",
                            entities: [{ type: "line", params: [0, 0, 10, 0] }],
                        },
                        {
                            op: "sweep",
                            id: "sweep",
                            section: { sketchId: "section" },
                            path: { nodeId: "path", edgeIndexes: [0] },
                        },
                    ],
                })) as string,
            );
            const bodyId = response.created.find((entry: { id: string }) => entry.id === "sweep").nodeId;
            const body = doc.modelManager.findNode((node) => node.id === bodyId) as ParametricBodyNode;
            expect(body.shape.value.volume()).toBeCloseTo(40, 5);
            const edited = JSON.parse(
                (await tool.handler({
                    responseMode: "compact",
                    ops: [{ op: "editSweep", body: body.id, featureId: body.features[0].id, solid: false }],
                })) as string,
            );
            expect(edited.bodies[0].status).toBe("ok");
            expect(body.features[0]).toMatchObject({ solid: false });
            doc.history.undo();
            expect(body.shape.value.volume()).toBeCloseTo(40, 5);
        } finally {
            rs.unstubAllGlobals();
        }
    });
    function sweepProgram(doc: TestDocument) {
        const result = run(doc, [
            { op: "sketch", id: "section", entities: rect(-1, -1, 1, 1) },
            { op: "sketch", id: "path", plane: "ZX", entities: [{ type: "line", params: [0, 0, 10, 0] }] },
            {
                op: "sweep",
                id: "sweep",
                section: { sketchId: "section", profileIndex: 0 },
                path: { nodeId: "path", edgeIndexes: [0] },
            },
        ]);
        const bodyId = result.created.find((entry) => entry.id === "sweep")?.nodeId;
        const body = doc.modelManager.findNode((node) => node.id === bodyId) as ParametricBodyNode;
        expect(body).toBeInstanceOf(ParametricBodyNode);
        expect(body.shape.isOk).toBe(true);
        return { result, body };
    }

    test("JSON creation captures source ancestry and edits options in one undo step", () => {
        const doc = newDoc();
        const { body } = sweepProgram(doc);
        expect(body.shape.value.volume()).toBeCloseTo(40, 5);
        const feature = body.features[0];
        expect(feature).toMatchObject({
            type: "sweep",
            path: { edges: [{ edgeId: expect.stringMatching(/^sketch:.*:path:ent/) }] },
        });
        const result = run(doc, [{ op: "editSweep", body: body.id, featureId: feature.id, solid: false }]);
        expect(result.bodies[0].features.map((item) => item.error)).toEqual([undefined]);
        expect(body.features[0]).toMatchObject({ solid: false });
        expect(body.shape.value.findSubShapes(ShapeTypes.face)).toHaveLength(4);
        doc.history.undo();
        expect(body.features[0]).not.toHaveProperty("solid");
        expect(body.shape.value.volume()).toBeCloseTo(40, 5);
    });

    test("a failed path repick rolls back the program and keeps its previous undo position", () => {
        const doc = newDoc();
        const { result, body } = sweepProgram(doc);
        const pathId = result.created.find((entry) => entry.id === "path")?.nodeId;
        expect(pathId).not.toBeUndefined();
        const before = JSON.stringify(body.features);
        const position = doc.history.position();
        expect(() =>
            run(doc, [
                {
                    op: "editSweep",
                    body: body.id,
                    featureId: body.features[0].id,
                    path: { nodeId: pathId as string, edgeIndexes: [0, 0] },
                },
            ]),
        ).toThrow(/repeated/);
        expect(JSON.stringify(body.features)).toBe(before);
        expect(doc.history.position()).toBe(position);
        expect(body.shape.value.volume()).toBeCloseTo(40, 5);
    });
});

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

    test("the documented open-curve workflow lofts and thickens without adding section payload fields", () => {
        const doc = newDoc();
        const result = run(doc, [
            { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 20 } },
            {
                op: "sketch",
                id: "s1",
                entities: [
                    {
                        type: "bspline",
                        points: [
                            [-10, 0],
                            [0, 3],
                            [10, 0],
                        ],
                    },
                ],
            },
            {
                op: "sketch",
                id: "s2",
                plane: { construction: "p1" },
                entities: [
                    {
                        type: "bspline",
                        points: [
                            [-8, 0],
                            [0, 4],
                            [8, 0],
                        ],
                    },
                ],
            },
            { op: "loft", id: "skin", sections: ["s1", "s2"], solid: false },
            { op: "thicken", id: "wall", body: "skin", thickness: 1 },
        ]);
        const body = createdBody(doc, result, "skin");
        expectClean(body);
        expect(body.shape.value.shapeType).toBe(ShapeTypes.solid);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(0);
        expect(body.features.map((feature) => feature.type)).toEqual(["loft", "thicken"]);
        expect(body.features[0]).toMatchObject({ solid: false });
        expect(Object.keys(body.features[0]).sort()).toEqual(["id", "sections", "solid", "type"]);
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
    test("variable radius laws create persistent picks, survive an upstream edit, and undo as one change", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(40)), "b1");
        const originalEdges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = originalEdges.findIndex(
            (edge) => Math.abs(edge.endPoint().z - edge.startPoint().z) > 39,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        for (const edge of originalEdges) edge.dispose();
        const law = [
            { position: 0, radius: "1 mm" },
            { position: 0.5, radius: "2 mm" },
            { position: 1, radius: "3 mm" },
        ];
        run(doc, [{ op: "fillet", id: "variable", body: body.id, edgeIndexes: [index], radiusLaw: law }]);
        expectClean(body);
        expect(body.shape.value.checkShape()).toBe(true);
        const feature = body.features[1] as FilletFeatureData;
        expect(feature.radiusLaw).toEqual(law);
        expect(feature.edges[0].edgeId).not.toBeUndefined();
        const selectedId = feature.edges[0].edgeId;
        const volume = body.shape.value.volume();
        run(doc, [
            {
                op: "editFeature",
                body: body.id,
                featureId: body.features[0].id,
                action: "setParameter",
                key: "depth",
                value: 50,
            },
        ]);
        expectClean(body);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(volume);
        expect((body.features[1] as FilletFeatureData).edges[0].edgeId).toBe(selectedId);
        expect((body.features[1] as FilletFeatureData).radiusLaw).toEqual(law);
        doc.history.undo();
        expectClean(body);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
        doc.history.undo();
        expect(body.features).toHaveLength(1);
        expect(body.shape.value.volume()).toBeCloseTo(48000, 5);
        doc.history.redo();
        expectClean(body);
        expect((body.features[1] as FilletFeatureData).radiusLaw).toEqual(law);
    });

    test("a whole-law edit can be cleared and invalid replacement rolls back", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(40)), "b1");
        run(doc, [{ op: "fillet", id: "constant", body: body.id, edgeIndexes: [0], radius: 1 }]);
        const id = body.features[1].id;
        const constantVolume = body.shape.value.volume();
        run(doc, [
            {
                op: "editFeature",
                body: body.id,
                featureId: id,
                action: "setRadiusLaw",
                radiusLaw: [
                    { position: 0, radius: 1 },
                    { position: 1, radius: 2 },
                ],
            },
        ]);
        expectClean(body);
        expect((body.features[1] as FilletFeatureData).radiusLaw).toHaveLength(2);
        expect(body.shape.value.volume()).toBeLessThan(constantVolume);
        const before = body.features;
        expect(
            runExpectingFailure(doc, [
                {
                    op: "editFeature",
                    body: body.id,
                    featureId: id,
                    action: "setRadiusLaw",
                    radiusLaw: [
                        { position: 0, radius: -1 },
                        { position: 1, radius: 2 },
                    ],
                },
            ]),
        ).toContain("positive finite");
        expect(body.features).toEqual(before);
        expectClean(body);
        run(doc, [{ op: "editFeature", body: body.id, featureId: id, action: "setRadiusLaw" }]);
        expectClean(body);
        expect((body.features[1] as FilletFeatureData).radiusLaw).toBeUndefined();
        expect(body.shape.value.volume()).toBeCloseTo(constantVolume, 5);
    });

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

    test("a bottom loop fillet fails after near-wall recesses but works before them", () => {
        const doc = newDoc();
        // Existing mouse-skirt fixture from #126; synthetic recesses exercise the #132 workflow.
        const sections = JSON.parse(
            readFileSync(path.resolve(import.meta.dirname, "../fixtures/mouseSkirt.json"), "utf8"),
        ) as { z: number; data: SketchData }[];
        const sketches = sections.map(({ z, data }) => {
            const sketch = new SketchNode({
                document: doc,
                plane: new Plane({ origin: new XYZ(0, 0, z), normal: XYZ.unitZ, xvec: XYZ.unitX }),
                data,
            });
            doc.modelManager.addNode(sketch);
            return sketch;
        });
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "mouseLoft",
                    type: "loft",
                    sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                    solid: true,
                    ruled: true,
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        run(doc, [
            {
                op: "sketch",
                id: "recesses",
                entities: [
                    { type: "circle", params: [-41, 0, 3] },
                    { type: "circle", params: [0, 0, 3] },
                    { type: "circle", params: [15, 0, 3] },
                ],
            },
            { op: "extrude", id: "pockets", body: body.id, sketch: "recesses", depth: 3, operation: "cut" },
        ]);
        const original = body.features;
        const volume = body.shape.value.volume();
        const picks = run(doc, [
            {
                op: "edges",
                body: body.id,
                selector: { geometry: { kind: "other", elevation: { value: 0 } }, tolerance: 0.001 },
                expectedCount: 1,
            },
        ]).results["edges"] as EdgesReport;
        expect(picks.selection?.status).toBe("matched");
        expect(picks.edges).toHaveLength(1);
        const message = runExpectingFailure(doc, [
            { op: "fillet", id: "appended", body: body.id, edgeRefs: [picks.edges[0].reference], radius: 4 },
        ]);
        expect(message).toContain("Failed to fillet");
        expect(message).toContain("invalid result face index");
        expect(message).toContain("BRepCheck: Intersecting Wires");
        expect(message).toContain("edge 0 adjoining faces [0, 1]");
        expect(message).toContain("before downstream cuts with index");
        expect(body.features).toEqual(original);
        expectClean(body);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
        run(doc, [
            {
                op: "fillet",
                id: "bottom",
                body: body.id,
                index: 1,
                edgeRefs: [picks.edges[0].reference],
                radius: 4,
            },
        ]);
        expect(body.features.map((feature) => feature.type)).toEqual(["loft", "fillet", "extrude"]);
        expect(body.features[2].id).toBe(original[1].id);
        expectClean(body);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(Math.abs(body.shape.value.volume() - volume)).toBeGreaterThan(1);
    });

    test.each([
        "fillet",
        "chamfer",
    ] as const)("inserts a %s before a cut and restores it through undo/redo", (op) => {
        const doc = newDoc();
        const result = run(doc, [
            ...plate(20),
            { op: "sketch", id: "hole", entities: [{ type: "circle", params: [20, 15, 3] }] },
            { op: "extrude", id: "cut", body: "b1", sketch: "hole", depth: 20, operation: "cut" },
        ]);
        const body = createdBody(doc, result, "b1");
        const original = body.features;
        const volume = body.shape.value.volume();
        const picks = run(doc, [
            {
                op: "edges",
                body: body.id,
                index: 1,
                selector: { geometry: { kind: "line", elevation: { value: 20 } } },
                expectedCount: 4,
            },
        ]).results["edges"] as EdgesReport;
        expect(picks.selection?.status).toBe("matched");
        expect(picks.edges).toHaveLength(4);
        // Querying historical topology must leave the displayed shape and saved list alone.
        expect(body.features).toEqual(original);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 6);
        const corner = {
            op,
            id: "round",
            body: body.id,
            index: 1,
            edgeRefs: [JSON.parse(JSON.stringify(picks.edges[0].reference))],
            ...(op === "fillet" ? { radius: 1 } : { distance: 1 }),
        };
        run(doc, [corner]);
        expect(body.features.map((feature) => feature.type)).toEqual(["extrude", op, "extrude"]);
        expect(body.features[2].id).toBe(original[1].id);
        expectClean(body);
        expect(body.shape.value.checkShape()).toBe(true);
        const roundedVolume = body.shape.value.volume();
        expect(roundedVolume).toBeLessThan(volume);
        doc.history.undo();
        expect(body.features).toEqual(original);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 6);
        doc.history.redo();
        expectClean(body);
        expect(body.features.map((feature) => feature.type)).toEqual(["extrude", op, "extrude"]);
        expect(body.shape.value.volume()).toBeCloseTo(roundedVolume, 6);
    });

    test("removal shifts face-sketch anchors and unsafe moves are refused through undo/redo", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(10)), "b1");
        function topFace(z: number): number {
            const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
            try {
                const index = faces.findIndex(
                    (face) => face.normal(0, 0)[1].z > 0.999 && Math.abs(face.boundingBox().min.z - z) < 1e-5,
                );
                expect(index).toBeGreaterThanOrEqual(0);
                return index;
            } finally {
                for (const face of faces) face.dispose();
            }
        }
        const bossResult = run(doc, [
            {
                op: "sketch",
                id: "bossSketch",
                plane: { nodeId: body.id, faceIndex: topFace(10) },
                entities: rect(10, 10, 20, 20),
            },
            { op: "extrude", id: "boss", body: body.id, sketch: "bossSketch", depth: 5, operation: "fuse" },
        ]);
        const cutResult = run(doc, [
            {
                op: "sketch",
                id: "cutSketch",
                plane: { nodeId: body.id, faceIndex: topFace(15) },
                entities: rect(10, 10, 20, 20),
            },
            { op: "extrude", id: "cut", body: body.id, sketch: "cutSketch", depth: -3, operation: "cut" },
        ]);
        const bossSketch = doc.modelManager.findNode(
            (node) => node.id === bossResult.created[0].nodeId,
        ) as SketchNode;
        const cutSketch = doc.modelManager.findNode(
            (node) => node.id === cutResult.created[0].nodeId,
        ) as SketchNode;
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(2);
        const original = body.features;
        const volume = body.shape.value.volume();
        const moved = body.moveFeatureTo(body.features[1].id, 2);
        expect(moved.isOk).toBe(false);
        expect(moved.error).toContain("sketch");
        expect(body.features).toEqual(original);
        runExpectingFailure(doc, [
            { op: "editFeature", body: body.id, featureId: body.features[1].id, action: "moveTo", index: 2 },
        ]);
        expect(body.features).toEqual(original);
        // A suppressed upstream step changes indexes without changing the model.
        run(doc, [{ op: "chamfer", id: "corner", body: body.id, index: 1, edgeIndexes: [0], distance: 1 }]);
        const corner = body.features[1].id;
        run(doc, [{ op: "editFeature", body: body.id, featureId: corner, action: "suppress", value: true }]);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(3);
        run(doc, [{ op: "editFeature", body: body.id, featureId: corner, action: "remove" }]);
        expectClean(body);
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(2);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
        doc.history.undo();
        expect(cutSketch.data.refPositions?.[body.id]).toBe(3);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
        doc.history.redo();
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(2);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
    });

    test("insertion preserves face-sketch anchors, planes and the downstream cut through undo/redo", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(10)), "b1");
        function topFace(z: number): number {
            const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
            try {
                const index = faces.findIndex(
                    (face) => face.normal(0, 0)[1].z > 0.999 && Math.abs(face.boundingBox().min.z - z) < 1e-5,
                );
                expect(index).toBeGreaterThanOrEqual(0);
                return index;
            } finally {
                for (const face of faces) face.dispose();
            }
        }
        const bossResult = run(doc, [
            {
                op: "sketch",
                id: "bossSketch",
                plane: { nodeId: body.id, faceIndex: topFace(10) },
                entities: rect(10, 10, 20, 20),
            },
            { op: "extrude", id: "boss", body: body.id, sketch: "bossSketch", depth: 5, operation: "fuse" },
        ]);
        const cutResult = run(doc, [
            {
                op: "sketch",
                id: "cutSketch",
                plane: { nodeId: body.id, faceIndex: topFace(15) },
                entities: [{ type: "circle", params: [15, 15, 2] }],
            },
            { op: "extrude", id: "cut", body: body.id, sketch: "cutSketch", depth: -3, operation: "cut" },
        ]);
        const bossSketch = doc.modelManager.findNode(
            (node) => node.id === bossResult.created[0].nodeId,
        ) as SketchNode;
        const cutSketch = doc.modelManager.findNode(
            (node) => node.id === cutResult.created[0].nodeId,
        ) as SketchNode;
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(2);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        const original = body.features;
        const volume = body.shape.value.volume();
        expect(volume).toBeCloseTo(40 * 30 * 10 + 100 * 5 - Math.PI * 4 * 3, 5);
        const edges = body.cornerEditStateAt(1)!.shape!.findSubShapes(ShapeTypes.edge) as IEdge[];
        let edgeIndex: number;
        let removedVolume: number;
        try {
            edgeIndex = edges.findIndex((edge) => edge.boundingBox().min.z > 9.999);
            expect(edgeIndex).toBeGreaterThanOrEqual(0);
            removedVolume = edges[edgeIndex].length() / 2;
        } finally {
            for (const edge of edges) edge.dispose();
        }
        run(doc, [
            { op: "chamfer", id: "corner", body: body.id, index: 1, edgeIndexes: [edgeIndex], distance: 1 },
        ]);
        expectClean(body);
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(3);
        expect(bossSketch.plane.origin.z).toBeCloseTo(10, 6);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(body.shape.value.volume()).toBeCloseTo(volume - removedVolume, 5);
        doc.history.undo();
        expectClean(body);
        expect(body.features).toEqual(original);
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(2);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
        doc.history.redo();
        expectClean(body);
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(3);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(body.shape.value.volume()).toBeCloseTo(volume - removedVolume, 5);
        // A failed insertion restores shifted anchors together with the feature list.
        const chamfered = body.features;
        runExpectingFailure(doc, [
            { op: "chamfer", id: "bad", body: body.id, index: 1, edgeIndexes: [edgeIndex], distance: 1000 },
        ]);
        expectClean(body);
        expect(body.features).toEqual(chamfered);
        expect(bossSketch.data.refPositions?.[body.id]).toBe(1);
        expect(cutSketch.data.refPositions?.[body.id]).toBe(3);
        expect(cutSketch.plane.origin.z).toBeCloseTo(15, 6);
        expect(body.shape.value.volume()).toBeCloseTo(volume - removedVolume, 5);
    });

    test.each([
        "fillet",
        "chamfer",
    ] as const)("a sketch at the insertion index keeps the projected edge consumed by a %s", (op) => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(10)), "b1");
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        let faceIndex: number;
        try {
            faceIndex = faces.findIndex((face) => face.normal(0, 0)[1].z > 0.999);
            expect(faceIndex).toBeGreaterThanOrEqual(0);
        } finally {
            for (const face of faces) face.dispose();
        }
        const result = run(doc, [
            {
                op: "sketch",
                id: "cavity",
                plane: { nodeId: body.id, faceIndex },
                entities: [{ type: "circle", params: [20, 15, 3] }],
            },
            { op: "extrude", id: "cut", body: body.id, sketch: "cavity", depth: -3, operation: "cut" },
        ]);
        const sketch = doc.modelManager.findNode(
            (node) => node.id === result.created[0].nodeId,
        ) as SketchNode;
        expect(sketch.data.refPositions?.[body.id]).toBe(1);
        const refs = sketch.data.externalRefs!;
        expect(refs).toHaveLength(4);
        const projected = refs[0];
        expect(projected.dangling).not.toBe(true);
        const picks = run(doc, [{ op: "edges", body: body.id, index: 1 }]).results["edges"] as EdgesReport;
        const consumed = picks.edges.find((pick) => pick.reference.edge.edgeId === projected.edge.edgeId);
        expect(consumed).not.toBeUndefined();
        const cutVolume = body.cornerEditStateAt(1)!.shape!.volume() - body.shape.value.volume();
        expect(cutVolume).toBeCloseTo(Math.PI * 9 * 3, 5);
        run(doc, [
            {
                op,
                id: "corner",
                body: body.id,
                index: 1,
                edgeRefs: [consumed!.reference],
                ...(op === "fillet" ? { radius: 1 } : { distance: 1 }),
            },
        ]);
        expectClean(body);
        expect(sketch.data.refPositions?.[body.id]).toBe(1);
        const after = sketch.data.externalRefs!.find((ref) => ref.entityId === projected.entityId);
        expect(after).not.toBeUndefined();
        expect(after!.dangling).not.toBe(true);
        expect(after!.snapshot).toEqual(projected.snapshot);
        expect(body.cornerEditStateAt(2)!.shape!.volume() - body.shape.value.volume()).toBeCloseTo(
            cutVolume,
            5,
        );
    });

    test.each([
        -1,
        0,
        1.5,
        3,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])("rejects unusable insertion index %s without changes", (index) => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(20)), "b1");
        const original = body.features;
        expect(() =>
            run(doc, [{ op: "fillet", id: "f", body: body.id, index, edgeIndexes: [0], radius: 1 }]),
        ).toThrow(index === 0 ? "no input shape" : "must be an integer");
        expect(body.features).toEqual(original);
        expectClean(body);
    });

    test("edges created by a later cut cannot be selected for an earlier fillet", () => {
        const doc = newDoc();
        const body = createdBody(
            doc,
            run(doc, [
                ...plate(20),
                { op: "sketch", id: "hole", entities: [{ type: "circle", params: [20, 15, 3] }] },
                { op: "extrude", id: "cut", body: "b1", sketch: "hole", depth: 20, operation: "cut" },
            ]),
            "b1",
        );
        const original = body.features;
        const final = run(doc, [{ op: "edges", body: body.id, selector: { geometry: { kind: "circle" } } }])
            .results["edges"] as EdgesReport;
        expect(final.edges).toHaveLength(2);
        const historical = run(doc, [
            { op: "edges", body: body.id, index: 1, selector: { geometry: { kind: "circle" } } },
        ]).results["edges"] as EdgesReport;
        expect(historical.edges).toHaveLength(0);
        expect(() =>
            run(doc, [
                {
                    op: "fillet",
                    id: "f",
                    body: body.id,
                    index: 1,
                    edgeRefs: [final.edges[0].reference],
                    radius: 0.5,
                },
            ]),
        ).toThrow("persistent edge selection is missing or ambiguous");
        expect(body.features).toEqual(original);
        expectClean(body);
    });

    test("historical adjacency uses the input faces after insertion", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(20)), "b1");
        const picks = run(doc, [{ op: "edges", body: body.id, index: 1 }]).results["edges"] as EdgesReport;
        const input = body.cornerEditStateAt(1)!;
        const edges = input.shape!.findSubShapes(ShapeTypes.edge);
        const faces = input.shape!.findSubShapes(ShapeTypes.face);
        const adjacent = edges[0].findAncestor(ShapeTypes.face, input.shape!);
        const faceIds = faces.flatMap((face, index) =>
            adjacent.some((other) => other.isSame(face)) ? [input.faceIds![index]] : [],
        );
        expect(faceIds).toHaveLength(2);
        for (const shape of [...adjacent, ...faces, ...edges]) shape.dispose();
        run(doc, [{ op: "fillet", id: "f", body: body.id, index: 1, edgeIndexes: [0], radius: 1 }]);
        const selected = run(doc, [
            {
                op: "edges",
                body: body.id,
                index: 1,
                selector: { adjoiningFaces: { exact: faceIds }, curves: [picks.edges[0].reference] },
            },
        ]).results["edges"] as EdgesReport;
        expect(selected.edges).toEqual([picks.edges[0]]);
        expect(body.features.map((feature) => feature.type)).toEqual(["extrude", "fillet"]);
        expectClean(body);
    });

    test("an explicit end index appends a corner feature", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(20)), "b1");
        run(doc, [
            {
                op: "fillet",
                id: "f",
                body: body.id,
                index: body.features.length,
                edgeIndexes: [0],
                radius: 1,
            },
        ]);
        expect(body.features.map((feature) => feature.type)).toEqual(["extrude", "fillet"]);
        expectClean(body);
        expect(body.shape.value.checkShape()).toBe(true);
    });

    test("insertion resolves edge indexes at its input and rolls back a broken tail", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(20)), "b1");
        const original = body.features;
        run(doc, [{ op: "fillet", id: "first", body: body.id, edgeIndexes: [0], radius: 1 }]);
        const rounded = body.features;
        // Both corners cannot round the same edge: failure in the existing tail must roll back insertion.
        const message = runExpectingFailure(doc, [
            { op: "fillet", id: "insert", body: body.id, index: 1, edgeIndexes: [0], radius: 1 },
        ]);
        expect(message).toContain(rounded[1].id);
        expect(message).toContain("fillet input at feature index 1: edge 0 adjoining faces [");

        expect(body.features).toEqual(rounded);
        expectClean(body);
        doc.history.undo();
        expect(body.features).toEqual(original);
    });

    test("a failed fillet on a single feature reports topology without an insertion hint", () => {
        const doc = newDoc();
        const body = createdBody(doc, run(doc, plate(20)), "b1");
        const original = body.features;
        const message = runExpectingFailure(doc, [
            { op: "fillet", id: "f", body: body.id, edgeIndexes: [0], radius: 1000 },
        ]);
        expect(message).toContain("fillet input at feature index 1: edge 0 adjoining faces [");
        expect(message).not.toContain("before downstream cuts with index");
        expect(body.features).toEqual(original);
        expectClean(body);
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

test("the MCP handler accepts variable radius laws and retains only approved sample fields", async () => {
    const doc = newDoc();
    const app = createMockApplication();
    (app as any).activeView = { document: doc };
    doc.selection = createMockSelection();
    rs.stubGlobal("app", app);
    try {
        const body = createdBody(doc, run(doc, plate(40)), "b1");
        const tool = buildParametricTools()[0];
        const response = await tool.handler({
            responseMode: "compact",
            ops: [
                {
                    op: "fillet",
                    id: "law",
                    body: body.id,
                    edgeIndexes: [0],
                    radiusLaw: [
                        { position: 0, radius: "1 mm", extra: "ignored" },
                        { position: 1, radius: "2 mm", extra: "ignored" },
                    ],
                },
            ],
        });
        const result = JSON.parse(response as string);
        expect(result.bodies[0].status).toBe("ok");
        expect(body.shape.value.checkShape()).toBe(true);
        expect((body.features[1] as FilletFeatureData).radiusLaw).toEqual([
            { position: 0, radius: "1 mm" },
            { position: 1, radius: "2 mm" },
        ]);
    } finally {
        rs.unstubAllGlobals();
        doc.close();
    }
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

describe("persistent program edge references (real kernel)", () => {
    test.each([
        "fillet",
        "chamfer",
    ] as const)("%s reuses JSON reference after upstream edge reorder", async (op) => {
        const doc = newDoc();
        (doc as any).selection = createMockSelection();
        const created = run(doc, [
            { op: "sketch", id: "stableSketch", entities: rect(0, 0, 40, 30) },
            { op: "extrude", id: "stableBody", sketch: "stableSketch", depth: 20 },
        ]);
        const bodyId = created.created.find((entry) => entry.id === "stableBody")!.nodeId;
        const body = bodyOf(doc, bodyId);
        const app = createMockApplication();
        (app as any).activeView = { document: doc };
        rs.stubGlobal("app", app);
        try {
            const tool = buildParametricTools()[0];
            const response = JSON.parse(
                (await tool.handler({ ops: [{ op: "edges", body: bodyId, id: "picks" }] })) as string,
            );
            const picks = response.results.picks as EdgesReport;
            expect(picks.bodyId).toBe(bodyId);
            expect(picks.edges).toHaveLength(12);
            // Retain the complete response as an external caller would, before rebuilding.
            const portablePicks = JSON.parse(JSON.stringify(picks)) as EdgesReport;
            // Change the source extrusion and cut an upstream hole before applying the saved pick.
            run(doc, [
                {
                    op: "editFeature",
                    body: bodyId,
                    featureId: body.features[0].id,
                    action: "setParameter",
                    key: "depth",
                    value: 25,
                },
                { op: "sketch", id: "hole", entities: [{ type: "circle", params: [20, 15, 3] }] },
                { op: "extrude", id: "cut", body: bodyId, sketch: "hole", depth: 25, operation: "cut" },
            ]);
            const current = run(doc, [{ op: "edges", body: bodyId }]).results["edges"] as EdgesReport;
            const selected = portablePicks.edges.find((row) => {
                const edge = row.reference.edge;
                return (
                    edge.kind === "line" &&
                    edge.start.z === 20 &&
                    edge.end.z === 20 &&
                    current.edges.some(
                        (now) => now.reference.edge.edgeId === edge.edgeId && now.index !== row.index,
                    )
                );
            });
            expect(selected).not.toBeUndefined();
            if (!selected) throw new Error("test requires reordered top edge");
            expect(selected.reference.edge.edgeId).toEqual(expect.any(String));
            const portable = selected.reference;
            const moved = current.edges.find((row) => row.reference.edge.edgeId === portable.edge.edgeId)!;
            expect(moved).not.toBeUndefined();
            expect(moved.index).not.toBe(selected.index);
            expect(moved.reference.edge).not.toEqual(portable.edge);
            const applied = JSON.parse(
                (await tool.handler({
                    ops: [
                        {
                            op,
                            id: "rounded",
                            body: bodyId,
                            edgeRefs: [portable],
                            ...(op === "fillet" ? { radius: 1 } : { distance: 1 }),
                        },
                    ],
                })) as string,
            );
            expect(applied.bodies[0].features).toHaveLength(3);
            expect(body.shape.isOk).toBe(true);
            expect(body.featureItems()[2].error).toBeUndefined();
            const feature = body.features[2];
            expect(feature.type).toBe(op);
            if (feature.type !== "fillet" && feature.type !== "chamfer") throw new Error("wrong feature");
            expect(feature.edges[0].edgeId).toBe(portable.edge.edgeId);
        } finally {
            rs.unstubAllGlobals();
        }
    });

    test("invalid queries and selections fail without changing body features", () => {
        const doc = newDoc();
        const created = run(doc, [
            { op: "sketch", id: "s", entities: rect(0, 0, 40, 30) },
            { op: "extrude", id: "b", sketch: "s", depth: 20 },
        ]);
        const body = bodyOf(doc, created.created[1].nodeId);
        const picks = run(doc, [{ op: "edges", body: "b", edgeIndexes: [0] }]).results[
            "edges"
        ] as EdgesReport;
        const before = body.featuresJson;
        for (const index of [-1, 12, 0.5]) {
            expect(() => run(doc, [{ op: "edges", body: "b", edgeIndexes: [0, index] }])).toThrow(
                /out of range/,
            );
        }
        expect(() =>
            run(doc, [
                {
                    op: "fillet",
                    id: "f",
                    body: "b",
                    radius: 1,
                    edgeRefs: [{ ...picks.edges[0].reference, bodyId: "another" }],
                },
            ]),
        ).toThrow(/different body/);
        expect(() =>
            run(doc, [{ op: "fillet", id: "f", body: "b", radius: 1, edgeRefs: [], edgeIndexes: [0] }]),
        ).toThrow(/exactly one/);
        expect(() => run(doc, [{ op: "fillet", id: "f", body: "b", radius: 1, edgeRefs: [] }])).toThrow(
            /at least one/,
        );
        expect(() =>
            run(doc, [
                {
                    op: "fillet",
                    id: "f",
                    body: "b",
                    radius: 1,
                    edgeRefs: [
                        {
                            bodyId: body.id,
                            edge: { kind: "other", mid: { x: 900, y: 900, z: 900 }, length: 3 },
                        },
                    ],
                },
            ]),
        ).toThrow(/Edge not found/);
        expect(() =>
            run(doc, [
                {
                    op: "chamfer",
                    id: "c",
                    body: "b",
                    distance: 1,
                    edgeRefs: [
                        {
                            bodyId: body.id,
                            edge: {
                                kind: "line",
                                start: { x: 0, y: 15, z: 20 },
                                end: { x: 40, y: 15, z: 20 },
                            },
                        },
                    ],
                },
            ]),
        ).toThrow(/ambiguous/i);
        expect(() =>
            run(doc, [
                {
                    op: "fillet",
                    id: "f",
                    body: "b",
                    radius: 1,
                    edgeRefs: [
                        {
                            bodyId: body.id,
                            edge: {
                                kind: "circle",
                                center: { x: 0, y: 0, z: 0 },
                                axis: { x: 0, y: 0, z: 1 },
                                radius: -1,
                            },
                        },
                    ],
                },
            ]),
        ).toThrow(/invalid persistent edge fingerprint/);
        expect(body.featuresJson).toBe(before);
    });
});

describe("rule-based edge queries (real kernel)", () => {
    function plateWithBore() {
        const doc = newDoc();
        const created = run(doc, [
            { op: "sketch", id: "outline", entities: rect(0, 0, 40, 30) },
            { op: "extrude", id: "plate", sketch: "outline", depth: 20 },
            { op: "sketch", id: "bore", entities: [{ type: "circle", params: [20, 15, 3] }] },
            { op: "extrude", id: "cut", body: "plate", sketch: "bore", depth: 20, operation: "cut" },
        ]);
        const body = bodyOf(doc, created.created.find((node) => node.id === "plate")!.nodeId);
        return { doc, body };
    }
    const query = (doc: TestDocument, op: Omit<Extract<ParametricOp, { op: "edges" }>, "op" | "body">) =>
        run(doc, [{ op: "edges", body: "plate", ...op }]).results["edges"] as EdgesReport;

    test("analytic circle/cylinder radius and elevation yield a usable top bore rim", () => {
        const { doc, body } = plateWithBore();
        expect(query(doc, { selector: { geometry: { kind: "circle", radius: 3 } } }).edges).toHaveLength(2);
        expect(query(doc, { selector: { geometry: { cylinderRadius: 3 } } }).edges).toHaveLength(3);
        const picked = query(doc, {
            selector: { geometry: { kind: "circle", cylinderRadius: 3, elevation: { value: 20 } } },
            expectedCount: 1,
        });
        expect(picked.selection).toMatchObject({ status: "matched", count: 1 });
        expect(picked.edges).toHaveLength(1);
        expect(picked.edges[0].reference.edge).toMatchObject({
            kind: "circle",
            center: { z: 20 },
            radius: 3,
        });
        run(doc, [
            {
                op: "chamfer",
                id: "bevel",
                body: "plate",
                edgeRefs: [JSON.parse(JSON.stringify(picked.edges[0].reference))],
                distance: 0.5,
            },
        ]);
        expect(body.featureItems()[2].error).toBeUndefined();
        expect(body.shape.isOk).toBe(true);
    });

    test("a toroidal surface's circular edge does not qualify as a cylinder", () => {
        const doc = newDoc();
        run(doc, [
            { op: "sketch", id: "tube", entities: [{ type: "circle", params: [10, 0, 3] }] },
            {
                op: "revolve",
                id: "plate",
                sketch: "tube",
                axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
            },
        ]);
        expect(
            query(doc, { selector: { geometry: { kind: "circle", radius: 3 } } }).edges.length,
        ).toBeGreaterThan(0);
        const selected = query(doc, { selector: { geometry: { cylinderRadius: 3 } } });
        expect(selected.edges).toHaveLength(0);
        expect(selected.selection?.status).toBe("empty");
    });

    test("sphere surfaces are excluded and degenerate pole edges are explained", () => {
        const doc = newDoc();
        run(doc, [
            {
                op: "sketch",
                id: "half",
                entities: [
                    { type: "arc", params: [0, 0, 0, -5, 0, 5] },
                    { type: "line", params: [0, 5, 0, -5] },
                ],
            },
            {
                op: "revolve",
                id: "plate",
                sketch: "half",
                axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
            },
        ]);
        const selected = query(doc, { selector: { geometry: { cylinderRadius: 5 } } });
        expect(selected.edges).toHaveLength(0);
        expect(selected.selection?.status).toBe("empty");
        expect(selected.unselectableEdges?.length).toBeGreaterThan(0);
        expect(selected.unselectableEdges?.[0].reason).toMatch(/degenerate/i);
    });

    test("adjoining face sets accept tracked ids, and outlines exclude the hole", () => {
        const { doc, body } = plateWithBore();
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        try {
            const top = faces.findIndex((face) => {
                const box = face.geometryBoundingBox();
                return Math.abs(box.min.z - 20) < 1e-5 && Math.abs(box.max.z - 20) < 1e-5;
            });
            const cylinder = faces.findIndex((face) => {
                const s = face.surface();
                try {
                    return "radius" in s && s.radius === 3;
                } finally {
                    s.dispose();
                }
            });
            expect(top).toBeGreaterThanOrEqual(0);
            expect(cylinder).toBeGreaterThanOrEqual(0);
            expect(query(doc, { selector: { adjoiningFaces: { all: [top] } } }).edges).toHaveLength(5);
            expect(query(doc, { selector: { outlineOfFaces: [top] } }).edges).toHaveLength(4);
            const topId = body.faceIdAt(top)!;
            const cylinderId = body.faceIdAt(cylinder)!;
            expect(topId).toEqual(expect.any(String));
            expect(cylinderId).toEqual(expect.any(String));
            const selected = query(doc, { selector: { adjoiningFaces: { exact: [topId, cylinderId] } } });
            expect(selected.edges).toHaveLength(1);
            expect(selected.edges[0].reference.edge).toMatchObject({ kind: "circle", center: { z: 20 } });
            expect(query(doc, { selector: { adjoiningFaces: { any: [top, cylinder] } } }).edges).toHaveLength(
                7,
            );
        } finally {
            for (const face of faces) face.dispose();
        }
    });

    test("origin and supporting-curve picks retain split boolean ancestry", () => {
        const doc = newDoc();
        const created = run(doc, [
            { op: "sketch", id: "outline", entities: rect(0, 0, 40, 30) },
            { op: "extrude", id: "plate", sketch: "outline", depth: 20 },
        ]);
        const body = bodyOf(doc, created.created[1].nodeId);
        const before = query(doc, {});
        const topFront = before.edges.find(
            ({ reference: { edge } }) =>
                edge.kind === "line" &&
                edge.start.y === 0 &&
                edge.end.y === 0 &&
                edge.start.z === 20 &&
                edge.end.z === 20,
        )!;
        expect(topFront).not.toBeUndefined();
        const origin = body.features[0].id;
        run(doc, [
            { op: "sketch", id: "notch", entities: rect(15, -5, 25, 5) },
            { op: "extrude", id: "notchCut", body: "plate", sketch: "notch", depth: 20, operation: "cut" },
        ]);
        const selected = query(doc, {
            selector: { featureIds: [origin], curves: [topFront.reference] },
            expectedCount: 2,
        });
        expect(selected.selection).toMatchObject({ status: "matched", count: 2 });
        expect(selected.edges).toHaveLength(2);
        for (const row of selected.edges) {
            expect(row.reference.edge.edgeId).toBe(topFront.reference.edge.edgeId);
            expect(row.reference.edge.splitPiece).toBe(true);
        }
        const cutEdges = query(doc, { selector: { featureIds: [body.features[1].id] } });
        expect(cutEdges.edges.length).toBeGreaterThan(0);
        expect(
            cutEdges.edges.every((row) => row.reference.edge.edgeId !== topFront.reference.edge.edgeId),
        ).toBe(true);
    });

    test("empty and ambiguous counts explain candidates without changing the body", () => {
        const { doc, body } = plateWithBore();
        const before = body.featuresJson;
        const empty = query(doc, { selector: { geometry: { radius: 99 } }, expectedCount: 1 });
        expect(empty.edges).toHaveLength(0);
        expect(empty.selection).toMatchObject({ status: "empty", count: 0 });
        expect(empty.selection?.message).toMatch(/No edges match/);
        const ambiguous = query(doc, { selector: { geometry: { radius: 3 } }, expectedCount: 1 });
        expect(ambiguous.edges).toHaveLength(2);
        expect(ambiguous.selection).toMatchObject({ status: "ambiguous", count: 2 });
        expect(ambiguous.selection?.message).toMatch(/refine the selector/);
        expect(body.featuresJson).toBe(before);
    });

    test("malformed predicates and missing curve/face/origin references fail explicitly", () => {
        const { doc, body } = plateWithBore();
        const before = body.featuresJson;
        expect(() => query(doc, { selector: { featureIds: ["missing"] } })).toThrow(/unknown feature origin/);
        expect(() => query(doc, { selector: { outlineOfFaces: [99] } })).toThrow(/out of range/);
        expect(() => query(doc, { selector: { adjoiningFaces: { all: ["missing"] } } })).toThrow(
            /face id.*missing/,
        );
        expect(() => query(doc, { selector: { geometry: { radius: -1 } } })).toThrow(/positive and finite/);
        expect(() => query(doc, { selector: { tolerance: 0 } })).toThrow(/positive finite/);
        expect(() => query(doc, { selector: { geometry: { elevation: { value: NaN } } } })).toThrow(
            /finite value/,
        );
        expect(() => query(doc, { selector: { geometry: {} }, edgeIndexes: [0] })).toThrow(/not both/);
        expect(() =>
            query(doc, {
                selector: {
                    curves: [
                        {
                            bodyId: body.id,
                            edge: { kind: "other", mid: { x: 900, y: 900, z: 900 }, length: 1 },
                        },
                    ],
                },
            }),
        ).toThrow(/curve selection is missing or ambiguous/);
        expect(() => query(doc, { expectedCount: 0 })).toThrow(/positive integer/);
        expect(() => query(doc, { selector: { featureIds: [] } })).toThrow(/non-empty array/);
        expect(() => query(doc, { selector: JSON.parse('{"geometery":{"radius":3}}') })).toThrow(
            /unknown selector field/,
        );
        expect(() => query(doc, { selector: { adjoiningFaces: {} } })).toThrow(/requires all, any or exact/);
        expect(() =>
            query(doc, {
                selector: {
                    curves: [
                        {
                            bodyId: body.id,
                            edge: {
                                kind: "line",
                                start: { x: 0, y: 15, z: 20 },
                                end: { x: 40, y: 15, z: 20 },
                            },
                        },
                    ],
                },
            }),
        ).toThrow(/curve selection is missing or ambiguous/);
        expect(body.featuresJson).toBe(before);
    });
});

test("run_parametric captures a JSON starting-face pick and rebuilds it after an upstream edit", () => {
    const doc = newDoc();
    const body = createdBody(doc, run(doc, plate(20)), "b1");
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const top = faces.findIndex((face) => face.surface().isPlanar() && face.normal(0, 0)[1].z > 0.99);
    expect(top).toBeGreaterThanOrEqual(0);
    const result = run(
        doc,
        JSON.parse(
            JSON.stringify([
                { op: "sketch", id: "boss-sketch", plane: "XY", entities: rect(5, 5, 10, 10) },
                {
                    op: "extrude",
                    id: "boss",
                    sketch: "boss-sketch",
                    depth: 5,
                    startFace: { nodeId: body.id, faceIndex: top },
                },
            ]),
        ),
    );
    const boss = createdBody(doc, result, "boss");
    expectClean(boss);
    expect(boss.features[0]).toMatchObject({ startFace: { nodeId: body.id } });
    expect(extent(boss)).toEqual([5, 5, 20, 10, 10, 25]);
    run(doc, [
        {
            op: "editFeature",
            body: body.id,
            featureId: body.features[0].id,
            action: "setParameter",
            key: "depth",
            value: 30,
        },
    ]);
    expectClean(boss);
    expect(extent(boss)).toEqual([5, 5, 30, 10, 10, 35]);
});

test("run_parametric discovers next candidates across JSON calls and tracks upstream height", () => {
    const doc = newDoc();
    const boundary = createdBody(doc, run(doc, plate(20)), "b1");
    const result = run(
        doc,
        JSON.parse(
            JSON.stringify([
                { op: "sketch", id: "next-profile", plane: "XY", entities: rect(5, 5, 10, 10) },
                { op: "extrude", id: "next-boss", sketch: "next-profile", depth: 1, extent: "next" },
            ]),
        ),
    );
    const boss = createdBody(doc, result, "next-boss");
    expectClean(boss);
    expect(boss.features[0]).toMatchObject({ extent: { type: "next", nodeIds: [boundary.id] } });
    expect(extent(boss)).toEqual([5, 5, 0, 10, 10, 20]);
    run(
        doc,
        JSON.parse(
            JSON.stringify([
                {
                    op: "editFeature",
                    body: boundary.id,
                    featureId: boundary.features[0].id,
                    action: "setParameter",
                    key: "depth",
                    value: 30,
                },
            ]),
        ),
    );
    expectClean(boss);
    expect(extent(boss)).toEqual([5, 5, 0, 10, 10, 30]);
    expect(boss.features[0]).toMatchObject({ extent: { nodeIds: [boundary.id] } });
});

test("run_parametric rejects caller-provided next candidates rather than manual target selection", () => {
    const doc = newDoc();
    const boundary = createdBody(doc, run(doc, plate(20)), "b1");
    const message = runExpectingFailure(
        doc,
        JSON.parse(
            JSON.stringify([
                { op: "sketch", id: "bad-next-profile", plane: "XY", entities: rect(5, 5, 10, 10) },
                {
                    op: "extrude",
                    id: "bad-next",
                    sketch: "bad-next-profile",
                    depth: 1,
                    extent: { type: "next", nodeIds: [boundary.id] },
                },
            ]),
        ),
    );
    expect(message).toContain("automatically");
    expect(doc.modelManager.findNodes((node) => node instanceof ParametricBodyNode)).toHaveLength(1);
});

test.each(["extrude", "boolean"])("%s rejects join before resolving or changing the document", (op) => {
    const doc = newDoc();
    const position = doc.history.position();
    try {
        expect(() => run(doc, [{ op, id: "invalid", operation: "join" } as unknown as ParametricOp])).toThrow(
            /operation must be fuse, cut or common/,
        );
        expect(doc.history.position()).toBe(position);
        expect(doc.modelManager.findNode((node) => node instanceof ParametricBodyNode)).toBeUndefined();
    } finally {
        doc.dispose();
    }
});

// The reported pattern: independent extruded tools consumed by one long boolean chain.
function booleanEditModel(doc: TestDocument) {
    const ops: ParametricOp[] = [
        { op: "sketch", id: "base-sketch", entities: rect(0, 0, 30, 30) },
        { op: "extrude", id: "base", sketch: "base-sketch", depth: 2 },
    ];
    for (let i = 0; i < 14; i++) {
        ops.push(
            { op: "sketch", id: `sketch-${i}`, entities: [{ type: "circle", params: [i + 2, 15, 0.3] }] },
            { op: "extrude", id: `tool-${i}`, sketch: `sketch-${i}`, depth: 2 },
            { op: "boolean", id: `cut-${i}`, body: "base", tools: [`tool-${i}`], operation: "cut" },
        );
    }
    const result = run(doc, ops);
    const bodyId = result.created.find((entry) => entry.id === "base")!.nodeId;
    const body = doc.modelManager.findNode((node) => node.id === bodyId) as ParametricBodyNode;
    const edits: ParametricOp[] = [4, 9, 12].map((i) => ({
        op: "editSketch",
        sketch: `sketch-${i}`,
        actions: [{ action: "move", entities: [1], delta: [0, 2] }],
    }));
    return { body, edits };
}

function bodyReplays(body: ParametricBodyNode) {
    return PerformanceTrace.snapshot().records.filter(
        (record) => record.stage === "body.rebuild" && record.details?.["nodeId"] === body.id,
    );
}

test("consecutive boolean-tool sketch edits rebuild their owner once and reuse its prefix", () => {
    const doc = newDoc();
    try {
        const { body, edits } = booleanEditModel(doc);
        const prefix = body.timelineStateAt(5)?.shape;
        const before = doc.history.undoCount();
        PerformanceTrace.enable();
        const result = run(doc, [...edits, { op: "edges", body: "base", id: "updated-edges" }]);
        const centers = (result.results["updated-edges"] as EdgesReport).edges.flatMap(({ reference }) =>
            reference.edge.kind === "circle" ? [reference.edge.center] : [],
        );
        const changed = centers.filter((center) => [6, 11, 14].some((x) => Math.abs(center.x - x) < 1e-6));
        expect(changed).toHaveLength(6);
        for (const center of changed) expect(center.y).toBeCloseTo(17);
        expect(bodyReplays(body)).toHaveLength(1);
        expect(body.timelineStateAt(5)?.shape).toBe(prefix);
        const misses = PerformanceTrace.snapshot().records.filter(
            (record) =>
                record.stage === "body.feature" &&
                record.details?.["nodeId"] === body.id &&
                !record.details?.["cacheHit"],
        );
        expect(misses.map((record) => record.details?.["index"])).toEqual([
            5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        ]);
        expect(body.featureItems().filter((item) => item.error)).toEqual([]);
        expect(doc.history.undoCount()).toBe(before + 1);
    } finally {
        PerformanceTrace.disable();
        doc.dispose();
    }
});

test("an owner sketch edit queued before its tools' edits still rebuilds the owner once", () => {
    const doc = newDoc();
    try {
        const { body, edits } = booleanEditModel(doc);
        PerformanceTrace.enable();
        run(doc, [
            {
                op: "editSketch",
                sketch: "base-sketch",
                actions: [{ action: "move", entities: [1, 2, 3, 4], delta: [0.5, 0] }],
            },
            ...edits,
        ]);
        expect(bodyReplays(body)).toHaveLength(1);
        expect(body.featureItems().filter((item) => item.error)).toEqual([]);
    } finally {
        PerformanceTrace.disable();
        doc.dispose();
    }
});

test.each([
    false,
    true,
])("background sketch batch yields with atomic completion/cancellation: %s", async (cancel) => {
    const doc = newDoc();
    const app = createMockApplication();
    app.activeView = { document: doc } as never;
    doc.selection = createMockSelection();
    rs.stubGlobal("app", app);
    try {
        const { body, edits } = booleanEditModel(doc);
        const sketches = doc.modelManager.findNodes((node) => node instanceof SketchNode) as SketchNode[];
        const before = sketches.map((sketch) => sketch.dataJson);
        const count = doc.history.undoCount();
        const controller = new AbortController();
        PerformanceTrace.enable();
        const running = runParametric(
            { ops: edits, responseMode: "compact" },
            controller.signal,
            () => {},
            doc,
        );
        // Let module initialization and the first yielded feature reach the event loop.
        await rs.waitFor(() => expect(DocumentRebuilds.pending(doc)).toBe(true), { interval: 1 });
        expect(body.isRebuilding).toBe(true);
        expect(DocumentMutations.isHeld(doc)).toBe(true);
        expect(DocumentRebuilds.status(doc).featureIndexes.length).toBeGreaterThan(0);
        expect(() => doc.history.undo()).toThrow("modeling program is running");
        if (cancel) {
            controller.abort();
            await expect(running).rejects.toThrow("cancelled");
            expect(sketches.map((sketch) => sketch.dataJson)).toEqual(before);
            expect(doc.history.undoCount()).toBe(count);
        } else {
            const result = JSON.parse(await running);
            expect(Object.keys(result.results)).toHaveLength(3);
            expect(bodyReplays(body)).toHaveLength(1);
            expect(doc.history.undoCount()).toBe(count + 1);
            doc.history.undo();
            await DocumentRebuilds.settled(doc);
            expect(sketches.map((sketch) => sketch.dataJson)).toEqual(before);
        }
        expect(body.featureItems().filter((item) => item.error)).toEqual([]);
        expect(DocumentRebuilds.pending(doc)).toBe(false);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    } finally {
        PerformanceTrace.disable();
        rs.unstubAllGlobals();
        doc.dispose();
    }
});

test("a program cancel stops only the rebuilds started under its own mutation scope", async () => {
    const doc = newDoc();
    try {
        const { body } = booleanEditModel(doc);
        // Toggling an early feature invalidates the cached tail, so the rebuild runs as a job.
        let suppressed = false;
        const rebuild = () => {
            suppressed = !suppressed;
            const features = JSON.parse(body.featuresJson);
            features[3].suppressed = suppressed;
            body.featuresJson = JSON.stringify(features);
        };
        rebuild();
        expect(body.isRebuilding).toBe(true);
        const owner = DocumentMutations.hold(doc);
        try {
            body.cancelProgramRebuild(owner);
            expect(body.isRebuilding).toBe(true);
            owner.run(rebuild);
            expect(body.isRebuilding).toBe(true);
            owner.run(() => body.cancelProgramRebuild(owner));
            expect(body.isRebuilding).toBe(false);
        } finally {
            owner.release();
        }
    } finally {
        await DocumentRebuilds.settled(doc);
        doc.dispose();
    }
});

test("deferred rebuilds that keep re-triggering fail the program instead of hanging", () => {
    const doc = newDoc();
    try {
        const { body, edits } = booleanEditModel(doc);
        const node = body as unknown as {
            generateShape(trigger?: string): unknown;
            rebuildFromUpstream(trigger?: string): void;
        };
        const generate = node.generateShape.bind(node);
        const spy = rs.spyOn(node, "generateShape").mockImplementation((trigger?: string) => {
            const result = generate(trigger);
            // Re-queue itself on every drain pass, like two bodies that notify each other forever.
            if (trigger === "batched-upstream") node.rebuildFromUpstream("upstream");
            return result;
        });
        try {
            expect(() => run(doc, edits.slice(0, 1))).toThrow("Rebuilds did not settle");
        } finally {
            spy.mockRestore();
        }
    } finally {
        doc.dispose();
    }
});

test("a background program releases its document hold when the final settle fails", async () => {
    const doc = newDoc();
    const app = createMockApplication();
    app.activeView = { document: doc } as never;
    doc.selection = createMockSelection();
    rs.stubGlobal("app", app);
    const settled = DocumentRebuilds.settled.bind(DocumentRebuilds);
    let finished = false;
    const spy = rs
        .spyOn(DocumentRebuilds, "settled")
        .mockImplementation((document) =>
            finished ? Promise.reject(new Error("settle failed")) : settled(document),
        );
    try {
        const { edits } = booleanEditModel(doc);
        const running = runParametric(
            { ops: edits.slice(0, 1), responseMode: "compact" },
            undefined,
            ({ completed, total }) => {
                finished = completed === total;
            },
            doc,
        );
        await expect(running).rejects.toThrow("settle failed");
        expect(finished).toBe(true);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    } finally {
        spy.mockRestore();
        await DocumentRebuilds.settled(doc);
        rs.unstubAllGlobals();
        doc.dispose();
    }
});

test("MCP parametric jobs return a handle and permit status, metadata and cancellation during rebuild", async () => {
    const doc = newDoc();
    const app = createMockApplication();
    app.activeView = { document: doc } as never;
    doc.selection = createMockSelection();
    rs.stubGlobal("app", app);
    const client = new Client({ name: "parametric-jobs-test", version: "1" });
    const server = createMcpServer({
        tools: [...buildParametricJobTools(), ...buildProgramJobTools(), ...buildReadTools()],
        queue: new SerialQueue(),
    });
    try {
        const { edits } = booleanEditModel(doc);
        const before = doc.history.undoCount();
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const response = await client.callTool({ name, arguments: args });
            const content = response.content as { type: string; text: string }[];
            expect(content[0].type).toBe("text");
            return JSON.parse(content[0].text);
        };
        const started = await call("start_parametric_job", { ops: edits, responseMode: "compact" });
        expect(started.state).toBe("queued");
        expect(started.documentId).toBe(doc.id);
        await rs.waitFor(() => expect(DocumentRebuilds.pending(doc)).toBe(true), { interval: 1 });
        const status = await call("get_parametric_job", { jobId: started.jobId });
        expect(status.state).toBe("running");
        const rebuild = await call("get_rebuild_status");
        expect(rebuild.pending).toBeGreaterThan(0);
        const metadata = await call("get_document_state");
        expect(metadata.hasActiveDocument).toBe(true);
        const cancelled = await call("cancel_parametric_job", { jobId: started.jobId });
        expect(cancelled.state).toBe("cancelling");
        const finished = await waitForTerminalJob(call, "get_parametric_job", started.jobId);
        expect(finished.state).toBe("cancelled");
        expect(doc.history.undoCount()).toBe(before);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
        // A second job proves the cancelled job released the shared queue and owner.
        const second = await call("start_parametric_job", {
            ops: [{ op: "features", body: "base" }],
            responseMode: "compact",
        });
        const completed = await waitForTerminalJob(call, "get_parametric_job", second.jobId);
        expect(completed.state).toBe("completed");
        expect(completed.result.results.features).toHaveLength(15);
        expect(doc.history.undoCount()).toBe(before);
    } finally {
        await client.close();
        await DocumentRebuilds.settled(doc);
        rs.unstubAllGlobals();
        doc.dispose();
    }
});

test("a failed sketch batch discards its deferred work and restores previous edits", async () => {
    const doc = newDoc();
    try {
        const { body, edits } = booleanEditModel(doc);
        const nodes = doc.modelManager.findNodes((node) => node instanceof SketchNode) as SketchNode[];
        const before = nodes.map((node) => node.dataJson);
        const count = doc.history.undoCount();
        expect(() =>
            run(doc, [
                edits[0],
                {
                    op: "editSketch",
                    sketch: "missing",
                    actions: [{ action: "move", entities: [1], delta: [0, 2] }],
                },
            ]),
        ).toThrow('op 1 ("editSketch") failed');
        await DocumentRebuilds.settled(doc);
        expect(nodes.map((node) => node.dataJson)).toEqual(before);
        expect(doc.history.undoCount()).toBe(count);
        expect(body.featureItems().filter((item) => item.error)).toEqual([]);
        expect(DocumentRebuilds.pending(doc)).toBe(false);
    } finally {
        doc.dispose();
    }
});

test("a geometry query between sketch edits observes that position in the program", () => {
    const doc = newDoc();
    try {
        const { body, edits } = booleanEditModel(doc);
        PerformanceTrace.enable();
        const result = run(doc, [edits[0], { op: "edges", body: "base", id: "between" }, edits[1]]);
        expect(bodyReplays(body)).toHaveLength(2);
        const centers = (result.results["between"] as EdgesReport).edges.flatMap(({ reference }) =>
            reference.edge.kind === "circle" ? [reference.edge.center] : [],
        );
        const first = centers.filter((center) => Math.abs(center.x - 6) < 1e-6);
        const second = centers.filter((center) => Math.abs(center.x - 11) < 1e-6);
        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        for (const center of first) expect(center.y).toBeCloseTo(17);
        for (const center of second) expect(center.y).toBeCloseTo(15);
    } finally {
        PerformanceTrace.disable();
        doc.dispose();
    }
});
