// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentRebuilds,
    EditableShapeNode,
    type IDocument,
    Matrix4,
    Plane,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockVisualWithDocument,
    MemoryDocumentRepository,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { HybridShapeFactory, ShapeFactory } from "@spicy3d/wasm";
import { Document } from "../../app/src/document";
import type { TrackedShapeResult } from "../../wasm/lib/spicy-wasm";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
import "../../wasm/test/setup";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let transport: NativeWorkerTransport;
let hybrid: HybridShapeFactory;
let factory: ShapeFactory;
let document: IDocument;

beforeEach(() => {
    transport = new NativeWorkerTransport();
    hybrid = new HybridShapeFactory(() => transport.client);
    factory = new ShapeFactory(hybrid);
    rs.stubGlobal("shapeFactory", factory);
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    document = doc;
});
afterEach(() => {
    document.dispose();
    hybrid.dispose();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

function model(count = 13) {
    const sketch = new SketchNode({
        document,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, 10, 0] },
                { id: 2, type: "line", params: [10, 0, 10, 10] },
                { id: 3, type: "line", params: [10, 10, 0, 10] },
                { id: 4, type: "line", params: [0, 10, 0, 0] },
            ],
            constraints: [],
        },
    });
    document.modelManager.addNode(sketch);
    const tools = Array.from({ length: count - 1 }, (_, index) => {
        const shape = factory.box(Plane.XY, 2, 2, 3);
        if (!shape.isOk) throw new Error(shape.error);
        const node = new EditableShapeNode({ document, shape, name: `tool-${index}` });
        node.transform = Matrix4.fromTranslation(index * 0.5, 0.5, 9);
        document.modelManager.addNode(node);
        return node;
    });
    const body = new ParametricBodyNode({
        document,
        features: [
            { id: "base", type: "extrude", sketchId: sketch.id, depth: 10 },
            ...tools.map((tool, index) => ({
                id: `f${index}`,
                type: "boolean" as const,
                operation: "fuse" as const,
                toolIds: [tool.id],
                consumeTools: false,
            })),
        ],
    });
    document.modelManager.addNode(body);
    void body.shape;
    return { body, tools };
}
function requests() {
    return transport.requests.filter(
        (request) => request.type === "request" && request.operation === "booleanReplica",
    );
}

test("large replay offloads every boolean, commits once, and restores a retained rollback without native work", async () => {
    const sync = rs.spyOn(factory, "booleanFuseTracked");
    const { body } = model();
    await DocumentRebuilds.settled(document);
    expect(body.shape.isOk).toBe(true);
    expect(requests().length).toBe(12);
    expect(sync).not.toHaveBeenCalled();
    const full = body.shape.value;
    const ids = full.findSubShapes(ShapeTypes.face).map((shape, index) => {
        shape.dispose();
        return body.faceIdAt(index);
    });
    const prefix = body.timelineStateAt(5)?.shape;
    expect(prefix).not.toBeUndefined();
    expect(body.setRollbackIndex(5)).toBe(true);
    expect(body.shape.value).toBe(prefix);
    expect(body.setRollbackIndex(undefined)).toBe(true);
    expect(body.shape.value).toBe(full);
    expect(requests().length).toBe(12);
    expect(ids.every((id, index) => id === body.faceIdAt(index))).toBe(true);
    expect(sync).not.toHaveBeenCalled();
});

test("synchronous takeover preserves the completed prefix and never imports the late worker result", async () => {
    const { body } = model();
    // Hold the second worker result: the first worker feature has already become part of this run's prefix.
    await rs.waitFor(() => expect(requests().length).toBeGreaterThanOrEqual(1));
    transport.hold = true;
    await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0));
    const prism = rs.spyOn(factory, "prismTracked");
    const sync = rs.spyOn(factory, "booleanFuseTracked");
    DocumentRebuilds.flush(document);
    expect(DocumentRebuilds.pending(document)).toBe(false);
    expect(body.shape.isOk).toBe(true);
    expect(prism).not.toHaveBeenCalled();
    expect(sync.mock.calls.length).toBeGreaterThan(0);
    expect(sync.mock.calls.length).toBeLessThanOrEqual(12);
    const full = body.shape.value;
    const imports = rs.spyOn(wasm.Converter, "convertFromBrep");
    transport.deliver();
    await transport.client.drain();
    expect(body.shape.value).toBe(full);
    expect(imports).not.toHaveBeenCalled();
});

