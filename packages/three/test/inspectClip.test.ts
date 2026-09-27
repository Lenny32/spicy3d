// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IApplication, type IView, Plane, XYZ } from "@spicy3d/core";
import { createMockVisual, TestDocument } from "@spicy3d/core/test-utils";
import { Scene, Plane as ThreePlane, Vector3 } from "three";
import { ThreeVisualContext } from "../src/threeVisualContext";

function fixture() {
    const doc = new TestDocument();
    const renderer = { clippingPlanes: [] as ThreePlane[] };
    const view = { document: doc, renderer, update: () => {} } as unknown as IView;
    doc.application = { views: [view] } as unknown as IApplication;
    const context = new ThreeVisualContext(createMockVisual({ document: doc }), new Scene());
    return { doc, renderer, context };
}

test("releasing an older analysis preserves the newest clipping plane", () => {
    const { doc, renderer, context } = fixture();
    try {
        const a = context.acquireAnalysisClip("a", Plane.XY);
        const b = context.acquireAnalysisClip("b", Plane.YZ);
        expect(renderer.clippingPlanes[0].normal.toArray()).toEqual([1, 0, 0]);
        a();
        expect(renderer.clippingPlanes[0].normal.toArray()).toEqual([1, 0, 0]);
        b();
        expect(renderer.clippingPlanes).toEqual([]);
    } finally {
        context.dispose();
        doc.dispose();
    }
});

test("reacquiring an owner invalidates the old release callback", () => {
    const { doc, renderer, context } = fixture();
    try {
        const old = context.acquireAnalysisClip("section", Plane.XY);
        const latest = context.acquireAnalysisClip("section", Plane.YZ);
        old();
        expect(renderer.clippingPlanes).toHaveLength(1);
        expect(renderer.clippingPlanes[0].normal.toArray()).toEqual([1, 0, 0]);
        latest();
        expect(renderer.clippingPlanes).toEqual([]);
    } finally {
        context.dispose();
        doc.dispose();
    }
});

test("last lease release restores the renderer's preexisting clipping state", () => {
    const { doc, renderer, context } = fixture();
    try {
        const previous = [new ThreePlane(new Vector3(0, 1, 0), -7)];
        renderer.clippingPlanes = previous;
        const release = context.acquireAnalysisClip(
            "section",
            new Plane({ origin: new XYZ(0, 0, 3), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        );
        expect(renderer.clippingPlanes).toHaveLength(2);
        expect(renderer.clippingPlanes.at(-1)?.constant).toBe(-3);
        release();
        expect(renderer.clippingPlanes).toEqual(previous);
    } finally {
        context.dispose();
        doc.dispose();
    }
});

test("a new view receives the active plane and restores its own previous clips", () => {
    const { doc, context } = fixture();
    try {
        const release = context.acquireAnalysisClip("section", Plane.XY);
        const prior = [new ThreePlane(new Vector3(1, 0, 0), -2)];
        const renderer = { clippingPlanes: prior };
        const view = { document: doc, renderer, update: () => {} };
        (doc.application.views as unknown as IView[]).push(view as unknown as IView);
        context.applyAnalysisClipToView(view);
        expect(renderer.clippingPlanes).toHaveLength(2);
        expect(renderer.clippingPlanes[1].normal.toArray()).toEqual([0, 0, 1]);
        release();
        expect(renderer.clippingPlanes).toEqual(prior);
    } finally {
        context.dispose();
        doc.dispose();
    }
});

test("section point visibility agrees with the retained renderer half-space and flip", () => {
    const { doc, renderer, context } = fixture();
    try {
        const release = context.acquireAnalysisClip(
            "section",
            new Plane({ origin: new XYZ(0, 0, 3), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        );
        expect(context.isAnalysisPointVisible(new XYZ(1, 2, 4))).toBe(true);
        expect(context.isAnalysisPointVisible(new XYZ(1, 2, 2))).toBe(false);
        expect(renderer.clippingPlanes[0].distanceToPoint(new Vector3(1, 2, 4))).toBeGreaterThan(0);
        release();
        const flipped = context.acquireAnalysisClip(
            "section",
            new Plane({ origin: new XYZ(0, 0, 3), normal: XYZ.unitNZ, xvec: XYZ.unitX }),
        );
        expect(context.isAnalysisPointVisible(new XYZ(1, 2, 4))).toBe(false);
        expect(context.isAnalysisPointVisible(new XYZ(1, 2, 2))).toBe(true);
        flipped();
        expect(context.isAnalysisPointVisible(new XYZ(1, 2, 4))).toBe(true);
    } finally {
        context.dispose();
        doc.dispose();
    }
});
