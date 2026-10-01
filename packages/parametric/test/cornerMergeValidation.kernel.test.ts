// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Document } from "@spicy3d/app";
import {
    collectRebuildReport,
    DocumentRebuilds,
    ModelManager,
    mergeDocuments,
    migrateDocument,
    Result,
    type Serialized,
    validateMerge,
} from "@spicy3d/core";
import { createMockApplication, loadDocumentFixtures } from "@spicy3d/core/test-utils";
import { HybridShapeFactory, ShapeFactory } from "@spicy3d/wasm";
import { HeadlessDocumentEvaluator } from "../../app/src/mergeEvaluator";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
import { type FeatureContext, featureHandler, registerFeature } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "../src";
import "./sketch/setup";
import "../../wasm/test/setup";

const originalFillet = featureHandler("fillet")!;
let hybrid: HybridShapeFactory;
let transport: NativeWorkerTransport;
beforeEach(() => {
    transport = new NativeWorkerTransport();
    hybrid = new HybridShapeFactory(() => transport.client);
    rs.stubGlobal("shapeFactory", new ShapeFactory(hybrid));
});
afterEach(() => {
    registerFeature("fillet", originalFillet);
    hybrid.dispose();
    rs.unstubAllGlobals();
});
function fixture(): Serialized {
    const stored = loadDocumentFixtures().find(
        (entry) => entry.name === "v2/parametric12-corner-setback.json",
    );
    expect(stored).not.toBeUndefined();
    return migrateDocument(stored!.data).value;
}

test.each([
    ["load", true],
    ["status preparation", false],
] as const)("production headless %s aborts a pending corner and disposes its private model after cleanup", async (_phase, eager) => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((done) => {
        start = done;
    });
    const ready = new Promise<void>((done) => {
        release = done;
    });
    let captured: FeatureContext | undefined;
    const cancel = rs.fn(() => release());
    registerFeature("fillet", {
        ...originalFillet,
        prepareAsync: (_feature, context) => {
            captured = context;
            start();
            return { ready, cancel, canFallback: false, take: () => Result.err("cancelled") };
        },
    });
    const status = rs.spyOn(ParametricBodyNode.prototype, "prepareRebuildStatus");
    const deserialize = ModelManager.prototype.deserialize;
    // A module can eagerly start derived geometry while loading. Keep the actual deserialization,
    // but trigger that runtime behavior so this test covers fill's pending-work wait before status collection.
    const eagerLoad = eager
        ? rs.spyOn(ModelManager.prototype, "deserialize").mockImplementation(async function (
              this: ModelManager,
              data,
          ) {
              await deserialize.call(this, data);
              const node = this.findNode(
                  (entry) => entry instanceof ParametricBodyNode,
              ) as ParametricBodyNode;
              void node.shape;
          })
        : undefined;
    const application = createMockApplication();
    const controller = new AbortController();
    const work = new HeadlessDocumentEvaluator(application).evaluate(fixture(), {
        signal: controller.signal,
    });
    try {
        await started;
        expect(captured).not.toBeUndefined();
        const dispose = rs.spyOn(captured!.document, "dispose");
        try {
            expect(status).toHaveBeenCalledTimes(eager ? 0 : 1);
            expect(DocumentRebuilds.pending(captured!.document)).toBe(true);
            controller.abort();
            expect(await work).toEqual(Result.err({ kind: "cancelled" }));
            expect(cancel).toHaveBeenCalled();
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(DocumentRebuilds.pending(captured!.document)).toBe(false);
            expect([...application.documents]).toEqual([]);
            expect((captured!.host as ParametricBodyNode).isRebuilding).toBe(false);
        } finally {
            dispose.mockRestore();
        }
    } finally {
        controller.abort();
        release();
        await work;
        status.mockRestore();
        eagerLoad?.mockRestore();
    }
});

test("merge validation genuinely rebuilds the accepted corner through a strict worker with no reported failures", async () => {
    const base = fixture();
    const ours = structuredClone(base);
    const theirs = structuredClone(base);
    ours["name"] = "Corner changed locally";
    theirs["userData"] = { note: "Other device metadata" };
    const structural = mergeDocuments(base, ours, theirs);
    expect(structural.isOk).toBe(true);
    expect(structural.value.conflicts).toEqual([]);
    const application = createMockApplication();
    let reportSize = -1;
    const validation = await validateMerge(structural.value, {
        // The two previously accepted parents have known good reports; rebuild the actual merged model once.
        ours: new Map(),
        theirs: new Map(),
        evaluator: {
            evaluate: async (data, options) => {
                const loaded = await Document.loadHeadless(application, data, { signal: options?.signal });
                expect(loaded.isOk).toBe(true);
                const doc = loaded.value;
                try {
                    const report = await collectRebuildReport(doc, options);
                    expect(report.isOk).toBe(true);
                    reportSize = report.value.size;
                    // The existing recovery contract deliberately stages synchronously. It must refuse
                    // this successfully rebuilt corner atomically rather than fitting for a minute on main.
                    const before = doc.serialize();
                    const root = doc.modelManager.rootNode;
                    const position = doc.history.position();
                    const history = [doc.history.undoCount(), doc.history.redoCount()];
                    expect(() =>
                        doc.prepareKernelRecovery({ data: before, position, dirty: doc.isDirty }),
                    ).toThrow(/cancelable worker recomputation|synchronous evaluation is unavailable/);
                    expect(doc.modelManager.rootNode).toBe(root);
                    expect(doc.serialize()).toEqual(before);
                    expect(doc.history.position()).toBe(position);
                    expect([doc.history.undoCount(), doc.history.redoCount()]).toEqual(history);
                    expect(DocumentRebuilds.pending(doc)).toBe(false);
                    return report;
                } finally {
                    doc.dispose();
                }
            },
        },
    });
    expect(validation.isOk).toBe(true);
    expect(reportSize).toBe(0);
    expect(validation.value.conflicts).toEqual([]);
    expect(
        transport.requests.filter(
            (request) => request.type === "request" && request.operation === "cornerSetbackReplica",
        ),
    ).toHaveLength(1);
}, 180_000);