test("edited async suffix and undo preserve the prefix and last-good display until atomic completion", async () => {
    const { body, tools } = model();
    await DocumentRebuilds.settled(document);
    expect(body.shape.isOk).toBe(true);
    const full = body.shape.value;
    const volume = full.volume();
    const prefix = body.timelineStateAt(6)?.shape;
    const before = requests().length;
    transport.hold = true;
    Transaction.execute(document, "move tool", () => {
        tools[5].transform = Matrix4.fromTranslation(30, 0, 0);
    });
    await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0));
    expect(body.shape.value).toBe(full);
    transport.deliver();
    await DocumentRebuilds.settled(document);
    expect(body.shape.value).not.toBe(full);
    expect(body.shape.value.volume()).not.toBeCloseTo(volume, 5);
    expect(body.timelineStateAt(6)?.shape).toBe(prefix);
    expect(requests().length - before).toBe(7);
    document.history.undo();
    await DocumentRebuilds.settled(document);
    expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
    expect(body.timelineStateAt(6)?.shape).toBe(prefix);
});

test("revision invalidation discards a parked result before any local import or cache installation", async () => {
    const { body } = model();
    await DocumentRebuilds.settled(document);
    const full = body.shape.value;
    transport.hold = true;
    const features = body.features;
    body.setFeaturesEmitShapeChanged(
        features.map((feature, index) => (index === 12 ? { ...feature, operation: "cut" } : feature)),
    );
    await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0));
    DocumentRebuilds.edited(document);
    body.setFeaturesEmitShapeChanged(features);
    // The already-retained correct cache wins; the cancelled cut's replicas must never be taken.
    const imports = rs.spyOn(wasm.Converter, "convertFromBrep");
    transport.deliver();
    await DocumentRebuilds.settled(document);
    await transport.client.drain();
    expect(body.shape.value).toBe(full);
    expect(imports).not.toHaveBeenCalled();
});

test("small chains and explicit synchronous programs keep their compatibility path", () => {
    const sync = rs.spyOn(factory, "booleanFuseTracked");
    const { body } = model(3);
    expect(body.shape.isOk).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(requests()).toEqual([]);
    const result = ParametricBodyNode.withSynchronousEvaluation(document, () => model(13));
    expect(result.body.shape.isOk).toBe(true);
    expect(requests()).toEqual([]);
});

test("a worker kernel failure keeps last-good geometry instead of replaying the unsafe operation on main", async () => {
    const { body, tools } = model();
    await DocumentRebuilds.settled(document);
    const previous = body.shape.value;
    const local = rs.spyOn(factory, "booleanFuseTracked");
    rs.spyOn(wasm.ShapeFactory, "booleanFuseTracked").mockImplementation(
        () =>
            ({
                isOk: false,
                error: "Native operation rejected",
                delete: () => {},
            }) as unknown as TrackedShapeResult,
    );
    tools[11].transform = Matrix4.fromTranslation(30, 0, 0);
    expect(await body.whenRebuilt()).toBe(false);
    expect(body.shape.value).toBe(previous);
    expect(local).not.toHaveBeenCalled();
    expect(body.featureItems().at(-1)?.error).toBe('boolean step "f11": Native operation rejected');
});

