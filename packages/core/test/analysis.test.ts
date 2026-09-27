// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { GroupNode, Matrix4, Result, Serializer, type ShapeMeshData, ShapeNode, XYZ } from "../src";
import {
    type AnalysisContext,
    type AnalysisManager,
    AnalysisNode,
    type AnalysisResult,
} from "../src/analysis";
import { MockShape, TestDocument } from "../test-utils";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
    indexes = [0];
    faceIndexesOfId(_id: string) {
        return this.indexes;
    }
}
const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

let document: TestDocument;
let manager: AnalysisManager;
beforeEach(() => {
    document = new TestDocument();
    manager = document.analyses;
});
afterEach(() => {
    manager.dispose();
    document.dispose();
});
function fixture(visible = true) {
    return manager.add({ name: "Fixture", kind: "fixture", sources: [], settings: { value: 1 }, visible });
}

describe("inspection definition lifecycle", () => {
    test("actual serializer roundtrips nested references/settings twice without document injection", () => {
        const sources = [
            { nodeId: "source", subShape: { kind: "face" as const, stableId: "face-1", index: 2 } },
        ];
        const settings = { direction: { x: 1, y: 2, z: 3 }, densities: [1, 2], threshold: 0.25 };
        const original = new AnalysisNode({
            document,
            id: "analysis",
            name: "Density",
            kind: "mass",
            sources,
            settings,
            visible: false,
        });
        original.status = "ready";
        original.error = "ephemeral";
        let serialized = Serializer.serializeObject(original);
        for (let i = 0; i < 2; i++) {
            const copy = Serializer.deserializeObject(
                document,
                JSON.parse(JSON.stringify(serialized)),
            ) as AnalysisNode;
            expect(copy).toBeInstanceOf(AnalysisNode);
            expect(copy.id).toBe("analysis");
            expect(copy.sources).toEqual(sources);
            expect(copy.settings).toEqual(settings);
            expect(copy.visible).toBe(false);
            expect(copy.status).toBe("idle");
            expect(copy.error).toBeUndefined();
            expect(JSON.parse(JSON.stringify(copy.sources))).toEqual(sources);
            serialized = Serializer.serializeObject(copy);
        }
        expect(serialized).not.toHaveProperty("status");
        expect(serialized).not.toHaveProperty("error");
    });

    test("add, edit, delete, undo and redo preserve definition identity", async () => {
        const node = fixture(false);
        expect(manager.items).toEqual([node]);
        manager.update(node, { name: "Renamed", settings: { value: 2 } });
        expect(node.name).toBe("Renamed");
        document.history.undo();
        expect(node.name).toBe("Fixture");
        expect(node.settings).toEqual({ value: 1 });
        document.history.redo();
        expect(node.settings).toEqual({ value: 2 });
        manager.remove(node);
        expect(manager.items).toEqual([]);
        document.history.undo();
        expect(manager.items).toEqual([node]);
        expect(node.name).toBe("Renamed");
        document.history.redo();
        expect(manager.items).toEqual([]);
        await flush();
    });

    test("hide releases overlays/display, edits stay lazy, show recomputes and close releases everything", async () => {
        let nextMesh = 10;
        const displayMesh = rs.fn((_mesh: ShapeMeshData[]) => nextMesh++);
        const removeMesh = rs.fn((_id: number) => {});
        document.visual.context.displayMesh = displayMesh;
        document.visual.context.removeMesh = removeMesh;
        const restore = rs.fn(() => {});
        const dispose = rs.fn(() => {});
        const evaluate = rs.fn((_context: AnalysisContext) =>
            Result.ok<AnalysisResult>({
                overlays: [{ position: new Float32Array([0, 0, 0]), range: [] }],
                display: () => restore,
                dispose,
            }),
        );
        manager.registerEvaluator("fixture", evaluate);
        const node = fixture();
        await flush();
        expect(node.status).toBe("ready");
        expect(displayMesh).toHaveBeenCalledTimes(1);
        manager.update(node, { visible: false });
        await flush();
        expect(removeMesh).toHaveBeenCalledWith(10);
        expect(restore).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
        manager.update(node, { settings: { value: 2 } });
        await flush();
        expect(evaluate).toHaveBeenCalledTimes(1);
        manager.update(node, { visible: true });
        await flush();
        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(evaluate.mock.calls[1][0].settings["value"]).toBe(2);
        expect(node.status).toBe("ready");
        manager.dispose();
        expect(removeMesh).toHaveBeenCalledWith(11);
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(restore).toHaveBeenCalledTimes(2);
    });

    test("an old asynchronous result cannot replace a newer result and is disposed", async () => {
        const pending: Array<{
            context: AnalysisContext;
            resolve: (result: Result<AnalysisResult>) => void;
        }> = [];
        manager.registerEvaluator(
            "fixture",
            (context) => new Promise((resolve) => pending.push({ context, resolve })),
        );
        const node = fixture();
        expect(pending).toHaveLength(1);
        manager.update(node, { settings: { value: 2 } });
        expect(pending).toHaveLength(2);
        expect(pending[0].context.signal.aborted).toBe(true);
        const oldDispose = rs.fn(() => {});
        const oldDisplay = rs.fn(() => {});
        pending[1].resolve(Result.ok({ rows: [{ label: "new" }] }));
        await flush();
        expect(manager.result(node)?.rows).toEqual([{ label: "new" }]);
        pending[0].resolve(Result.ok({ rows: [{ label: "old" }], display: oldDisplay, dispose: oldDispose }));
        await flush();
        expect(manager.result(node)?.rows).toEqual([{ label: "new" }]);
        expect(oldDispose).toHaveBeenCalledTimes(1);
        expect(oldDisplay).not.toHaveBeenCalled();
    });

    test("delete during evaluation aborts and disposes the eventual kernel result", async () => {
        let finish!: (result: Result<AnalysisResult>) => void;
        let signal!: AbortSignal;
        manager.registerEvaluator("fixture", (context) => {
            signal = context.signal;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const node = fixture();
        manager.remove(node);
        expect(signal.aborted).toBe(true);
        const dispose = rs.fn(() => {});
        finish(Result.ok({ dispose }));
        await flush();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(manager.result(node)).toBeUndefined();
    });
});

describe("inspection source resolution", () => {
    function source() {
        const node = new SourceNode({ document, name: "Source" });
        node.shape = Result.ok(new MockShape({ id: "parent" }));
        document.modelManager.rootNode.add(node);
        return node;
    }
    test("nested transforms compose in hierarchy order without requiring a viewport visual", () => {
        const parent = new GroupNode({ document, name: "Parent" });
        parent.transform = Matrix4.fromScale(2, 2, 2);
        document.modelManager.rootNode.add(parent);
        const node = new SourceNode({ document, name: "Source" });
        node.shape = Result.ok(new MockShape());
        node.transform = Matrix4.fromTranslation(3, 4, 5);
        parent.add(node);
        const result = manager.resolveSource({ nodeId: node.id });
        expect(result.isOk).toBe(true);
        expect(result.value.worldTransform.ofPoint(XYZ.zero)).toEqual(new XYZ(6, 8, 10));
        result.value.dispose();
    });
    test("stable identity follows reordered indices and rejects ambiguity or loss instead of index fallback", () => {
        const node = source();
        node.shape.value.findSubShapes = () => [new MockShape({ id: "a" }), new MockShape({ id: "b" })];
        node.shape.value.clone = () => {
            const copy = new MockShape();
            copy.findSubShapes = node.shape.value.findSubShapes;
            return copy;
        };
        const ref = { nodeId: node.id, subShape: { kind: "face" as const, stableId: "tracked", index: 0 } };
        node.indexes = [1];
        const result = manager.resolveSource(ref);
        expect(result.isOk).toBe(true);
        expect(result.value.subShape?.id).toBe("b");
        result.value.dispose();
        node.indexes = [0, 1];
        const ambiguous = manager.resolveSource(ref);
        expect(ambiguous.isOk).toBe(false);
        expect(ambiguous.error).toContain("ambiguous");
        node.indexes = [];
        const lost = manager.resolveSource(ref);
        expect(lost.isOk).toBe(false);
        expect(lost.error).toContain("missing");
    });
    test("missing source exposes a visible warning and never calls evaluator", async () => {
        const evaluator = rs.fn((_context: AnalysisContext) => Result.ok<AnalysisResult>({}));
        manager.registerEvaluator("fixture", evaluator);
        const node = manager.add({
            name: "Lost",
            kind: "fixture",
            sources: [{ nodeId: "missing" }],
            settings: {},
            visible: true,
        });
        await flush();
        expect(node.status).toBe("invalid");
        expect(node.warningCount).toBe(1);
        expect(node.warningTooltip).toContain("missing");
        expect(evaluator).not.toHaveBeenCalled();
    });
});

describe("inspection failure isolation", () => {
    test("display setup failure removes installed overlays and disposes the result", async () => {
        const dispose = rs.fn(() => {});
        const removeMesh = rs.fn((_id: number) => {});
        document.visual.context.displayMesh = () => 42;
        document.visual.context.removeMesh = removeMesh;
        const node = fixture(false);
        manager.registerEvaluator("fixture", () =>
            Result.ok({
                overlays: [{ position: new Float32Array([0, 0, 0]), range: [] }],
                dispose,
                display: () => {
                    throw new Error("Display unavailable");
                },
            }),
        );
        manager.update(node, { visible: true });
        await flush();
        expect(node.status).toBe("invalid");
        expect(node.warningTooltip).toBe("Display unavailable");
        expect(removeMesh).toHaveBeenCalledWith(42);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(manager.result(node)).toBeUndefined();
    });

    test("untracked topology replacement cannot silently attach to the same array index", () => {
        const node = new SourceNode({ document, name: "Source" });
        const original = new MockShape({ id: "original" });
        original.findSubShapes = () => [new MockShape({ id: "face-old" })];
        original.clone = () => {
            const copy = new MockShape();
            copy.findSubShapes = original.findSubShapes;
            return copy;
        };
        node.shape = Result.ok(original);
        document.modelManager.rootNode.add(node);
        const oldFace = new MockShape({ id: "face-old" });
        const signature = manager.subShapeSignature(oldFace, original);
        oldFace.dispose();
        const ref = { nodeId: node.id, subShape: { kind: "face" as const, index: 0, signature } };
        const before = manager.resolveSource(ref);
        expect(before.isOk).toBe(true);
        before.value.dispose();
        const replacement = new MockShape({ id: "replacement" });
        replacement.findSubShapes = () => [new MockShape({ id: "face-new" })];
        replacement.clone = () => {
            const copy = new MockShape();
            copy.findSubShapes = replacement.findSubShapes;
            return copy;
        };
        node.shape = Result.ok(replacement);
        const after = manager.resolveSource(ref);
        expect(after.isOk).toBe(false);
        expect(after.error).toContain("cannot be safely reattached");
    });
});

test("competing sections display only the active cap and restore the older cap when hidden", async () => {
    const activeMeshes = new Map<number, number>();
    let nextId = 1;
    document.visual.context.displayMesh = (meshes) => {
        const id = nextId++;
        activeMeshes.set(id, meshes[0].position[2]);
        return id;
    };
    document.visual.context.removeMesh = (id) => {
        activeMeshes.delete(id);
    };
    manager.registerEvaluator("section", (context) =>
        Result.ok({
            overlays: [{ position: new Float32Array([0, 0, Number(context.settings["offset"])]), range: [] }],
        }),
    );
    const a = manager.add({
        name: "A",
        kind: "section",
        sources: [],
        settings: { offset: 3 },
        visible: true,
    });
    await manager.evaluate(a);
    const b = manager.add({
        name: "B",
        kind: "section",
        sources: [],
        settings: { offset: 7 },
        visible: true,
    });
    await manager.evaluate(b);
    expect([...activeMeshes.values()]).toEqual([7]);
    b.visible = false;
    await flush();
    expect([...activeMeshes.values()]).toEqual([3]);
    b.visible = true;
    await manager.evaluate(b);
    expect([...activeMeshes.values()]).toEqual([7]);
    manager.remove(b);
    await flush();
    expect([...activeMeshes.values()]).toEqual([3]);
});

test("competing face colors suppress older overlays only on shared source bodies", async () => {
    const a = new SourceNode({ document, name: "Body A" });
    a.shape = Result.ok(new MockShape());
    document.modelManager.rootNode.add(a);
    const b = new SourceNode({ document, name: "Body B" });
    b.shape = Result.ok(new MockShape());
    document.modelManager.rootNode.add(b);
    const meshes = new Map<number, number>();
    let next = 1;
    document.visual.context.displayMesh = (items) => {
        const id = next++;
        meshes.set(id, items[0].position[2]);
        return id;
    };
    document.visual.context.removeMesh = (id) => {
        meshes.delete(id);
    };
    for (const kind of ["draft", "curvatureMap"])
        manager.registerEvaluator(kind, (context) =>
            Result.ok({
                overlays: [
                    { position: new Float32Array([0, 0, Number(context.settings["value"])]), range: [] },
                ],
            }),
        );
    const first = manager.add({
        name: "Draft A",
        kind: "draft",
        sources: [{ nodeId: a.id }],
        settings: { value: 1 },
        visible: true,
    });
    await manager.evaluate(first);
    const independent = manager.add({
        name: "Draft B",
        kind: "draft",
        sources: [{ nodeId: b.id }],
        settings: { value: 2 },
        visible: true,
    });
    await manager.evaluate(independent);
    const newer = manager.add({
        name: "Curvature A",
        kind: "curvatureMap",
        sources: [{ nodeId: a.id }],
        settings: { value: 3 },
        visible: true,
    });
    await manager.evaluate(newer);
    expect([...meshes.values()].sort()).toEqual([2, 3]);
    newer.visible = false;
    await flush();
    expect([...meshes.values()].sort()).toEqual([1, 2]);
});
