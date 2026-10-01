// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    DocumentMutations,
    DocumentRebuilds,
    I18n,
    PubSub,
    Result,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication, createMockView, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { CornerSetbackCommand } from "../src/commands/cornerSetbackCommand";
import { startFeatureEdit } from "../src/commands/featureEditRegistry";
import "../src/commands/edgeCornerEditCommand";
import { showCornerSetbackEditor } from "../src/commands/cornerSetbackEditor";
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

test("a detached host rejects confirmation even when its feature and cached input remain unchanged", async () => {
    const feature = body.features[1] as FilletFeatureData;
    const preview = await prepareCornerSetbackEdit(body, { ...feature, cornerSetbacks: corner });
    expect(preview.isOk).toBe(true);
    expect(body.parent).not.toBeUndefined();
    body.parent!.remove(body);
    const position = cadDocument.history.position();
    expect((await preview.value.commit()).error).toMatch(/removed/);
    expect(cadDocument.history.position()).toBe(position);
    expect(body.features[1]).not.toHaveProperty("cornerSetbacks");
});

test("a new corner appends from the tracked final timeline state and is one undo step", async () => {
    const before = body.featuresJson;
    const feature = { ...(body.features[1] as FilletFeatureData), id: "new-corner", cornerSetbacks: corner };
    const preview = await prepareCornerSetbackEdit(body, feature);
    expect(preview.isOk).toBe(true);
    expect((await preview.value.commit()).isOk).toBe(true);
    expect(body.features).toHaveLength(3);
    expect(body.features[2].id).toBe("new-corner");
    expect(prepare).toHaveBeenCalledTimes(1);
    cadDocument.history.undo();
    await body.whenRebuilt();
    expect(body.featuresJson).toBe(before);
});