test("an unavailable backend falls back locally while preserving the cached prefix", async () => {
    const { body, tools } = model();
    await DocumentRebuilds.settled(document);
    const prefix = body.timelineStateAt(12)?.shape;
    const local = rs.spyOn(factory, "booleanFuseTracked");
    rs.spyOn(transport.kernel, "execute").mockImplementationOnce(() => ({
        ok: false,
        error: { code: "unavailable", message: "Worker unavailable" },
    }));
    tools[11].transform = Matrix4.fromTranslation(30, 0, 0);
    expect(await body.whenRebuilt()).toBe(true);
    expect(local).toHaveBeenCalledTimes(1);
    expect(body.timelineStateAt(12)?.shape).toBe(prefix);
    expect(body.shape.isOk).toBe(true);
});

test.each([
    ["boolean", "rejection"],
    ["boolean", "trap"],
    ["extrude", "rejection"],
    ["extrude", "trap"],
] as const)("%s %s stays fail-closed after unrelated edits, rollback retries and sync demands", async (kind, fault) => {
    const { body, tools } = model();
    await DocumentRebuilds.settled(document);
    const base = body.features[0];
    if (base.type !== "extrude") throw new Error("Missing base sketch");
    if (kind === "extrude") {
        body.setFeaturesEmitShapeChanged(
            body.features.map((feature, index) =>
                index === 12
                    ? {
                          id: feature.id,
                          type: "extrude",
                          sketchId: base.sketchId,
                          depth: 11,
                          operation: "fuse",
                      }
                    : feature,
            ),
        );
        await DocumentRebuilds.settled(document);
    }
    const previous = body.shape.value;
    const local = rs.spyOn(factory, "booleanFuseTracked");
    const native = rs.spyOn(wasm.ShapeFactory, "booleanFuseTracked").mockImplementation(() => {
        if (fault === "trap") throw new WebAssembly.RuntimeError("injected trap");
        return {
            isOk: false,
            error: "Native operation rejected",
            delete: () => {},
        } as unknown as TrackedShapeResult;
    });
    const message = fault === "trap" ? "Geometry worker native runtime failed" : "Native operation rejected";
    try {
        if (kind === "boolean") tools[11].transform = Matrix4.fromTranslation(30, 0, 0);
        else
            body.setFeaturesEmitShapeChanged(
                body.features.map((feature, index) => (index === 12 ? { ...feature, depth: 12 } : feature)),
            );
        expect(await body.whenRebuilt()).toBe(false);
        expect(body.shape.value).toBe(previous);
        expect(native).toHaveBeenCalledTimes(1);
        expect(hybrid.failure).toBe(message);
        expect(hybrid.available).toBe(true); // Failure is not compatibility unavailability.
        const submitted = requests().length;

        document.variables.setItems([{ id: "unused", name: "unused", type: "unitless", expression: "7" }]);
        expect(await body.whenRebuilt()).toBe(false);
        expect(body.shape.value).toBe(previous);
        hybrid.dispose(); // Disposing resources must not erase the quarantine.
        for (let attempt = 0; attempt < 2; attempt++) {
            body.requestRollbackIndex(1);
            expect(await body.whenRebuilt()).toBe(true);
            const preview = body.shape.value;
            body.requestRollbackIndex(undefined);
            expect(await body.whenRebuilt()).toBe(false);
            expect(body.shape.value).toBe(preview);
            expect(body.featureItems().some((item) => item.error?.endsWith(message))).toBe(true);
        }
        expect(native).toHaveBeenCalledTimes(1);
        expect(local).not.toHaveBeenCalled();
        expect(requests()).toHaveLength(submitted);

        body.requestRollbackIndex(undefined);
        DocumentRebuilds.flush(document);
        expect(native).toHaveBeenCalledTimes(1);
        expect(factory.booleanFuseTracked([previous], [previous]).isOk).toBe(false);
        expect(factory.booleanFuse([previous], [previous], true).isOk).toBe(false);
        expect(native).toHaveBeenCalledTimes(1);
        expect(hybrid.failure).toBe(message);
    } finally {
        // The trap was a JS test injection; the shared test module was not actually corrupted.
        // Real workers are terminated. Reclaim the loopback's quarantined test handles explicitly.
        rs.restoreAllMocks();
        Reflect.set(transport.kernel, "trapped", false);
        transport.kernel.dispose();
    }
});

