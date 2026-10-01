// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    AutosaveHolds,
    Component,
    ComponentNode,
    DocumentMutations,
    EditableShapeNode,
    type IFace,
    type IKernelRecoveryContext,
    KernelRecovery,
    KernelRecoveryCheckpoints,
    KernelState,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { ParametricBodyNode, SketchNode } from "@spicy3d/parametric";
import { captureProfileRef } from "../../parametric/src/features/profileRef";
import "../../parametric/test/sketch/setup";
import { createWasmRecoveryContext, initWasm, OccShapeProvider } from "@spicy3d/wasm";
import { buildCapabilityTools } from "../../ai/src/tools/capabilityEngine";
import { retireKernelModule } from "../../wasm/src/kernelGuard";
import { Document } from "../src/document";
import { startKernelRecovery } from "../src/kernelRecovery";

const wasmBinary = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
const cleanup: (() => void)[] = [];
const documents: Document[] = [];

afterEach(() => {
    cleanup.splice(0).forEach((release) => release());
    rs.restoreAllMocks();
    documents.splice(0).forEach((document) => document.dispose());
    KernelState.current.reset();
    rs.unstubAllGlobals();
    rs.useRealTimers();
});

async function setup() {
    await initWasm({ wasmBinary });
    const provider = new OccShapeProvider({ geometryWorker: false });
    const app = createMockApplication({ shapeProvider: provider });
    const docs = [0, 1].map((index) => {
        const doc = new Document(app, `doc-${index}`, `stable-document-${index}`);
        const shape = provider.factory.box(Plane.XY, 10, 10, 10);
        expect(shape.isOk).toBe(true);
        const node = new EditableShapeNode({ document: doc, id: `stable-node-${index}`, name: "box", shape });
        doc.modelManager.addNode(node);
        doc.markSaved();
        if (index === 0) node.name = "committed unsaved edit";
        return doc;
    });
    documents.push(...docs);
    cleanup.push(
        startKernelRecovery(app, {
            createContext: () => createWasmRecoveryContext({ wasmBinary }),
            resetProvider: () => provider.resetKernel(),
        }),
    );
    return { app, provider, docs };
}

function withoutBrep(value: unknown): unknown {
    return JSON.parse(
        JSON.stringify(value, (key, item) => (key === "shape" && typeof item === "string" ? "<BREP>" : item)),
    );
}

function crash() {
    retireKernelModule(globalThis.wasm, "injected fatal crash");
    KernelState.current.markCrashed("injected fatal crash");
}

test("successful publication preserves saved envelope and dirty state while establishing an undo boundary", async () => {
    const { docs, provider } = await setup();
    const before = docs.map((doc) => doc.serialize());
    const positions = docs.map((doc) => doc.history.position());
    const nodes = docs.map(
        (doc) => doc.modelManager.findNode((node) => node instanceof EditableShapeNode) as EditableShapeNode,
    );
    const rawOldHandle = nodes[0].shape.value;
    const oldFactory = provider.factory;
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(true);
    expect(result.value).toEqual({ documentIds: docs.map((doc) => doc.id), undoReset: true });
    expect(KernelState.current.status).toBe("ok");
    expect(KernelRecovery.current.status).toBe("idle");
    expect(provider.factory).not.toBe(oldFactory);
    docs.forEach((doc, index) => {
        const fresh = doc.modelManager.findNode((node) => node.id === nodes[index].id) as EditableShapeNode;
        expect(fresh).not.toBe(nodes[index]);
        expect(fresh.shape.value.checkShape()).toBe(true);
        expect(fresh.shape.value.volume()).toBeCloseTo(1000);
        expect(withoutBrep(doc.serialize())).toEqual(withoutBrep(before[index]));
        expect(doc.history.position()).not.toBe(positions[index]);
        expect(doc.history.undoCount()).toBe(0);
        expect(doc.history.redoCount()).toBe(0);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    });
    expect(docs.map((doc) => doc.isDirty)).toEqual([true, false]);
    expect(AutosaveHolds.isHeld).toBe(false);
    expect(() => rawOldHandle.checkShape()).toThrow();
    const fresh = docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!;
    fresh.name = "new generation edit";
    docs[0].history.undo();
    expect(fresh.name).toBe("committed unsaved edit");
    docs[0].history.redo();
    expect(fresh.name).toBe("new generation edit");
});

test("native preparation failure in one open document preserves all graphs, undo and redo", async () => {
    const { docs } = await setup();
    const first = docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!;
    first.name = "redo available";
    docs[0].history.undo();
    expect(KernelRecoveryCheckpoints.capture(docs[0])).toBe(true);
    const roots = docs.map((doc) => doc.modelManager.rootNode);
    const positions = docs.map((doc) => doc.history.position());
    const counts = docs.map((doc) => [doc.history.undoCount(), doc.history.redoCount()]);
    rs.spyOn(docs[1], "prepareKernelRecovery").mockImplementation(() => {
        throw new Error("second native preparation failed");
    });
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("second native preparation failed");
    expect(KernelState.current.status).toBe("crashed");
    docs.forEach((doc, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
        expect([doc.history.undoCount(), doc.history.redoCount()]).toEqual(counts[index]);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    });
    expect(AutosaveHolds.isHeld).toBe(false);
});