describe("explicit corner modal", () => {
    let originalPub: typeof PubSub.default.pub;
    let content: HTMLElement;
    let buttons: DialogButton[];
    beforeEach(() => {
        originalPub = PubSub.default.pub;
        PubSub.default.pub = ((topic: string, ...args: unknown[]) => {
            if (topic === "showDialog") {
                content = args[1] as HTMLElement;
                buttons = args[2] as DialogButton[];
            }
        }) as typeof PubSub.default.pub;
    });
    afterEach(() => {
        PubSub.default.pub = originalPub;
    });
    function button(key: "fillet.cornerRecompute" | "common.confirm" | "fillet.cornerCancelSolve") {
        const found = [...content.querySelectorAll<HTMLButtonElement>("button")].find(
            (value) => value.textContent === I18n.translate(key),
        );
        expect(found).not.toBeUndefined();
        return found!;
    }
    async function press(element: HTMLButtonElement) {
        expect(element.disabled).toBe(false);
        await element.onclick?.call(element, new PointerEvent("click"));
    }
    test("independent unit/expression fields wait for Recompute and Confirm commits the same fit", async () => {
        cadDocument.settings.lengthUnit = "cm";
        const initial = body.features[1] as FilletFeatureData;
        const before = body.featuresJson;
        const modal = showCornerSetbackEditor(body, initial);
        const fields = [...content.querySelectorAll<HTMLInputElement>("input")];
        expect(fields).toHaveLength(4);
        expect(fields[0].value).toBe("0.2");
        fields[1].value = "0.249";
        fields[2].value = "2.5 mm";
        fields[3].value = "2.5 mm + 0.01 mm";
        fields[3].dispatchEvent(new Event("input"));
        expect(prepare).not.toHaveBeenCalled();
        expect(button("common.confirm").disabled).toBe(true);
        await press(button("fillet.cornerRecompute"));
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(body.featuresJson).toBe(before);
        await press(button("common.confirm"));
        expect(await modal).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect((body.features[1] as FilletFeatureData).cornerSetbacks![0].distances).toEqual([
            2.49,
            2.5,
            "2.5 mm + 0.01 mm",
        ]);
    });
    test("closing a prepared modal restores visibility and leaves payload/history unchanged", async () => {
        const before = body.featuresJson;
        const position = cadDocument.history.position();
        const modal = showCornerSetbackEditor(body, body.features[1] as FilletFeatureData);
        await press(button("fillet.cornerRecompute"));
        expect(button("common.confirm").disabled).toBe(false);
        await buttons[0].onclick?.();
        expect(await modal).toBe(false);
        expect(body.featuresJson).toBe(before);
        expect(cadDocument.history.position()).toBe(position);
    });

    test("saved corner Edit opens the dedicated modal and cancellation releases command ownership", async () => {
        expect((await applyCornerSetbackEdit(body, "corner", corner)).isOk).toBe(true);
        cadDocument.application.activeView = createMockView({ document: cadDocument });
        const edit = startFeatureEdit(body, "corner");
        await new Promise<void>((done) => setTimeout(done, 0));
        expect(cadDocument.application.executingCommand).toBeInstanceOf(CornerSetbackCommand);
        expect(content.querySelectorAll("input")).toHaveLength(4);
        await buttons[0].onclick?.();
        await edit;
        expect(cadDocument.application.executingCommand).toBeUndefined();
        expect(prepare).toHaveBeenCalledTimes(1);
    });
    test("invalid fields keep confirmation disabled and display a useful failure before native work", async () => {
        const modal = showCornerSetbackEditor(body, body.features[1] as FilletFeatureData);
        const distance = content.querySelector<HTMLInputElement>('[data-role="setback-1"]');
        expect(distance).not.toBeNull();
        distance!.value = "0";
        await press(button("fillet.cornerRecompute"));
        expect(prepare).not.toHaveBeenCalled();
        expect(button("common.confirm").disabled).toBe(true);
        expect(content.querySelector('[role="status"]')?.textContent).toMatch(/positive/);
        await buttons[0].onclick?.();
        expect(await modal).toBe(false);
    });
    test("preview rendering failure disposes the fitted output and restores controls", async () => {
        const clone = rs.spyOn(output, "clone").mockImplementation(() => {
            throw new Error("preview failed");
        });
        const dispose = rs.spyOn(output, "dispose");
        const before = body.featuresJson;
        const modal = showCornerSetbackEditor(body, body.features[1] as FilletFeatureData);
        try {
            await press(button("fillet.cornerRecompute"));
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(button("common.confirm").disabled).toBe(true);
            expect(button("fillet.cornerRecompute").disabled).toBe(false);
            expect(content.querySelector('[role="status"]')?.textContent).toContain("preview failed");
            expect(body.featuresJson).toBe(before);
            await buttons[0].onclick?.();
            expect(await modal).toBe(false);
        } finally {
            clone.mockRestore();
            dispose.mockRestore();
        }
    });
    test("closing during commit waits for owned rollback cleanup before the editor finishes", async () => {
        let entered!: () => void;
        const tailStarted = new Promise<void>((done) => {
            entered = done;
        });
        const tailReady = new Promise<void>(() => {});
        registerFeature("test-corner-delayed-tail", {
            display: "body.parametricBody",
            nodeIds: () => [],
            parameters: () => [],
            setParameter: (feature) => feature,
            evaluate: () => Result.ok(new MockShape()),
            prepareAsync: () => {
                entered();
                return {
                    ready: tailReady,
                    cancel: () => {},
                    take: () => Result.ok(new MockShape()),
                    canFallback: false,
                };
            },
        });
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "tail", type: "test-corner-delayed-tail" } as unknown as FeatureData,
        ]);
        const before = body.featuresJson;
        const position = cadDocument.history.position();
        const modal = showCornerSetbackEditor(body, body.features[1] as FilletFeatureData);
        await press(button("fillet.cornerRecompute"));
        let finishCleanup!: () => void;
        const cleanup = new Promise<void>((done) => {
            finishCleanup = done;
        });
        const release = DocumentRebuilds.add(cadDocument, { settled: cleanup, flush: () => {} });
        const confirming = press(button("common.confirm"));
        await tailStarted;
        let finished = false;
        const closed = modal.then((success) => {
            finished = true;
            return success;
        });
        await buttons[0].onclick?.();
        await new Promise<void>((done) => setTimeout(done, 0));
        expect(finished).toBe(false);
        expect(DocumentMutations.isHeld(cadDocument)).toBe(true);
        expect(() => body.setFeaturesEmitShapeChanged([])).toThrow(/modeling program/);
        release();
        finishCleanup();
        await confirming;
        expect(await closed).toBe(false);
        expect(body.featuresJson).toBe(before);
        expect(cadDocument.history.position()).toBe(position);
        expect(DocumentMutations.isHeld(cadDocument)).toBe(false);
    });
});
