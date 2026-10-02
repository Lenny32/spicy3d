// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DocumentRebuilds,
    I18n,
    type IAsyncShapeOperation,
    type IShape,
    mergeDocuments,
    Result,
    ShapeTypes,
    Transaction,
    validateMerge,
} from "@spicy3d/core";
import { createMockApplication, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { Document } from "../../app/src/document";
import { HeadlessDocumentEvaluator } from "../../app/src/mergeEvaluator";
import { FeatureChainPreview } from "../src/commands/featureEditPreview";
import { featureHandler, registerFeature, type SweepFeatureData } from "../src/features/feature";
import {
    prepareValidatedFeature,
    SELF_INTERSECTION_SKIPPED,
    validateSelfIntersection,
} from "../src/features/selfIntersectionValidation";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { runParametricProgram } from "../src/program/parametricProgram";

const original = featureHandler("sweep");
if (!original) throw new Error("Sweep handler not registered");
const feature: SweepFeatureData = {
    id: "sweep",
    type: "sweep",
    section: { sketchId: "sketch" },
    path: { nodeId: "path", edges: [] },
};
let document: TestDocument;
let outputs: Array<IShape & { dispose: ReturnType<typeof rs.fn> }>;
let queries: Array<{
    shape: IShape;
    cancel: ReturnType<typeof rs.fn>;
    complete(result: Result<boolean>): void;
}>;
let answer: Result<boolean> | undefined;
let faceCount: number;

beforeEach(() => {
    rs.useFakeTimers();
    document = new TestDocument({ application: createMockApplication() });
    outputs = [];
    queries = [];
    answer = undefined;
    faceCount = 300;
    rs.stubGlobal("shapeFactory", {
        combine: () => Result.ok(new MockShape()),
        boundedOperations: {
            shapeQuery: ({ shape }: { shape: IShape }): IAsyncShapeOperation<boolean> => {
                let resolve = () => {};
                let reply: Result<boolean> | undefined;
                let cancelled = false;
                const ready = new Promise<void>((done) => {
                    resolve = done;
                });
                const complete = (result: Result<boolean>) => {
                    reply = result;
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(
                    () =>
                        complete(
                            Result.err("Self-intersection check timed out after 30000 ms (result unknown)"),
                        ),
                    30_000,
                );
                const cancel = rs.fn(() => {
                    cancelled = true;
                    clearTimeout(timer);
                    resolve();
                });
                queries.push({ shape, cancel, complete });
                if (answer) complete(answer);
                return {
                    ready,
                    canFallback: false,
                    cancel,
                    get cancelled() {
                        return cancelled;
                    },
                    take: () => reply ?? Result.err("Worker result unavailable"),
                };
            },
        },
    });
    registerFeature("sweep", {
        display: "body.sweep",
        nodeIds: () => [],
        parameters: () => [],
        setParameter: (f: SweepFeatureData) => f,
        evaluate: (_f, context) => {
            const output = Object.assign(new MockShape(), {
                checkShape: () => true,
                volume: () => 1,
                checkSelfIntersection: rs.fn(() => {
                    throw new Error("main-thread analyzer called");
                }),
                findSubShapes: (type: number) =>
                    Array.from({ length: type === ShapeTypes.face ? faceCount : 1 }, () => new MockShape()),
                dispose: rs.fn(() => {}),
            });
            outputs.push(output);
            const valid = validateSelfIntersection(output, context.warn, context.deferSelfIntersection);
            return valid.isOk && valid.value ? Result.ok(output) : Result.err("invalid");
        },
    });
});

afterEach(() => {
    document.dispose();
    registerFeature("sweep", original);
    rs.unstubAllGlobals();
    rs.useRealTimers();
});

function body(features = [feature]): ParametricBodyNode {
    const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features) });
    document.modelManager.addNode(node);
    void node.shape;
    return node;
}

async function start(): Promise<void> {
    await rs.advanceTimersByTimeAsync(10);
}

const timeoutError = "Self-intersection check timed out after 30000 ms (result unknown)";
const timeoutWarning = I18n.translate("warning.selfIntersection.timeout{0}", 30_000);

