// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentRebuilds, I18n, Result } from "@spicy3d/core";
import { ShapeFactory } from "@spicy3d/wasm";
import "../../wasm/test/setup";
import { SELF_INTERSECTION_SKIPPED } from "../src/features/selfIntersectionValidation";
import { setupGuidedLoft } from "./_helpers/guidedLoft";

afterEach(() => {
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

test.each([
    "clean",
    "intersects",
    "timeout",
])("guided loft %s uses deferred binding and bounded validation", async (verdict) => {
    const query = rs.fn(() => ({
        ready: Promise.resolve(),
        canFallback: false,
        cancel: () => {},
        take: () =>
            verdict === "timeout"
                ? Result.err("Self-intersection check timed out after 30000 ms (result unknown)")
                : Result.ok(verdict === "clean"),
    }));
    const factory = new ShapeFactory(undefined, {
        shapeQuery: query,
        shapeOperation: () => ({
            ready: Promise.resolve(),
            take: () => Result.err("unused"),
            cancel: () => {},
        }),
    });
    rs.stubGlobal("shapeFactory", factory);
    const oldBinding = rs.spyOn(wasm.ShapeFactory, "loftGuidedTracked");
    const deferred = rs.spyOn(wasm.ShapeFactory, "loftGuidedTrackedDeferred");
    const { body, document } = setupGuidedLoft();
    try {
        void body.shape;
        await DocumentRebuilds.settled(document);
        expect(oldBinding).toHaveBeenCalledTimes(0);
        expect(deferred).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(1);
        expect(body.shape.isOk).toBe(verdict !== "intersects");
        expect(body.featureItems()[0].error).toBe(
            verdict === "intersects" ? "Guided loft output intersects itself" : undefined,
        );
        expect(body.featureItems()[0].warning).toBe(
            verdict === "timeout" ? I18n.translate("warning.selfIntersection.timeout{0}", 30_000) : undefined,
        );
        body.applyVariables();
        await DocumentRebuilds.settled(document);
        expect(query).toHaveBeenCalledTimes(verdict === "intersects" ? 2 : 1);
    } finally {
        document.dispose();
    }
});

test("guided loft synchronous evaluation skips analyzer with warning, and missing binding preserves legacy validation", () => {
    const factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
    const oldBinding = rs.spyOn(wasm.ShapeFactory, "loftGuidedTracked");
    const binding = wasm.ShapeFactory.loftGuidedTrackedDeferred;
    const state = setupGuidedLoft();
    try {
        expect(state.body.shape.isOk).toBe(true);
        expect(state.body.featureItems()[0].warning).toBe(SELF_INTERSECTION_SKIPPED);
        expect(oldBinding).toHaveBeenCalledTimes(0);
        wasm.ShapeFactory.loftGuidedTrackedDeferred = undefined as never;
        expect(factory.supportsDeferredGuidedLoft).toBe(false);
        const legacy = setupGuidedLoft();
        try {
            expect(legacy.body.shape.isOk).toBe(true);
            expect(oldBinding).toHaveBeenCalledTimes(1);
            expect(legacy.body.featureItems()[0].warning).toBeUndefined();
        } finally {
            legacy.document.dispose();
        }
    } finally {
        wasm.ShapeFactory.loftGuidedTrackedDeferred = binding;
        state.document.dispose();
    }
});