test("unexpected second adoption failure restores all original graphs before native activation", async () => {
    const { docs } = await setup();
    const roots = docs.map((doc) => doc.modelManager.rootNode);
    const positions = docs.map((doc) => doc.history.position());
    const original = docs[1].prepareKernelRecovery.bind(docs[1]);
    rs.spyOn(docs[1], "prepareKernelRecovery").mockImplementation((checkpoint) => {
        const candidate = original(checkpoint);
        return {
            ...candidate,
            adopt() {
                candidate.adopt();
                throw new Error("adoption failed");
            },
        };
    });
    const oldModule = globalThis.wasm;
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("adoption failed");
    expect(globalThis.wasm).toBe(oldModule);
    expect(KernelState.current.status).toBe("crashed");
    docs.forEach((doc, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    });
});

test("checkpoint observation captures a completed transaction before another synchronous failure", async () => {
    const { docs } = await setup();
    Transaction.execute(docs[0], "commit before crash", () => {
        docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!.name = "latest committed edit";
    });
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(true);
    expect(docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!.name).toBe(
        "latest committed edit",
    );
});

test("scene-backed MCP subshape refs query the replacement generation after recovery", async () => {
    const { app, docs } = await setup();
    (app as any).activeView = { document: docs[0] };
    rs.stubGlobal("app", app);
    const tool = buildCapabilityTools()[0];
    const before = JSON.parse(
        (await tool.handler({
            ops: [
                {
                    id: "faces",
                    method: "shape.findSubShapes",
                    target: "stable-node-0",
                    args: { subshapeType: "face" },
                },
                { id: "area", method: "face.area", target: "faces#0" },
            ],
        })) as string,
    );
    expect(before.results.faces.count).toBe(6);
    expect(before.results.area).toBeCloseTo(100);
    crash();
    expect((await KernelRecovery.current.recover()).isOk).toBe(true);
    const after = JSON.parse(
        (await tool.handler({
            ops: [
                { id: "freshArea", method: "face.area", target: "faces#0" },
                { id: "volume", method: "shape.volume", target: "stable-node-0" },
            ],
        })) as string,
    );
    expect(after.results.freshArea).toBeCloseTo(100);
    expect(after.results.volume).toBeCloseTo(1000);
    expect(docs[0].history.undoCount()).toBe(0);
});

test("post-activation viewport failure leaves recovered geometry healthy and all undo stacks reset", async () => {
    const { docs } = await setup();
    rs.spyOn(docs[0].visual, "update").mockImplementation(() => {
        throw new Error("viewport unavailable");
    });
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("Kernel recovered");
    expect(result.error).toContain("viewport unavailable");
    expect(KernelState.current.status).toBe("ok");
    for (const doc of docs) {
        expect(doc.history.undoCount()).toBe(0);
        expect(doc.history.redoCount()).toBe(0);
        const fresh = doc.modelManager.findNode(
            (node) => node instanceof EditableShapeNode,
        ) as EditableShapeNode;
        expect(fresh.shape.value.volume()).toBeCloseTo(1000);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    }
    expect(AutosaveHolds.isHeld).toBe(false);
});

test("a document loaded after recovery startup captures its populated committed graph", async () => {
    const { app, docs } = await setup();
    const serialized = docs[1].serialize();
    serialized["id"] = "loaded-document";
    const loaded = await Document.load(app, serialized);
    expect(loaded).toBeInstanceOf(Document);
    documents.push(loaded as Document);
    expect(KernelRecoveryCheckpoints.read(loaded!).data["id"]).toBe("loaded-document");
    crash();
    expect((await KernelRecovery.current.recover()).isOk).toBe(true);
    const recovered = loaded!.modelManager.findNode(
        (node) => node.id === "stable-node-1",
    ) as EditableShapeNode;
    expect(recovered.shape.value.volume()).toBeCloseTo(1000);
    expect(loaded!.isDirty).toBe(false);
});

test("recovery cancels an interactive transaction and keeps the preceding committed checkpoint", async () => {
    const { app, docs } = await setup();
    const transaction = new Transaction(docs[0], "interrupted command");
    transaction.start();
    docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!.name = "uncommitted edit";
    const cancel = rs.fn(() => {
        transaction.rollback();
        (app as any).executingCommand = undefined;
    });
    (app as any).executingCommand = { cancel };
    crash();
    const result = await KernelRecovery.current.recover();
    expect(result.isOk).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Transaction.isActive(docs[0])).toBe(false);
    expect(docs[0].modelManager.findNode((node) => node.id === "stable-node-0")!.name).toBe(
        "committed unsaved edit",
    );
    expect(docs[0].isDirty).toBe(true);
    expect(docs[0].history.undoCount()).toBe(0);
});

