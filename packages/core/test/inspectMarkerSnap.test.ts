// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, PointSnapEventHandler, Result, XYZ } from "../src";
import { createHandlerMockView, createPointerEvent, TestDocument } from "../test-utils";

test.each([
    "ready",
    "hidden",
    "invalid",
    "clipped",
])("mass-center marker snap respects %s analysis state", async (state) => {
    const doc = new TestDocument();
    const controller = new AsyncController();
    const marker = new XYZ(-299, -99, 7);
    doc.analyses.registerEvaluator("centerOfMass", () => Result.ok({ marker }));
    const analysis = doc.analyses.add({
        name: "Mass center",
        kind: "centerOfMass",
        sources: [],
        settings: {},
        visible: true,
    });
    await doc.analyses.evaluate(analysis);
    const view = createHandlerMockView({ document: doc });
    const handler = new PointSnapEventHandler(doc, controller, {});
    try {
        if (state === "hidden") analysis.visible = false;
        if (state === "invalid") analysis.status = "invalid";
        doc.visual.context.isAnalysisPointVisible = () => state !== "clipped";
        handler.pointerMove(view, createPointerEvent());
        expect(handler.snaped?.info === "Mass center").toBe(state === "ready");
        expect(handler.snaped?.shapes).toEqual([]);
        expect(doc.modelManager.findNodes((node) => node.name === "Mass center")).toHaveLength(1);
    } finally {
        handler.dispose();
        controller.dispose();
        doc.dispose();
    }
});
