// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AutosaveHolds,
    DocumentRebuilds,
    EditableShapeNode,
    type IDocument,
    type INode,
    type IShape,
    Matrix4,
    NodeUtils,
    PerformanceTrace,
    PubSub,
    Result,
    Transaction,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    MemoryDocumentRepository,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { MeshLambertMaterial, Scene } from "three";
import { Document } from "../../app/src/document";
import { ThreeGeometry } from "../../three/src/threeGeometry";
import { ThreeVisualContext } from "../../three/src/threeVisualContext";
import { type FeatureContext, registerFeature } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";

interface Step {
    id: string;
    type: string;
    revision?: number;
    variable?: string;
    refs?: string[];
    fail?: boolean;
    suppressed?: boolean;
}
type OwnedShape = IShape & { label: string; disposed: boolean; dispose: ReturnType<typeof rs.fn> };

let shapes: OwnedShape[];
let calls: Array<{ id: string; revision?: number; input?: IShape }>;
let document: IDocument;

function shape(label: string): OwnedShape {
    const result = Object.assign(new MockShape({ id: `${label}-${shapes.length}` }), {
        label,
        disposed: false,
        isEqual: (other: IShape) => other === result,
        dispose: rs.fn(() => {
            result.disposed = true;
        }),
    });
    shapes.push(result);
    return result;
}

function steps(count: number): Step[] {
    return Array.from({ length: count }, (_, index) => ({ id: `f${index}`, type: "test-rebuild-step" }));
}

function body(count: number, features = steps(count)): ParametricBodyNode {
    const node = new ParametricBodyNode({ document, featuresJson: JSON.stringify(features) });
    document.modelManager.addNode(node);
    return node;
}

function edit(node: ParametricBodyNode, index: number, change: Partial<Step>): void {
    const features: Step[] = JSON.parse(node.featuresJson);
    features[index] = { ...features[index], ...change };
    node.featuresJson = JSON.stringify(features);
}

function warm(node: ParametricBodyNode): IShape {
    void node.shape;
    DocumentRebuilds.flush(document);
    expect(node.shape.isOk).toBe(true);
    return node.shape.value;
}

const checkpoint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    shapes = [];
    calls = [];
    document = new TestDocument({ application: createMockApplication() });
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(shape("empty")) });
    registerFeature("test-rebuild-step", {
        display: "body.parametricBody",
        nodeIds: (feature: Step) => feature.refs ?? [],
        parameters: () => [],
        setParameter: (feature: Step) => feature,
        evaluate: (feature: Step, context: FeatureContext) => {
            if ((context.input as OwnedShape | undefined)?.disposed) throw new Error("disposed input");
            calls.push({ id: feature.id, revision: feature.revision, input: context.input });
            if (feature.fail) return Result.err("synthetic failure");
            if (!context.tracking) throw new Error("Body omitted tracking");
            context.tracking.outputFaceIds = [`${feature.id}:face`];
            context.tracking.outputEdgeIds = [`${feature.id}:edge`];
            const value =
                feature.variable === undefined
                    ? (feature.revision ?? 0)
                    : (context.scope.get(feature.variable)?.value ?? 0);
            return Result.ok(shape(`${feature.id}@${value}`));
        },
    });
});

afterEach(async () => {
    document.dispose();
    await DocumentRebuilds.settled(document);
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
    PerformanceTrace.disable();
});

test("uncommitted document edits invalidate suspended snapshots before the next feature", async () => {
    const node = body(16);
    const full = warm(node);
    PerformanceTrace.enable();
    edit(node, 0, { revision: 1 });
    await checkpoint();
    const stale = shapes.find((value) => value.label === "f0@1");
    expect(stale).not.toBeUndefined();
    if (!stale) throw new Error("No partial work to cancel");
    const transaction = new Transaction(document, "uncommitted rename");
    transaction.start();
    try {
        node.renameFeature("f0", "changed between batches");
        expect(node.shape.value).toBe(full);
        await node.whenRebuilt();
        expect(stale.dispose).toHaveBeenCalledTimes(1);
        expect(node.features[0].name).toBe("changed between batches");
        expect((node.timelineStateAt(1)?.shape as OwnedShape).label).toBe("f0@1");
        expect(node.timelineStateAt(1)?.shape).not.toBe(stale);
        expect(
            PerformanceTrace.snapshot()
                .records.filter((record) => record.stage === "body.rebuild")
                .map((record) => record.details?.["outcome"]),
        ).toEqual(["cancelled", "success"]);
    } finally {
        transaction.commit();
    }
});