test("timeout accepts geometry, evaluates later steps and caches the warning until inputs change", async () => {
    const node = body([feature, { ...feature, id: "later" }]);
    await start();
    expect(queries).toHaveLength(1);
    DocumentRebuilds.flush(document);
    expect(DocumentRebuilds.pending(document)).toBe(true);
    await rs.advanceTimersByTimeAsync(30_001);
    expect(queries).toHaveLength(2);
    queries[1].complete(Result.ok(true));
    await start();
    await DocumentRebuilds.settled(document);
    expect(node.shape.isOk).toBe(true);
    expect(node.shape.value).toBe(outputs[1]);
    expect(node.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(node.featureItems()[0].warning).toBe(timeoutWarning);
    expect(outputs[0].dispose).toHaveBeenCalledTimes(0);
    const report = runParametricProgram(document, [{ op: "features", body: node.id }]);
    expect(report.results["features"]).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "sweep", warning: timeoutWarning })]),
    );
    node.applyVariables();
    await start();
    await DocumentRebuilds.settled(document);
    expect(queries).toHaveLength(2);
    expect(node.featureItems()[0].warning).toBe(timeoutWarning);
    answer = Result.ok(true);
    node.featuresJson = JSON.stringify([
        { ...feature, roundCorner: true },
        { ...feature, id: "later" },
    ]);
    await start();
    await DocumentRebuilds.settled(document);
    expect(queries).toHaveLength(4);
    expect(node.featureItems()[0].warning).toBeUndefined();
});

test.each([
    "Geometry worker native runtime failed",
    "Worker result unavailable",
])("worker unknown verdict %s accepts geometry with a warning", async (error) => {
    answer = Result.err(error);
    const node = body();
    await start();
    await DocumentRebuilds.settled(document);
    expect(node.shape.isOk).toBe(true);
    expect(node.featureItems()[0].error).toBeUndefined();
    expect(node.featureItems()[0].warning).toBe(I18n.translate("warning.selfIntersection.unknown"));
    node.applyVariables();
    await start();
    await DocumentRebuilds.settled(document);
    expect(queries).toHaveLength(1);
});

test("newer rebuild cancels pending check and cannot commit its old answer", async () => {
    const node = body();
    await start();
    node.featuresJson = JSON.stringify([{ ...feature, roundCorner: true }]);
    expect(queries[0].cancel).toHaveBeenCalled();
    expect(outputs[0].dispose).toHaveBeenCalledTimes(1);
    await start();
    expect(queries).toHaveLength(2);
    queries[0].complete(Result.ok(false));
    queries[1].complete(Result.ok(true));
    await start();
    await DocumentRebuilds.settled(document);
    expect(node.shape.isOk).toBe(true);
    expect(node.shape.value).toBe(outputs[1]);
    expect(node.featureItems()[0].error).toBeUndefined();
    answer = Result.ok(true);
    node.featuresJson = JSON.stringify([feature]);
    await start();
    await DocumentRebuilds.settled(document);
    expect(queries).toHaveLength(3);
});

test.each([true, false])("worker result %s gates acceptance without main-thread checks", async (clean) => {
    answer = Result.ok(clean);
    const node = body();
    await start();
    await DocumentRebuilds.settled(document);
    expect(queries).toHaveLength(1);
    expect(node.shape.isOk).toBe(clean);
    expect(node.featureItems()[0].error).toEqual(clean ? undefined : "Shape intersects itself");
});

test("synchronous preview never runs analyzer and exposes its warning", async () => {
    answer = Result.ok(true);
    const node = body();
    await start();
    const preview = new FeatureChainPreview(node, 0).evaluate(feature, false);
    expect(preview.error).toBeUndefined();
    expect(preview.warning).toBe(SELF_INTERSECTION_SKIPPED);
    expect(queries).toHaveLength(1);
    expect(preview.shape).toBe(outputs[1]);
    preview.shape?.dispose();
});

