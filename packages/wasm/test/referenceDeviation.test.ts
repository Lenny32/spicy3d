// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { EditableShapeNode, GroupNode, Matrix4, measureNodeDeviation, Plane } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../../builder/src/defaultDataExchange";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

test("compares real CAD tessellation to mesh-only STL with intrinsic and hidden parent placement", async () => {
    const factory = createTestFactory();
    const document = new TestDocument();
    const base = unwrapOk(factory.rect(Plane.XY, 10, 10));
    const placed = base.transformedMul(Matrix4.fromTranslation(0, 0, 2));
    base.dispose();
    const group = new GroupNode({ document, name: "hidden placed group" });
    group.transform = Matrix4.fromTranslation(0, 0, 3);
    group.visible = false;
    const model = new EditableShapeNode({ document, name: "CAD rectangle", shape: placed });
    model.transform = Matrix4.fromTranslation(0, 0, 1);
    document.modelManager.addNode(group);
    group.add(model);
    rs.stubGlobal("shapeConverter", undefined);
    const ascii = `solid scan
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 10 10 0
endloop
endfacet
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 10 0
vertex 0 10 0
endloop
endfacet
endsolid scan`;
    try {
        const imported = await new DefaultDataExchange().importReferenceMesh(
            document,
            new File([ascii], "scan.stl"),
            {
                transform: Matrix4.fromTranslation(0, 0, 3),
            },
        );
        expect(imported.isOk).toBe(true);
        const result = await measureNodeDeviation(model, imported.value, { sampleCount: 256 });
        expect(result.isOk).toBe(true);
        expect(result.value.modelTriangleCount).toBe(2);
        expect(result.value.referenceTriangleCount).toBe(2);
        expect(result.value.rmsDeviation).toBeCloseTo(3, 10);
        expect(result.value.maxSampledDeviation).toBeCloseTo(3, 10);
        expect(result.value.worstSample.point.z).toBeCloseTo(6, 10);
        expect(result.value.worstSample.closestPoint.z).toBeCloseTo(3, 10);
    } finally {
        document.dispose();
        rs.unstubAllGlobals();
    }
});
