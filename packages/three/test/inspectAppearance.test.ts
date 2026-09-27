// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Result, ShapeNode } from "@spicy3d/core";
import { createMockVisual, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { Mesh, MeshLambertMaterial, Scene, ShaderMaterial } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import type { ThreeGeometry } from "../src/threeGeometry";
import { ThreeVisualContext } from "../src/threeVisualContext";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
function fixture() {
    const doc = new TestDocument();
    const context = new ThreeVisualContext(createMockVisual({ document: doc }), new Scene());
    context.materialMap.set("", new MeshLambertMaterial({ color: 0x445566 }));
    const sources = ["selected", "other"].map((name) => {
        const node = new SourceNode({ document: doc, name });
        node.shape = Result.ok(new MockShape({ id: name }));
        doc.modelManager.rootNode.add(node);
        return node;
    });
    const visuals = sources.map((node) => context.getVisual(node) as ThreeGeometry);
    const meshes = visuals.map(
        (visual) =>
            visual
                .wholeVisual()
                .find((object) => object instanceof Mesh && !(object instanceof LineSegments2)) as Mesh,
    );
    expect(meshes.every((mesh) => mesh instanceof Mesh)).toBe(true);
    return { doc, context, sources, visuals, meshes };
}

test("appearance affects only selected faces, keeps line materials and restores original materials", () => {
    const { doc, context, sources, visuals, meshes } = fixture();
    try {
        const originals = meshes.map((mesh) => mesh.material);
        const lines = visuals[0]
            .wholeVisual()
            .filter((object): object is LineSegments2 => object instanceof LineSegments2);
        expect(lines.length).toBeGreaterThan(0);
        const lineMaterials = lines.map((line) => line.material);
        const release = context.acquireAnalysisAppearance("zebra", [
            { nodeId: sources[0].id, mode: "zebra", density: 8 },
        ]);
        expect(meshes[0].material).toBeInstanceOf(ShaderMaterial);
        expect(meshes[1].material).toBe(originals[1]);
        expect(lines.map((line) => line.material)).toEqual(lineMaterials);
        const dispose = rs.spyOn(meshes[0].material as ShaderMaterial, "dispose");
        release();
        expect(meshes[0].material).toBe(originals[0]);
        expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
        context.dispose();
        doc.dispose();
    }
});

test("releasing an old appearance owner preserves the latest owner and restores the newest source material", () => {
    const { doc, context, sources, visuals, meshes } = fixture();
    const replacement = new MeshLambertMaterial({ color: 0x123456 });
    try {
        const a = context.acquireAnalysisAppearance("surface", [{ nodeId: sources[0].id, mode: "zebra" }]);
        const b = context.acquireAnalysisAppearance("surface", [{ nodeId: sources[0].id, mode: "chrome" }]);
        a();
        expect(meshes[0].material).toBeInstanceOf(ShaderMaterial);
        expect((meshes[0].material as ShaderMaterial).uniforms["uZebra"].value).toBe(0);
        visuals[0].changeFaceMaterial(replacement);
        expect(meshes[0].material).toBeInstanceOf(ShaderMaterial);
        b();
        expect(meshes[0].material).toBe(replacement);
    } finally {
        context.dispose();
        doc.dispose();
        replacement.dispose();
    }
});

test("competing appearance owners reveal the previous override when the newest is hidden", () => {
    const { doc, context, sources, meshes } = fixture();
    try {
        const original = meshes[0].material;
        const a = context.acquireAnalysisAppearance("color", [
            { nodeId: sources[0].id, mode: "color", color: 0xabcdef },
        ]);
        const b = context.acquireAnalysisAppearance("zebra", [{ nodeId: sources[0].id, mode: "zebra" }]);
        b();
        expect(meshes[0].material).toBeInstanceOf(MeshLambertMaterial);
        expect((meshes[0].material as MeshLambertMaterial).color.getHex()).toBe(0xabcdef);
        a();
        expect(meshes[0].material).toBe(original);
    } finally {
        context.dispose();
        doc.dispose();
    }
});