test("headless document open and merge evaluation await bounded validation", async () => {
    const source = new Document(createMockApplication(), "validation");
    try {
        source.modelManager.addNode(
            new ParametricBodyNode({ document: source, featuresJson: JSON.stringify([feature]) }),
        );
        const stored = source.serialize();
        source.dispose();
        queries = [];
        const loaded = await Document.loadHeadless(createMockApplication(), stored);
        expect(loaded.isOk).toBe(true);
        if (!loaded.isOk) throw new Error("load failed");
        const reopened = loaded.value.modelManager.findNode((node) => node instanceof ParametricBodyNode);
        expect(reopened).toBeInstanceOf(ParametricBodyNode);
        void (reopened as ParametricBodyNode).shape;
        await start();
        expect(queries).toHaveLength(1);
        queries[0].complete(Result.err(timeoutError));
        await start();
        await DocumentRebuilds.settled(loaded.value);
        expect((reopened as ParametricBodyNode).shape.isOk).toBe(true);
        expect((reopened as ParametricBodyNode).featureItems()[0].warning).toBe(timeoutWarning);
        expect(JSON.stringify(loaded.value.serialize())).toBe(JSON.stringify(stored));
        loaded.value.dispose();
        const evaluation = new HeadlessDocumentEvaluator(createMockApplication()).evaluate(stored);
        await start();
        expect(queries).toHaveLength(2);
        queries[1].complete(Result.err("Self-intersection check timed out after 30000 ms (result unknown)"));
        await start();
        const report = await evaluation;
        expect(report.isOk).toBe(true);
        if (!report.isOk) throw new Error("report failed");
        expect([...report.value]).toEqual([]);
        answer = Result.err(timeoutError);
        const merge = mergeDocuments(stored, stored, stored);
        expect(merge.isOk).toBe(true);
        const validating = validateMerge(merge.value, {
            evaluator: new HeadlessDocumentEvaluator(createMockApplication()),
        });
        await rs.runAllTimersAsync();
        const validated = await validating;
        expect(validated.isOk).toBe(true);
        expect(validated.value.conflicts).toEqual([]);
    } finally {
        source.dispose();
    }
});

test("undo and redo cancel pending validation and validate replayed features", async () => {
    answer = Result.ok(true);
    const node = body();
    await start();
    answer = undefined;
    Transaction.execute(document, "edit", () => {
        node.featuresJson = JSON.stringify([{ ...feature, roundCorner: true }]);
    });
    await start();
    expect(queries).toHaveLength(2);
    document.history.undo();
    expect(queries[1].cancel).toHaveBeenCalled();
    await start();
    answer = Result.ok(true);
    document.history.redo();
    await start();
    await DocumentRebuilds.settled(document);
    expect(node.features[0]).toEqual({ ...feature, roundCorner: true });
    expect(node.shape.isOk).toBe(true);
    expect(node.featureItems()[0].error).toBeUndefined();
});

test.each([
    1, 12,
])("synchronous-only factory accepts %s features with skip warnings in every rebuild mode", async (count) => {
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(new MockShape()) });
    const node = body(Array.from({ length: count }, (_, index) => ({ ...feature, id: `sweep-${index}` })));
    await rs.runAllTimersAsync();
    await DocumentRebuilds.settled(document);
    expect(node.shape.isOk).toBe(true);
    expect(node.featureItems()[0].error).toBeUndefined();
    expect(node.featureItems().map((item) => item.warning)).toEqual(
        Array(count).fill(SELF_INTERSECTION_SKIPPED),
    );
    expect(outputs).toHaveLength(count);
    expect(outputs[0].dispose).toHaveBeenCalledTimes(0);
    expect(queries).toHaveLength(0);
    node.applyVariables();
    await rs.runAllTimersAsync();
    await DocumentRebuilds.settled(document);
    expect(outputs).toHaveLength(count);
    expect(node.shape.isOk).toBe(true);
});

test("headless evaluation cancellation terminates pending validation", async () => {
    const source = new Document(createMockApplication(), "cancel");
    source.modelManager.addNode(
        new ParametricBodyNode({ document: source, featuresJson: JSON.stringify([feature]) }),
    );
    const stored = source.serialize();
    source.dispose();
    queries = [];
    const abort = new AbortController();
    const evaluation = new HeadlessDocumentEvaluator(createMockApplication()).evaluate(stored, {
        signal: abort.signal,
    });
    await start();
    expect(queries).toHaveLength(1);
    abort.abort();
    await start();
    const report = await evaluation;
    expect(report.isOk).toBe(false);
    expect(report.error).toEqual({ kind: "cancelled" });
    expect(queries[0].cancel).toHaveBeenCalled();
});