test("failed restoration retries remain failures until a complete run succeeds", async () => {
    const node = body(16);
    warm(node);
    node.setRollbackIndex(4);
    const preview = node.shape.value;
    edit(node, 8, { fail: true });
    PerformanceTrace.enable();
    for (let retry = 0; retry < 2; retry++) {
        expect(node.requestRollbackIndex(undefined)).toBe(true);
        expect(await node.whenRebuilt()).toBe(false);
        expect(node.shape.value).toBe(preview);
        expect(node.featureItems()[8].error).toBe("synthetic failure");
    }
    expect(
        PerformanceTrace.snapshot()
            .records.filter((record) => record.stage === "body.rebuild")
            .map((record) => record.details),
    ).toEqual([
        expect.objectContaining({ trigger: "restore", outcome: "failed", committed: false }),
        expect.objectContaining({ trigger: "restore", outcome: "failed", committed: false }),
    ]);
    edit(node, 8, { fail: false });
    expect(await node.whenRebuilt()).toBe(true);
    expect(node.rollbackIndex).toBeUndefined();
});

test("real ThreeGeometry cold load schedules work and installs only completed meshes", async () => {
    document.dispose();
    document = new Document(createMockApplication(), "Three load");
    body(16);
    const stored = document.serialize();
    document.dispose();
    const app = createMockApplication();
    let context: ThreeVisualContext | undefined;
    let loadedDocument: IDocument | undefined;
    app.visualFactory.create = (doc) => {
        loadedDocument = doc;
        const visual = createMockVisualWithDocument(doc);
        context = new ThreeVisualContext(visual, new Scene());
        context.materialMap.set("", new MeshLambertMaterial());
        Object.assign(visual, { context });
        return visual;
    };
    const flush = rs.spyOn(DocumentRebuilds, "flush");
    try {
        const loading = Document.load(app, stored);
        await checkpoint();
        expect(loadedDocument).not.toBeUndefined();
        if (!loadedDocument || !context) throw new Error("No visual document");
        document = loadedDocument;
        const node = document.modelManager.findNode((node) => node instanceof ParametricBodyNode);
        expect(node).toBeInstanceOf(ParametricBodyNode);
        const model = node as ParametricBodyNode;
        const visual = context.getVisual(model) as ThreeGeometry;
        expect(visual).toBeInstanceOf(ThreeGeometry);
        expect(model.isRebuilding).toBe(true);
        const evaluated = calls.length;
        void model.mesh;
        visual.buildVisibleMeshes();
        expect(calls.length).toBe(evaluated);
        expect(evaluated).toBeLessThan(16);
        await loading;
        expect(flush).not.toHaveBeenCalled();
        expect(model.isRebuilding).toBe(false);
        const lastMesh = visual.faces();
        expect(lastMesh).not.toBeUndefined();
        edit(model, 0, { revision: 2 });
        visual.buildVisibleMeshes();
        expect(visual.faces()).toBe(lastMesh);
        await model.whenRebuilt();
        expect(visual.faces()).not.toBe(lastMesh);
    } finally {
        context?.dispose();
    }
});

test.each([0, 1, 5, 11, 12])("unchanged rollback at %i retains the full chain", (index) => {
    const node = body(12);
    const full = warm(node);
    const retained = [...shapes];
    const history = document.history.position();
    calls = [];
    for (let cycle = 0; cycle < 5; cycle++) {
        expect(node.requestRollbackIndex(index)).toBe(true);
        expect(node.isRebuilding).toBe(false);
        expect(node.timelineStateAt(index)).toBeUndefined();
        expect(node.faceIdAt(0)).toBe(index === 0 ? undefined : `f${index - 1}:face`);
        expect(node.requestRollbackIndex(undefined)).toBe(true);
        expect(node.isRebuilding).toBe(false);
        expect(node.shape.value).toBe(full);
        expect(node.faceIdAt(0)).toBe("f11:face");
    }
    expect(calls).toEqual([]);
    expect(document.history.position()).toBe(history);
    expect(retained.every((value) => !value.disposed)).toBe(true);
    expect(shapes.filter((value) => !value.disposed)).toHaveLength(12);
    node.dispose();
    for (const value of shapes) expect(value.dispose).toHaveBeenCalledTimes(1);
});

test("editing a rolled-back suffix preserves its prefix and invalidates all later inputs", async () => {
    const node = body(16);
    warm(node);
    const prefix = node.timelineStateAt(7)?.shape;
    node.setRollbackIndex(7);
    calls = [];
    edit(node, 7, { revision: 1 });
    expect(calls).toEqual([]);
    node.requestRollbackIndex(undefined);
    expect(node.isRebuilding).toBe(true);
    await node.whenRebuilt();
    expect(calls.map((call) => call.id)).toEqual(
        steps(16)
            .slice(7)
            .map((step) => step.id),
    );
    expect(calls[0].input).toBe(prefix);
    expect(node.timelineStateAt(7)?.shape).toBe(prefix);
    expect((node.shape.value as OwnedShape).label).toBe("f15@0");
});

