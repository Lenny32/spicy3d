// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMutations, DocumentRebuilds, Result, Transaction } from "@spicy3d/core";
import { createMockApplication, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { applyCornerSetbackEdit, prepareCornerSetbackEdit } from "../src/cornerSetbackEdit";
import type { EdgeRef } from "../src/features/edgeRef";
import {
    type FeatureData,
    type FilletFeatureData,
    featureHandler,
    registerFeature,
} from "../src/features/feature";
import "../src/features/edgeCorner";
import { ParametricBodyNode } from "../src/parametricBodyNode";

const original = featureHandler("fillet")!;
const refs = [0, 1, 2].map((axis) => ({
    kind: "line",
    edgeId: `edge:${axis}`,
    start: { x: 0, y: 0, z: 0 },
    end: { x: axis === 0 ? 40 : 0, y: axis === 1 ? 40 : 0, z: axis === 2 ? 40 : 0 },
})) as [EdgeRef, EdgeRef, EdgeRef];
const corner = [{ edges: refs, distances: [2.49, 2.5, 2.51] as [number, number, number] }];
let cadDocument: TestDocument;
let body: ParametricBodyNode;
let output: MockShape;
let prepare: ReturnType<typeof rs.fn>;
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
    output = new MockShape();
    prepare = rs.fn(() => ({
        ready: Promise.resolve(),
        take: () => Result.ok(output),
        cancel: () => {},
        canFallback: false,
    }));
    registerFeature("fillet", {
        ...original,
        evaluate: () => Result.ok(new MockShape()),
        prepareAsync: prepare,
    });
    body = new ParametricBodyNode({
        document: cadDocument,
        featuresJson: JSON.stringify([
            { id: "input", type: "test-corner-input" },
            { id: "corner", type: "fillet", radius: 2, edges: refs },
        ]),
    });
    cadDocument.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
});
afterEach(async () => {
    cadDocument.dispose();
    await DocumentRebuilds.settled(cadDocument);
    registerFeature("fillet", original);
    rs.unstubAllGlobals();
});

test("confirm consumes the prepared worker result once and commits one undo step", async () => {
    const before = body.featuresJson;
    const position = cadDocument.history.position();
    const answer = await applyCornerSetbackEdit(body, "corner", corner);
    expect(answer.isOk).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(body.shape.value).toBe(output);
    expect(cadDocument.history.position()).not.toBe(position);
    cadDocument.history.undo();
    await body.whenRebuilt();
    expect(body.featuresJson).toBe(before);
    expect(cadDocument.history.position()).toBe(position);
});

test("stale preview rejects a changed document without overwriting its later edit", async () => {
    const feature = body.features[1] as FilletFeatureData;
    const preview = await prepareCornerSetbackEdit(body, { ...feature, cornerSetbacks: corner });
    expect(preview.isOk).toBe(true);
    body.setFeaturesEmitShapeChanged(body.features.map((item) => ({ ...item, name: "later edit" })));
    const later = body.featuresJson;
    const answer = await preview.value.commit();
    expect(answer.error).toMatch(/stale/);
    expect(body.featuresJson).toBe(later);
    expect(DocumentMutations.isHeld(cadDocument)).toBe(false);
});

test("tail failure rolls the exact feature and undo position back", async () => {
    registerFeature("test-corner-tail", {
        display: "body.parametricBody",
        nodeIds: () => [],
        parameters: () => [],
        setParameter: (feature) => feature,
        evaluate: (_feature, context) =>
            context.input === output
                ? Result.err("Tail cannot accept this corner")
                : Result.ok(new MockShape()),
    });
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "tail", type: "test-corner-tail" } as unknown as FeatureData,
    ]);
    const before = body.featuresJson;
    const position = cadDocument.history.position();
    const answer = await applyCornerSetbackEdit(body, "corner", corner);
    expect(answer.error).toMatch(/Tail cannot accept/);
    expect(body.featuresJson).toBe(before);
    expect(cadDocument.history.position()).toBe(position);
    expect(body.shape.isOk).toBe(true);
    expect(Transaction.isActive(cadDocument)).toBe(false);
    expect(DocumentMutations.isHeld(cadDocument)).toBe(false);
});

test("preparation cancellation cancels the strict operation without touching history", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    const cancel = rs.fn(() => release());
    const start = rs.fn(() => ({ ready, cancel, canFallback: false, take: () => Result.err("cancelled") }));
    registerFeature("fillet", { ...original, prepareAsync: start });
    const position = cadDocument.history.position();
    const controller = new AbortController();
    const work = applyCornerSetbackEdit(body, "corner", corner, { signal: controller.signal });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(start).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await work).error).toMatch(/cancelled/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cadDocument.history.position()).toBe(position);
    expect(body.features[1]).not.toHaveProperty("cornerSetbacks");
});

test("interactive command authority is explicit at prepare and commit", async () => {
    cadDocument.application.executingCommand = { execute: async () => {} };
    expect((await applyCornerSetbackEdit(body, "corner", corner)).error).toMatch(/active command/);
    expect(prepare).not.toHaveBeenCalled();
    const answer = await applyCornerSetbackEdit(body, "corner", corner, { allowActiveCommand: true });
    expect(answer.isOk).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
});

test("confirming an unchanged corner neither solves again nor adds an undo step", async () => {
    expect((await applyCornerSetbackEdit(body, "corner", corner)).isOk).toBe(true);
    const position = cadDocument.history.position();
    const previous = body.shape.value;
    expect((await applyCornerSetbackEdit(body, "corner", structuredClone(corner))).isOk).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(cadDocument.history.position()).toBe(position);
    expect(body.shape.value).toBe(previous);
});
