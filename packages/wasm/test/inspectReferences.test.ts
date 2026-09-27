// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, Plane, Result, Serializer, ShapeNode, ShapeTypes } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}

test("inspection source capture resolves real kernel subshapes repeatedly and after BREP serialization", () => {
    const doc = new TestDocument();
    try {
        const factory = createTestFactory();
        const node = new SourceNode({ document: doc, name: "Box" });
        node.shape = Result.ok(unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
        doc.modelManager.rootNode.add(node);
        const faces = node.shape.value.findSubShapes(ShapeTypes.face);
        const picked = faces[0];
        const captured = doc.analyses.captureSource(node, picked);
        expect(captured.isOk).toBe(true);
        const reference = JSON.parse(JSON.stringify(captured.value));
        for (let i = 0; i < 2; i++) {
            const resolved = doc.analyses.resolveSource(reference);
            expect(resolved.isOk).toBe(true);
            expect((resolved.value.subShape as IFace).area()).toBeCloseTo((picked as IFace).area(), 8);
            resolved.value.dispose();
        }
        const serialized = Serializer.serializeObject(node.shape.value);
        const reloaded = Serializer.deserializeObject(doc, JSON.parse(JSON.stringify(serialized))) as IShape;
        node.shape = Result.ok(reloaded);
        const resolved = doc.analyses.resolveSource(reference);
        expect(resolved.isOk).toBe(true);
        expect(resolved.value.subShape?.shapeType).toBe(ShapeTypes.face);
        resolved.value.dispose();
        faces.forEach((face) => {
            face.dispose();
        });
    } finally {
        doc.dispose();
    }
});
