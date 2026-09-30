// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import type { LoftFeatureData } from "../../src/features/feature";
import { capturePathReference } from "../../src/features/pathReferences";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../../src/sketch";

export const guidedRectangle = (right: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [-5, -3, right, -3] },
        { id: 2, type: "line", params: [right, -3, right, 3] },
        { id: 3, type: "line", params: [right, 3, -5, 3] },
        { id: 4, type: "line", params: [-5, 3, -5, -3] },
    ],
    constraints: [],
});
export const guidedVertical = (x: number): SketchData => ({
    entities: [{ id: 11, type: "line", params: [x, 0, x, -20] }],
    constraints: [],
});

export function guidedLoftInputs() {
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    document.visual = createMockVisualWithDocument(document);
    document.selection = createMockSelection();
    app.activeView = createMockView({ document });
    const first = new SketchNode({ document, plane: Plane.XY, data: guidedRectangle(5) });
    const last = new SketchNode({
        document,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 20 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: guidedRectangle(5),
    });
    const spine = new SketchNode({
        document,
        plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: guidedVertical(0),
    });
    const boundary = new SketchNode({
        document,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 3, z: 0 }), normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: guidedVertical(5),
    });
    for (const node of [first, last, spine, boundary]) document.modelManager.addNode(node);
    return { app, document, first, last, spine, boundary };
}

export function setupGuidedLoft() {
    const state = guidedLoftInputs();
    const { document, first, last, spine, boundary } = state;
    const feature: LoftFeatureData = {
        id: "guidedLoft",
        type: "loft",
        sections: [{ sketchId: first.id }, { sketchId: last.id }],
        guided: {
            spine: { nodeId: spine.id, edges: [capturePathReference(spine, 0).value] },
            boundary: { nodeId: boundary.id, edges: [capturePathReference(boundary, 0).value] },
        },
    };
    const body = new ParametricBodyNode({ document, features: [feature] });
    document.modelManager.addNode(body);
    return { ...state, feature, body };
}
