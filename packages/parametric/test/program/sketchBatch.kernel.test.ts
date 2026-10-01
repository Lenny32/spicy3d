// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { rs } from "@rstest/core";
import { DocumentMutations, DocumentRebuilds, Precision, Result, Transaction } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { runParametric } from "../../../ai/src/tools/parametricTools";
import { hasDocumentReadSnapshot } from "../../../ai/src/tools/readTools";
import { registerFeature } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram, runParametricProgramAsync } from "../../src/program";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/spicy-wasm.wasm") });
});

let document: TestDocument;
let calls: number[];
let fail: boolean;
let model: ParametricBodyNode;
let sketches: SketchNode[];

beforeEach(() => {
    rs.stubGlobal("shapeFactory", new ShapeFactory());
    document = new TestDocument({ application: createMockApplication(), selection: createMockSelection() });
    calls = [];
    fail = false;
    runParametricProgram(document, [
        { op: "sketch", id: "a", entities: [{ type: "line", params: [0, 0, 10, 0] }] },
        { op: "sketch", id: "b", entities: [{ type: "line", params: [0, 1, 10, 1] }] },
    ]);
    sketches = document.modelManager.findNodes((node) => node instanceof SketchNode) as SketchNode[];
    registerFeature("test-sketch-batch", {
        display: "body.parametricBody",
        nodeIds: (feature: { refs: string[] }) => feature.refs,
        parameters: () => [],
        setParameter: (feature) => feature,
        evaluate: (feature: { index: number }) => {
            calls.push(feature.index);
            if (fail && feature.index === 63) return Result.err("batch failure");
            return Result.ok(new MockShape());
        },
    });
    model = new ParametricBodyNode({
        document,
        featuresJson: JSON.stringify(
            Array.from({ length: 65 }, (_, index) => ({
                id: `f${index}`,
                type: "test-sketch-batch",
                index,
                refs: index === 60 ? sketches.map((sketch) => sketch.id) : [],
            })),
        ),
    });
    document.modelManager.addNode(model);
    ParametricBodyNode.withSynchronousEvaluation(document, () => void model.shape);
    calls = [];
});

afterEach(async () => {
    document.dispose();
    await DocumentRebuilds.settled(document);
    rs.unstubAllGlobals();
});

const move = (sketch: SketchNode, x: number): ParametricOp => ({
    op: "editSketch",
    sketch: sketch.id,
    actions: [{ action: "move", entities: [sketch.data.entities[0].id], delta: [x, 0] }],
});

async function run(ops: ParametricOp[], signal?: AbortSignal) {
    const owner = DocumentMutations.hold(document);
    try {
        await Transaction.executeAsync(
            document,
            "batch test",
            async () => {
                await runParametricProgramAsync(document, ops, { signal }, owner);
            },
            owner,
        );
    } finally {
        await DocumentRebuilds.settled(document);
        owner.release();
    }
}

test("several edits replay one suffix, yield for status reads, and form one undo step", async () => {
    const history = document.history.undoCount();
    const original = sketches.map((sketch) => sketch.dataJson);
    const prefix = model.timelineStateAt(60)?.shape;
    const running = run([move(sketches[0], 1), move(sketches[1], 2), move(sketches[0], 3)]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(DocumentRebuilds.status(document).pending).toBe(1);
    expect(calls.length).toBeLessThan(5);
    expect(() => {
        document.history.undo();
    }).toThrow(/modeling program/);
    await running;
    expect(calls).toEqual([60, 61, 62, 63, 64]);
    expect(model.timelineStateAt(60)?.shape).toBe(prefix);
    expect(sketches.map((sketch) => sketch.data.entities[0].params[0])).toEqual([4, 2]);
    expect(document.history.undoCount()).toBe(history + 1);
    document.history.undo();
    await DocumentRebuilds.settled(document);
    expect(sketches.map((sketch) => sketch.dataJson)).toEqual(original);
    document.history.redo();
    await DocumentRebuilds.settled(document);
    expect(sketches.map((sketch) => sketch.data.entities[0].params[0])).toEqual([4, 2]);
});

test("a geometry read splits edit batches and sees the preceding edit", async () => {
    await run([move(sketches[0], 1), { op: "features", body: model.id }, move(sketches[0], 2)]);
    expect(calls).toEqual([60, 61, 62, 63, 64, 60, 61, 62, 63, 64]);
});

test("a constraint that preserves solved geometry keeps shapes and skips downstream replay", async () => {
    const original = sketches[0].shape.value;
    const result = model.shape.value;
    await run([
        {
            op: "editSketch",
            sketch: sketches[0].id,
            actions: [
                {
                    action: "add",
                    constraints: [{ kind: "Horizontal", entities: [sketches[0].data.entities[0].id] }],
                },
            ],
        },
    ]);
    expect(sketches[0].data.constraints).toHaveLength(1);
    expect(sketches[0].shape.value).toBe(original);
    expect(model.shape.value).toBe(result);
    expect(calls).toEqual([]);
});

test.each(["failure", "cancel"])("%s during rebuild rolls back every sketch edit", async (kind) => {
    const original = sketches.map((sketch) => sketch.dataJson);
    const history = document.history.undoCount();
    const controller = new AbortController();
    fail = kind === "failure";
    const running = run([move(sketches[0], 1), move(sketches[1], 2)], controller.signal);
    if (kind === "cancel") controller.abort();
    await expect(running).rejects.toThrow(kind === "failure" ? /batch failure/ : /cancelled/);
    fail = false;
    await DocumentRebuilds.settled(document);
    expect(sketches.map((sketch) => sketch.dataJson)).toEqual(original);
    expect(document.history.undoCount()).toBe(history);
    expect(DocumentMutations.isHeld(document)).toBe(false);
});

test("sub-tolerance edits are compared to the built geometry rather than accumulating drift", async () => {
    const sketch = sketches[0];
    const original = sketch.shape.value;
    const first = sketch.data;
    first.entities[0].params[0] = Precision.Distance * 0.75;
    sketch.setDataEmitShapeChanged(first);
    expect(sketch.shape.value).toBe(original);
    const second = sketch.data;
    second.entities[0].params[0] = Precision.Distance * 1.5;
    sketch.setDataEmitShapeChanged(second);
    await DocumentRebuilds.settled(document);
    expect(sketch.shape.value).not.toBe(original);
    expect(calls).toEqual([60, 61, 62, 63, 64]);
});

test("a parametric job holds reads and mutation ownership until its batched rebuild completes", async () => {
    const app = document.application;
    app.activeView = createMockView({ document });
    rs.stubGlobal("app", app);
    const running = runParametric({ ops: [move(sketches[0], 1), move(sketches[1], 2)] }, undefined, undefined, document);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(DocumentMutations.isHeld(document)).toBe(true);
    expect(hasDocumentReadSnapshot()).toBe(true);
    await running;
    expect(calls).toEqual([60, 61, 62, 63, 64]);
    expect(DocumentMutations.isHeld(document)).toBe(false);
    expect(hasDocumentReadSnapshot()).toBe(false);
});