test("replacement creation timeout preserves documents and disposes a late native context", async () => {
    const { app, docs, provider } = await setup();
    cleanup.pop()!();
    let created!: (context: IKernelRecoveryContext) => void;
    cleanup.push(
        startKernelRecovery(app, {
            createContext: () =>
                new Promise((resolve) => {
                    created = resolve;
                }),
            resetProvider: () => provider.resetKernel(),
        }),
    );
    const roots = docs.map((doc) => doc.modelManager.rootNode);
    const positions = docs.map((doc) => doc.history.position());
    crash();
    rs.useFakeTimers();
    const recovering = KernelRecovery.current.recover();
    await rs.advanceTimersByTimeAsync(30_001);
    const result = await recovering;
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("replacement kernel timed out");
    const dispose = rs.fn(() => {});
    created({ run: (action) => action(), publish: () => {}, dispose });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
    docs.forEach((doc, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    });
    expect(KernelState.current.status).toBe("crashed");
    expect(AutosaveHolds.isHeld).toBe(false);
});

function addComponent(document: Document, provider: OccShapeProvider) {
    const shape = provider.factory.box(Plane.XY, 6, 6, 6);
    expect(shape.isOk).toBe(true);
    const part = new EditableShapeNode({ document, id: "component-part", name: "part", shape });
    const component = new Component({
        id: "stable-component",
        name: "component",
        nodes: [part],
        origin: XYZ.zero,
    });
    document.modelManager.components.push(component);
    document.modelManager.addNode(
        new ComponentNode({
            document,
            id: "stable-instance",
            name: "instance",
            componentId: component.id,
            insert: XYZ.zero,
        }),
    );
    expect(KernelRecoveryCheckpoints.capture(document)).toBe(true);
    return component;
}

test("component preparation failure leaves live visuals untouched", async () => {
    const { docs, provider } = await setup();
    const originalComponent = addComponent(docs[0], provider);
    const removeNode = rs.spyOn(docs[0].visual.context, "removeNode");
    rs.spyOn(docs[1], "prepareKernelRecovery").mockImplementation(() => {
        throw new Error("second candidate failed");
    });
    crash();
    expect((await KernelRecovery.current.recover()).isOk).toBe(false);
    expect(removeNode).not.toHaveBeenCalled();
    expect(docs[0].modelManager.components.at(0)!).toBe(originalComponent);
});

test("component instances resolve against fresh candidate component geometry", async () => {
    const { docs, provider } = await setup();
    const previous = addComponent(docs[0], provider);
    crash();
    expect((await KernelRecovery.current.recover()).isOk).toBe(true);
    const fresh = docs[0].modelManager.components.at(0)!;
    expect(fresh).not.toBe(previous);
    expect(fresh.id).toBe("stable-component");
    const instance = docs[0].modelManager.findNode((node) => node.id === "stable-instance") as ComponentNode;
    expect(instance.component).toBe(fresh);
    expect(fresh.mesh.face.position.length).toBeGreaterThan(0);
    expect((fresh.nodes[0] as EditableShapeNode).shape.value.volume()).toBeCloseTo(216);
});

test("published parametric bodies keep variable subscriptions and rebuild with the replacement module", async () => {
    const { docs, provider, app } = await setup();
    rs.stubGlobal("shapeFactory", provider.factory);
    rs.stubGlobal("app", app);
    const doc = docs[0];
    doc.variables.setItems([{ id: "height-variable", name: "height", expression: "20", type: "length" }]);
    const sketch = new SketchNode({
        document: doc,
        id: "stable-sketch",
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, 20, 0] },
                { id: 2, type: "line", params: [20, 0, 20, 20] },
                { id: 3, type: "line", params: [20, 20, 0, 20] },
                { id: 4, type: "line", params: [0, 20, 0, 0] },
            ],
            constraints: [],
        },
    });
    doc.modelManager.addNode(sketch);
    const profiles = sketch.mesh.faces!.range.filter((item) => item.shape.shapeType === ShapeTypes.face);
    expect(profiles).toHaveLength(1);
    const body = new ParametricBodyNode({
        document: doc,
        id: "stable-parametric-body",
        features: [
            {
                id: "stable-extrude",
                type: "extrude",
                sketchId: sketch.id,
                depth: "height",
                profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.value.volume()).toBeCloseTo(8000);
    expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true);
    const variables = doc.variables;
    crash();
    expect((await KernelRecovery.current.recover()).isOk).toBe(true);
    const fresh = doc.modelManager.findNode((node) => node.id === body.id) as ParametricBodyNode;
    expect(fresh).not.toBe(body);
    expect(doc.variables).not.toBe(variables);
    expect(fresh.features.map((feature) => feature.id)).toEqual(["stable-extrude"]);
    expect(fresh.shape.value.volume()).toBeCloseTo(8000);
    doc.variables.setItems([{ id: "height-variable", name: "height", expression: "30", type: "length" }]);
    expect(fresh.shape.value.volume()).toBeCloseTo(12000);
    doc.history.undo();
    expect(fresh.shape.value.volume()).toBeCloseTo(8000);
    doc.history.redo();
    expect(fresh.shape.value.volume()).toBeCloseTo(12000);
});
