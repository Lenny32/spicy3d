// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Issue #164: a body lofted through sketches on construction planes rebuilt (and every section
 * dropped its profile cache) whenever any node entered the tree — each new, unrelated sketch.
 * The model is the report's: control-point B-spline sections with an associative offset on
 * YZ-offset planes, a solid loft and extrudes fused into and cut from it afterwards.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentRebuilds, Transaction } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { runParametric } from "../../../ai/src/tools/parametricTools";
import { featureHandler } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram } from "../../src/program/parametricProgram";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

const previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (previousFactory) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});
afterEach(() => {
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

const SECTIONS = 4;
const POLES = 12;
// Each case builds (and the reload cases rebuild) the lofted model; the default 5 s is tight in a full run.
const TIMEOUT = 60_000;
const WALL = [{ id: "wall", name: "wall_t", type: "length", expression: "1" }] as const;

function newDocument(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.selection = createMockSelection();
    doc.variables.setItems(WALL.map((item) => ({ ...item })));
    return doc;
}

function run(doc: TestDocument, ops: ParametricOp[]) {
    let result: ReturnType<typeof runParametricProgram> | undefined;
    Transaction.execute(doc, "test program", () => {
        result = runParametricProgram(doc, ops);
    });
    return result!;
}

/** A wall section as in the report: a control-point B-spline, its associative offset and two caps. */
function section(index: number): ParametricOp[] {
    const poles = Array.from({ length: POLES }, (_, i) => [i * 3, Math.sin(i / 3 + index) * 2 + 5]);
    const end = (POLES - 1) * 3;
    return [
        {
            op: "construct",
            id: `plane${index}`,
            definition: { kind: "plane-offset", source: "YZ", distance: index * 10 },
        },
        {
            op: "sketch",
            id: `section${index}`,
            plane: { construction: `plane${index}` },
            entities: [{ type: "bspline", poles, name: "outer" }],
            constraints: [{ kind: "Block", entities: ["outer"] }],
            actions: [
                { action: "offset", entity: "outer", distance: "wall_t", associative: true, name: "inner" },
                {
                    action: "add",
                    entities: [
                        { type: "line", params: [0, 0, 0, 1], name: "startCap" },
                        { type: "line", params: [end, 0, end, 1], name: "endCap" },
                    ],
                    constraints: [
                        ["outer", 0, "startCap", 0],
                        ["inner", 0, "startCap", -1],
                        ["outer", -1, "endCap", 0],
                        ["inner", -1, "endCap", -1],
                    ].map(([first, firstPoint, second, secondPoint]) => ({
                        kind: "Coincident",
                        points: [
                            { entity: first, point: firstPoint },
                            { entity: second, point: secondPoint },
                        ],
                    })),
                },
            ],
        },
    ] as ParametricOp[];
}

/** The lofted wall with a boss fused into it and a hole cut from it, as the report's later features. */
function loftedDocument(): { doc: TestDocument; bodyId: string } {
    const doc = newDocument();
    run(doc, Array.from({ length: SECTIONS }, (_, index) => section(index)).flat());
    const created = run(doc, [
        {
            op: "loft",
            id: "wall",
            name: "Mouse side",
            sections: Array.from({ length: SECTIONS }, (_, index) => `section${index}`),
        },
    ] as ParametricOp[]);
    const bodyId = created.created[0].nodeId;
    run(doc, [
        { op: "sketch", id: "boss", plane: "XY", entities: [{ type: "circle", params: [5, 5, 2] }] },
        { op: "extrude", id: "bossExtrude", sketch: "boss", depth: 20, body: bodyId, operation: "fuse" },
        { op: "sketch", id: "hole", plane: "XY", entities: [{ type: "circle", params: [15, 5, 1] }] },
        { op: "extrude", id: "holeExtrude", sketch: "hole", depth: 20, body: bodyId, operation: "cut" },
    ] as ParametricOp[]);
    return { doc, bodyId };
}

/** The same model after a save and a reload: every shape is resolved again from the stored data. */
async function reloaded(): Promise<{ doc: TestDocument; bodyId: string }> {
    const { doc, bodyId } = loftedDocument();
    const saved = doc.modelManager.serialize();
    const fresh = newDocument();
    await fresh.modelManager.deserialize(saved);
    return { doc: fresh, bodyId };
}

async function settledModel(document: { doc: TestDocument; bodyId: string }) {
    const { doc, bodyId } = document;
    const body = doc.modelManager.findNode((node) => node.id === bodyId);
    expect(body).toBeInstanceOf(ParametricBodyNode);
    const lofted = body as ParametricBodyNode;
    expect(lofted.shape.isOk).toBe(true);
    await DocumentRebuilds.settled(doc);
    expect(lofted.features.map((feature) => feature.type)).toEqual(["loft", "extrude", "extrude"]);
    expect(lofted.featureItems().filter((item) => item.error)).toEqual([]);
    expect(lofted.shape.value.volume()).toBeGreaterThan(0);
    const sections = doc.modelManager.findNodes(
        (node): node is SketchNode => node instanceof SketchNode && node.constructionPlaneRef !== undefined,
    ) as SketchNode[];
    expect(sections).toHaveLength(SECTIONS);
    return { doc, body: lofted, sections };
}

const NEW_SKETCH: ParametricOp[] = [
    {
        op: "sketch",
        id: "test",
        name: "TEST",
        plane: "XY",
        entities: [{ type: "circle", params: [0, 0, 1] }],
    },
];
const NEW_PLANE: ParametricOp[] = [
    { op: "construct", id: "other", definition: { kind: "plane-offset", source: "XY", distance: 7 } },
];

/** `run_parametric` as an MCP call runs it: the background-job path, awaiting rebuilds between ops. */
async function runAsJob(doc: TestDocument, ops: ParametricOp[]): Promise<void> {
    const app = createMockApplication();
    app.activeView = { document: doc } as never;
    rs.stubGlobal("app", app);
    await runParametric({ ops }, undefined, () => {}, doc);
}

test.each<[string, () => Promise<{ doc: TestDocument; bodyId: string }>, ParametricOp[], "program" | "job"]>([
    ["sketch", async () => loftedDocument(), NEW_SKETCH, "program"],
    ["construction plane", async () => loftedDocument(), NEW_PLANE, "program"],
    ["sketch run as a job", async () => loftedDocument(), NEW_SKETCH, "job"],
    ["sketch in a reloaded document", reloaded, NEW_SKETCH, "program"],
    ["sketch run as a job in a reloaded document", reloaded, NEW_SKETCH, "job"],
])(
    "an unrelated %s neither rebuilds the loft nor re-derives its sections",
    async (_, build, ops, path) => {
        const { doc, body, sections } = await settledModel(await build());
        const revisions = sections.map((sketch) => sketch.geometryRevision);
        const data = sections.map((sketch) => sketch.dataJson);
        const shape = body.shape.value;
        const loft = rs.spyOn(featureHandler("loft")!, "evaluate");
        const extrude = rs.spyOn(featureHandler("extrude")!, "evaluate");
        // A section re-solving would regenerate its associative offset — the cost the report blamed.
        const solves = sections.map((sketch) => rs.spyOn(sketch, "createSolver"));
        const changed = rs.fn((property: string) => property);
        body.onPropertyChanged(changed);
        for (const sketch of sections) sketch.onPropertyChanged(changed);

        if (path === "job") await runAsJob(doc, ops);
        else run(doc, ops);
        await DocumentRebuilds.settled(doc);

        expect(loft).not.toHaveBeenCalled();
        expect(extrude).not.toHaveBeenCalled();
        for (const solve of solves) expect(solve).not.toHaveBeenCalled();
        expect(changed.mock.calls.map(([property]) => property)).toEqual([]);
        expect(sections.map((sketch) => sketch.geometryRevision)).toEqual(revisions);
        expect(sections.map((sketch) => sketch.dataJson)).toEqual(data);
        expect(body.shape.value).toBe(shape);
    },
    TIMEOUT,
);

test(
    "a feature appended after the loft reuses the cached loft",
    async () => {
        const { doc, body } = await settledModel(loftedDocument());
        const loft = rs.spyOn(featureHandler("loft")!, "evaluate");
        const extrude = rs.spyOn(featureHandler("extrude")!, "evaluate");

        await runAsJob(doc, [
            { op: "sketch", id: "boss2", plane: "XY", entities: [{ type: "circle", params: [25, 5, 2] }] },
            {
                op: "extrude",
                id: "boss2Extrude",
                sketch: "boss2",
                depth: 20,
                body: body.id,
                operation: "fuse",
            },
        ] as ParametricOp[]);
        await DocumentRebuilds.settled(doc);

        expect(body.featureItems().filter((item) => item.error)).toEqual([]);
        expect(body.features).toHaveLength(4);
        expect(loft).not.toHaveBeenCalled();
        // Only the new step runs; the two earlier extrudes come from the cache like the loft.
        expect(extrude).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
);