test.each([
    0, 1,
])("temporary tool and boolean output retain failure context (failed check %s)", async (failed) => {
    const tool = Object.assign(new MockShape(), { dispose: rs.fn(() => {}) });
    const output = Object.assign(new MockShape(), { dispose: rs.fn(() => {}) });
    const host = new ParametricBodyNode({ document, featuresJson: "[]" });
    try {
        const pending = prepareValidatedFeature(
            (context) => {
                const defer = context.deferSelfIntersection;
                if (!defer) throw new Error("Missing deferred validation");
                defer(tool, "Face sweep tool intersects itself");
                tool.dispose();
                defer(output, "Face sweep result intersects itself");
                return Result.ok(output);
            },
            { document, host, scope: new Map() },
        );
        expect(queries.map((query) => query.shape)).toEqual([tool, output]);
        expect(tool.dispose).toHaveBeenCalledTimes(1);
        queries[0].complete(Result.ok(failed !== 0));
        queries[1].complete(Result.ok(failed !== 1));
        await pending.ready;
        expect(pending.take().error).toBe(
            failed === 0 ? "Face sweep tool intersects itself" : "Face sweep result intersects itself",
        );
        expect(output.dispose).toHaveBeenCalledTimes(1);
        pending.cancel();
        expect(output.dispose).toHaveBeenCalledTimes(1);
    } finally {
        host.dispose();
    }
});

test("failed handler cancels already captured checks immediately", async () => {
    const host = new ParametricBodyNode({ document, featuresJson: "[]" });
    try {
        const pending = prepareValidatedFeature(
            (context) => {
                const defer = context.deferSelfIntersection;
                if (!defer) throw new Error("Missing deferred validation");
                defer(new MockShape());
                return Result.err("boolean failed");
            },
            { document, host, scope: new Map() },
        );
        await pending.ready;
        expect(queries[0].cancel).toHaveBeenCalled();
        expect(pending.take().error).toBe("boolean failed");
        pending.cancel();
    } finally {
        host.dispose();
    }
});

test("direct preparation without bounded support retains cheap gates and the skip warning", async () => {
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(new MockShape()) });
    const host = new ParametricBodyNode({ document, featuresJson: "[]" });
    const warn = rs.fn((_message: string) => {});
    try {
        const pending = prepareValidatedFeature(
            (context) => featureHandler("sweep")!.evaluate(feature, context),
            { document, host, scope: new Map(), warn },
        );
        await pending.ready;
        const accepted = pending.take();
        expect(accepted.isOk).toBe(true);
        expect(accepted.value).toBe(outputs[0]);
        expect(warn.mock.calls).toEqual([[SELF_INTERSECTION_SKIPPED]]);
        accepted.value.dispose();
        expect(queries).toHaveLength(0);
    } finally {
        host.dispose();
    }
});

test("explicitly cancelled check discards geometry even with an unavailable-result message", async () => {
    let cancelled = false;
    rs.stubGlobal("shapeFactory", {
        boundedOperations: {
            shapeQuery: () => ({
                ready: Promise.resolve(),
                canFallback: false,
                get cancelled() {
                    return cancelled;
                },
                cancel: () => {
                    cancelled = true;
                },
                take: () => Result.err("Worker result unavailable"),
            }),
        },
    });
    const host = new ParametricBodyNode({ document, featuresJson: "[]" });
    const output = Object.assign(new MockShape(), { dispose: rs.fn(() => {}) });
    const warn = rs.fn((_message: string) => {});
    try {
        const pending = prepareValidatedFeature(
            (context) => {
                const defer = context.deferSelfIntersection;
                if (!defer) throw new Error("Missing deferred validation");
                defer(output);
                return Result.ok(output);
            },
            { document, host, scope: new Map(), warn },
        );
        cancelled = true;
        await pending.ready;
        expect(pending.take().isOk).toBe(false);
        expect(output.dispose).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(0);
    } finally {
        host.dispose();
    }
});