test("MCP save awaits the worker chain; synchronous serialization takes over without a parked RPC", async () => {
    document.dispose();
    document = new Document(createMockApplication(), "hybrid save");
    const repository = new MemoryDocumentRepository();
    document.repository = repository;
    transport.hold = true;
    const { body } = model();
    await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0));
    const saving = document.save("mcp", { label: "worker geometry" });
    expect(repository.saves).toHaveLength(0);
    transport.deliver();
    await saving;
    expect(repository.saves).toHaveLength(1);
    expect(repository.saves[0].kind).toBe("mcp");
    expect(repository.saves[0].label).toBe("worker geometry");
    expect(body.shape.isOk).toBe(true);
    expect(requests()).toHaveLength(12);
    transport.hold = true;
    body.setFeaturesEmitShapeChanged(
        body.features.map((feature, index) => (index === 12 ? { ...feature, operation: "cut" } : feature)),
    );
    await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0));
    document.serialize();
    expect(body.isRebuilding).toBe(false);
    expect(DocumentRebuilds.pending(document)).toBe(false);
    const latest = body.shape.value;
    transport.deliver();
    await transport.client.drain();
    expect(body.shape.value).toBe(latest);
});

test("sketch extrude combines offload with the same ordered stable ids as a synchronous chain", async () => {
    const sketches = Array.from({ length: 13 }, (_, index) => {
        const x = index * 0.3;
        const sketch = new SketchNode({
            document,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [x, 0, x + 10, 0] },
                    { id: 2, type: "line", params: [x + 10, 0, x + 10, 10] },
                    { id: 3, type: "line", params: [x + 10, 10, x, 10] },
                    { id: 4, type: "line", params: [x, 10, x, 0] },
                ],
                constraints: [],
            },
        });
        document.modelManager.addNode(sketch);
        return sketch;
    });
    const features = sketches.map((sketch, index) => ({
        id: `sweep-${index}`,
        type: "extrude" as const,
        sketchId: sketch.id,
        depth: 10 + index * 0.2,
        ...(index > 0 ? { operation: "fuse" as const } : {}),
    }));
    const asyncBody = new ParametricBodyNode({ document, features });
    document.modelManager.addNode(asyncBody);
    void asyncBody.shape;
    await DocumentRebuilds.settled(document);
    expect(asyncBody.shape.isOk).toBe(true);
    expect(requests()).toHaveLength(12);
    const syncBody = ParametricBodyNode.withSynchronousEvaluation(document, () => {
        const body = new ParametricBodyNode({ document, features });
        document.modelManager.addNode(body);
        void body.shape;
        return body;
    });
    expect(syncBody.shape.isOk).toBe(true);
    expect(asyncBody.shape.value.volume()).toBeCloseTo(syncBody.shape.value.volume(), 7);
    for (const kind of [ShapeTypes.face, ShapeTypes.edge]) {
        const asyncSubs = asyncBody.shape.value.findSubShapes(kind);
        const syncSubs = syncBody.shape.value.findSubShapes(kind);
        try {
            expect(asyncSubs.length).toBe(syncSubs.length);
            for (let index = 0; index < asyncSubs.length; index++) {
                expect(kind === ShapeTypes.face ? asyncBody.faceIdAt(index) : asyncBody.edgeIdAt(index)).toBe(
                    kind === ShapeTypes.face ? syncBody.faceIdAt(index) : syncBody.edgeIdAt(index),
                );
            }
        } finally {
            asyncSubs.forEach((s) => s.dispose());
            syncSubs.forEach((s) => s.dispose());
        }
    }
    expect(requests()).toHaveLength(12);
});
