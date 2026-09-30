// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    AutosaveHolds,
    DocumentMutations,
    EditableShapeNode,
    KernelRecovery,
    KernelRecoveryCheckpoints,
    KernelState,
    Plane,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { createWasmRecoveryContext, initWasm, OccShapeProvider } from "@spicy3d/wasm";
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
    documents.splice(0).forEach((document) => document.dispose());
    KernelState.current.reset();
    rs.restoreAllMocks();
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
