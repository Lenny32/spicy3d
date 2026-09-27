// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { ConstructionNode, XYZ } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { ThreeGeometry } from "../src/threeGeometry";
import { createThreeMockVisualContext } from "./mocks";

function fixture() {
    const doc = new TestDocument({ application: createMockApplication() });
    const node = new ConstructionNode({
        document: doc,
        definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 5 },
    });
    doc.modelManager.addNode(node);
    const visual = new ThreeGeometry(node, createThreeMockVisualContext());
    const setVisible = rs.spyOn(doc.visual.context, "setVisible");
    return { node, visual, setVisible };
}

describe("construction viewport visuals", () => {
    test("hover lookup handles a rendered datum without kernel subshape ranges", () => {
        const { visual } = fixture();
        try {
            expect(visual.wholeVisual()).toHaveLength(1);
            const hit = visual.getSubShapeAndIndex("edge", 0);
            expect(hit.subShape).toBeUndefined();
            expect(hit.groups).toEqual([]);
            expect(hit.index).toBe(-1);
        } finally {
            visual.dispose();
        }
    });

    test("whole-object highlighting restores the original datum material", () => {
        const { node, visual, setVisible } = fixture();
        const highlight = new LineMaterial({ color: 0xff0000 });
        try {
            expect(visual.node).toBe(node);
            const original = visual.edges()!.material;
            visual.setEdgesMateiralTemperary(highlight);
            expect(visual.edges()!.material).toBe(highlight);
            visual.removeTemperaryMaterial();
            expect(visual.edges()!.material).toBe(original);
            node.visible = false;
            expect(setVisible).toHaveBeenCalledWith(node, false);
            expect(node.visible).toBe(false);
            expect(node.geometry.isOk).toBe(true);
        } finally {
            visual.dispose();
            highlight.dispose();
        }
    });

    test("point datums expose a center for point picking", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        const node = new ConstructionNode({
            document: doc,
            definition: {
                kind: "point-vertex",
                vertex: { kind: "fixed", geometry: { kind: "point", point: new XYZ({ x: 3, y: 4, z: 5 }) } },
            },
        });
        doc.modelManager.addNode(node);
        const visual = new ThreeGeometry(node, createThreeMockVisualContext());
        try {
            const points = visual.vertexs();
            expect(points).not.toBeUndefined();
            const position = points!.geometry.getAttribute("position");
            expect(position.count).toBe(1);
            expect(position.getX(0)).toBeCloseTo(3);
            expect(position.getY(0)).toBeCloseTo(4);
            expect(position.getZ(0)).toBeCloseTo(5);
        } finally {
            visual.dispose();
        }
    });
});