test("variables changed during rollback invalidate retained entries on restoration", async () => {
    const features = steps(12);
    features[0].variable = "depth";
    const node = body(12, features);
    warm(node);
    node.setRollbackIndex(0);
    calls = [];
    document.variables.setItems([{ id: "depth", name: "depth", type: "unitless", expression: "20" }]);
    node.requestRollbackIndex(undefined);
    await node.whenRebuilt();
    expect(calls.map((call) => call.id)).toEqual(steps(12).map((step) => step.id));
});

test("unrelated variables changed during rollback preserve retained entries on restoration", async () => {
    document.variables.setItems([{ id: "depth", name: "depth", type: "unitless", expression: "20" }]);
    const features = steps(12);
    features[0].variable = "depth";
    const node = body(12, features);
    const full = warm(node);
    node.setRollbackIndex(0);
    calls = [];
    document.variables.setItems([
        { id: "depth", name: "depth", type: "unitless", expression: "20" },
        { id: "other", name: "other", type: "unitless", expression: "99" },
    ]);
    node.requestRollbackIndex(undefined);
    expect(await node.whenRebuilt()).toBe(true);
    expect(calls).toEqual([]);
    expect(node.shape.value).toBe(full);
});

test.each(["shape", "transform"])("a referenced %s change invalidates only its suffix", (kind) => {
    const reference = new EditableShapeNode({ document, name: "tool", shape: shape("tool") });
    document.modelManager.addNode(reference);
    const features = steps(6);
    features[3].refs = [reference.id];
    const node = body(6, features);
    warm(node);
    node.setRollbackIndex(3);
    calls = [];
    if (kind === "shape") reference.shape = Result.ok(shape("new tool"));
    else reference.transform = Matrix4.fromTranslation(1, 0, 0);
    expect(calls).toEqual([]);
    node.setRollbackIndex(undefined);
    expect(calls.map((call) => call.id)).toEqual(["f3", "f4", "f5"]);
});

test("a failed restore keeps the preview and its tracking; disposal releases both chains once", async () => {
    const node = body(12);
    warm(node);
    node.setRollbackIndex(4);
    const preview = node.shape.value;
    edit(node, 4, { revision: 1 });
    edit(node, 8, { fail: true });
    node.requestRollbackIndex(undefined);
    expect(await node.whenRebuilt()).toBe(false);
    expect(node.shape.value).toBe(preview);
    expect(node.faceIdAt(0)).toBe("f3:face");
    expect(node.featureItems()[8].error).toBe("synthetic failure");
    expect(node.timelineStateAt(8)).toBeUndefined();
    node.dispose();
    for (const value of shapes) expect(value.dispose).toHaveBeenCalledTimes(1);
});

test("large lazy rebuilds yield, report progress and hide their in-flight timeline between features", async () => {
    const node = body(16);
    const progress: number[] = [];
    const listener = (
        _document: IDocument,
        id: string,
        value: { completed: number; total: number } | undefined,
    ) => {
        if (id === node.id && value) progress.push(value.completed);
    };
    PubSub.default.sub("rebuildProgress", listener);
    try {
        expect(node.shape.isOk).toBe(false);
        expect(node.isRebuilding).toBe(true);
        expect(calls).toEqual([]);
        await checkpoint();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.length).toBeLessThan(16);
        expect(node.timelineStateAt(1)).toBeUndefined();
        expect(node.shape.isOk).toBe(false);
        expect(await node.whenRebuilt()).toBe(true);
        expect(calls).toHaveLength(16);
        expect(node.shape.value).toBe(shapes.at(-1));
        expect(progress).toEqual(Array.from({ length: 16 }, (_, index) => index));
        expect(DocumentRebuilds.pending(document)).toBe(false);
    } finally {
        PubSub.default.remove("rebuildProgress", listener);
    }
});

test("an edit cancels stale work without publishing it and retains the last good display", async () => {
    const node = body(16);
    const full = warm(node);
    const changes = rs.fn((property: string) => property);
    node.onPropertyChanged(changes);
    calls = [];
    edit(node, 0, { revision: 1 });
    await checkpoint();
    const abandoned = shapes.filter((value) => value.label === "f0@1");
    expect(abandoned).toHaveLength(1);
    expect(node.shape.value).toBe(full);
    edit(node, 0, { revision: 2 });
    expect(abandoned[0].dispose).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls.filter(([property]) => property === "shape")).toHaveLength(0);
    await node.whenRebuilt();
    expect(changes.mock.calls.filter(([property]) => property === "shape")).toHaveLength(1);
    expect((node.timelineStateAt(1)?.shape as OwnedShape).label).toBe("f0@2");
    expect(full.dispose).toHaveBeenCalledTimes(1);
});

