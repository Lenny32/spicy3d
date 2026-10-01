// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { captureEmbossFaceRef } from "../../src/features/emboss";
import type { EmbossFeatureData } from "../../src/features/feature";
import { resolveProfiles } from "../../src/features/profileBuilder";
import { captureProfileRef } from "../../src/features/profileRef";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../../src/sketch";

export function rectangle(x0: number, y0: number, x1: number, y1: number, firstId = 1): SketchData {
    return {
        entities: [
            { id: firstId, type: "line", params: [x0, y0, x1, y0] },
            { id: firstId + 1, type: "line", params: [x1, y0, x1, y1] },
            { id: firstId + 2, type: "line", params: [x1, y1, x0, y1] },
            { id: firstId + 3, type: "line", params: [x0, y1, x0, y0] },
        ],
        constraints: [],
    };
}
export function embossFixture(withRelief = true, deboss = false) {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    const base = new SketchNode({
        document: doc,
        id: "sketch-base",
        plane: Plane.XY,
        data: rectangle(0, 0, 40, 40, 101),
    });
    const sketch = new SketchNode({
        document: doc,
        id: "sketch-relief",
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 35 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: rectangle(10, 10, 20, 20, 201),
    });
    doc.modelManager.addNode(base);
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        id: "body-emboss",
        features: [{ id: "base", type: "extrude", sketchId: base.id, depth: 20 }],
    });
    doc.modelManager.addNode(body);
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const top = faces.findIndex((face) => Math.abs(face.boundingBox().min.z - 20) < 1e-6);
    const feature: EmbossFeatureData = {
        id: "emboss",
        type: "emboss",
        sketchId: sketch.id,
        profiles: resolveProfiles(sketch).value.map(({ face }) => captureProfileRef(face)),
        faces: [
            captureEmbossFaceRef(faces[top], body.faceIdAt(top), body.faceIdIsShared(body.faceIdAt(top))),
        ],
        depth: 2,
        deboss,
    };
    faces.forEach((face) => {
        face.dispose();
    });
    if (withRelief) body.setFeaturesEmitShapeChanged([...body.features, feature]);
    return { app, doc, base, sketch, body, feature };
}
