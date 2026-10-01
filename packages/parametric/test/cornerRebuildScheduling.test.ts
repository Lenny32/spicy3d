// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { collectRebuildReport, DocumentRebuilds, Result } from "@spicy3d/core";
import { createMockApplication, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { featureHandler, registerFeature } from "../src/features/feature";
import "../src/features/edgeCorner";
import { ParametricBodyNode } from "../src/parametricBodyNode";

const originalFillet = featureHandler("fillet")!;
let cadDocument: TestDocument;
beforeEach(() => {
    cadDocument = new TestDocument({ application: createMockApplication() });
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(new MockShape()) });
    registerFeature("test-corner-input", {
        display: "body.parametricBody",
        nodeIds: () => [],
        parameters: () => [],
        setParameter: (feature) => feature,
        evaluate: () => Result.ok(new MockShape()),
    });
});
afterEach(async () => {
    cadDocument.dispose();
    await DocumentRebuilds.settled(cadDocument);
    registerFeature("fillet", originalFillet);
    rs.unstubAllGlobals();
});
function createBody() {
    const node = new ParametricBodyNode({
        document: cadDocument,
        featuresJson: JSON.stringify([
            { id: "input", type: "test-corner-input" },
            { id: "corner", type: "fillet", radius: 2, edges: [], cornerSetbacks: [] },
        ]),
    });
    cadDocument.modelManager.addNode(node);
    return node;
}

test("a live two-feature corner body prepares asynchronously below the ordinary chain threshold", async () => {
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
        start = resolve;
    });
    const ready = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const output = new MockShape();
    const synchronous = rs.fn(() => Result.err("Synchronous corner must not run"));
    const prepare = rs.fn(() => {
        start();
        return { ready, take: () => Result.ok(output), cancel: finish, canFallback: false };
    });
    registerFeature("fillet", { ...originalFillet, evaluate: synchronous, prepareAsync: prepare });
    const node = createBody();
    try {
        void node.shape;
        await started;
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(synchronous).not.toHaveBeenCalled();
        DocumentRebuilds.flush(cadDocument);
        expect(node.isRebuilding).toBe(true);
        expect(synchronous).not.toHaveBeenCalled();
        finish();
        await node.whenRebuilt();
        expect(node.shape.isOk).toBe(true);
        expect(node.shape.value).toBe(output);
    } finally {
        finish();
    }
});

test("an explicitly synchronous live flush fails clearly without falling back to native fitting", () => {
    const prepare = rs.fn(originalFillet.prepareAsync);
    registerFeature("fillet", { ...originalFillet, prepareAsync: prepare });
    const native = rs.fn(() => Result.ok(new MockShape()));
    rs.stubGlobal("shapeFactory", {
        combine: () => Result.ok(new MockShape()),
        filletCornerSetbackTracked: native,
    });
    const node = createBody();
    ParametricBodyNode.withSynchronousEvaluation(cadDocument, () => {
        void node.shape;
    });
    expect(node.shape.isOk).toBe(false);
    expect(node.shape.error).toMatch(/cancelable worker recomputation/);
    expect(prepare).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
});

test("generic merge status preparation awaits the corner and abort cancels it without a synchronous flush", async () => {
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((done) => {
        start = done;
    });
    const ready = new Promise<void>((done) => {
        finish = done;
    });
    const cancel = rs.fn(() => finish());
    const synchronous = rs.fn(() => Result.err("No synchronous fallback"));
    registerFeature("fillet", {
        ...originalFillet,
        evaluate: synchronous,
        prepareAsync: () => {
            start();
            return { ready, cancel, canFallback: false, take: () => Result.err("cancelled") };
        },
    });
    const node = createBody();
    const controller = new AbortController();
    const work = collectRebuildReport(cadDocument, { signal: controller.signal });
    try {
        await started;
        expect(node.isRebuilding).toBe(true);
        expect(synchronous).not.toHaveBeenCalled();
        controller.abort();
        expect(await work).toEqual(Result.err({ kind: "cancelled" }));
        expect(cancel).toHaveBeenCalled();
        expect(node.isRebuilding).toBe(false);
        expect(synchronous).not.toHaveBeenCalled();
    } finally {
        controller.abort();
        finish();
        await work;
    }
});