test("undo cancels a suspended edit, redo rebuilds the intended data, and neither records derived shapes", async () => {
    const node = body(16);
    const full = warm(node);
    const count = document.history.undoCount();
    Transaction.execute(document, "edit", () => edit(node, 0, { revision: 1 }));
    await checkpoint();
    const stale = shapes.find((value) => value.label === "f0@1");
    expect(stale).not.toBeUndefined();
    if (!stale) throw new Error("Expected a partial stale rebuild");
    document.history.undo();
    expect(node.isRebuilding).toBe(false);
    expect(node.shape.value).toBe(full);
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    document.history.redo();
    expect(node.isRebuilding).toBe(true);
    await node.whenRebuilt();
    expect((node.timelineStateAt(1)?.shape as OwnedShape).label).toBe("f0@1");
    expect(document.history.undoCount()).toBe(count + 1);
});

test("disposing a suspended rebuild cancels its timer and releases partial and retained shapes", async () => {
    const node = body(16);
    warm(node);
    edit(node, 0, { revision: 1 });
    await checkpoint();
    const before = calls.length;
    node.dispose();
    await checkpoint();
    expect(calls).toHaveLength(before);
    expect(DocumentRebuilds.pending(document)).toBe(false);
    for (const value of shapes) expect(value.dispose).toHaveBeenCalledTimes(1);
});

test("a source rollback cancels a dependent's pending work until the source restores", async () => {
    const source = body(16);
    warm(source);
    const features = steps(16);
    features[3].refs = [source.id];
    const dependent = body(16, features);
    const previous = warm(dependent);
    edit(dependent, 0, { revision: 1 });
    await checkpoint();
    expect(dependent.isRebuilding).toBe(true);
    source.setRollbackIndex(0);
    expect(dependent.isRebuilding).toBe(false);
    expect(dependent.shape.value).toBe(previous);
    source.requestRollbackIndex(undefined);
    expect(dependent.isRebuilding).toBe(true);
    await dependent.whenRebuilt();
    expect((dependent.timelineStateAt(1)?.shape as OwnedShape).label).toBe("f0@1");
    expect(dependent.shape.value).not.toBe(previous);
});

test("small chains are synchronous; save awaits large rebuilds and synchronous serialization flushes", async () => {
    document.dispose();
    const application = createMockApplication();
    document = new Document(application, "scheduler test");
    const small = body(3);
    expect(small.shape.isOk).toBe(true);
    expect(small.isRebuilding).toBe(false);
    const large = body(16);
    void large.shape;
    const repository = new MemoryDocumentRepository();
    document.repository = repository;
    const save = document.save();
    expect(repository.saves).toHaveLength(0);
    await save;
    expect(large.isRebuilding).toBe(false);
    expect(repository.saves).toHaveLength(1);
    expect(AutosaveHolds.isHeld).toBe(false);
    edit(large, 0, { revision: 2 });
    expect(large.isRebuilding).toBe(true);
    document.serialize();
    expect(large.isRebuilding).toBe(false);
    expect((large.timelineStateAt(1)?.shape as OwnedShape).label).toBe("f0@2");
});

test.each([
    false,
    true,
])("load awaits visual rebuilds and preserves mid-load edits: %s", async (editDuringLoad) => {
    document.dispose();
    document = new Document(createMockApplication(), "load test");
    body(16);
    const stored = document.serialize();
    document.dispose();
    const application = createMockApplication();
    let loadingDocument: IDocument | undefined;
    application.visualFactory.create = (doc) => {
        loadingDocument = doc;
        doc.modelManager.addNodeObserver((records) => {
            for (const record of records) {
                const nodes: INode[] = [];
                NodeUtils.nodeOrChildrenAppendToNodes(nodes, record.node);
                for (const node of nodes) if (node instanceof ParametricBodyNode) void node.shape;
            }
        });
        return createMockVisualWithDocument(doc);
    };
    const loading = Document.load(application, stored);
    await checkpoint();
    expect(loadingDocument).not.toBeUndefined();
    if (!loadingDocument) throw new Error("Document was not constructed");
    const loadingDoc = loadingDocument;
    expect(loadingDoc.history.disabled).toBe(false);
    if (editDuringLoad) {
        Transaction.execute(loadingDoc, "rename during load", () => {
            loadingDoc.name = "edited during load";
        });
    }
    const loaded = await loading;
    expect(loaded).not.toBeUndefined();
    if (!loaded) throw new Error("Document failed to load");
    document = loaded;
    const node = document.modelManager.findNode(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode;
    expect(node.shape.isOk).toBe(true);
    expect(node.isRebuilding).toBe(false);
    expect(calls.slice(-16).map((call) => call.id)).toEqual(steps(16).map((step) => step.id));
    expect(document.isDirty).toBe(editDuringLoad);
});
