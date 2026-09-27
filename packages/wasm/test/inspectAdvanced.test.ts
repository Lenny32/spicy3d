// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FaceMeshData,
    type IShape,
    Matrix4,
    Plane,
    Result,
    ShapeNode,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { registerAdvancedInspectAnalyses } from "../../app/src/analysis/advanced";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
const factory = createTestFactory();
let doc: TestDocument;
beforeEach(() => {
    doc = new TestDocument();
    registerAdvancedInspectAnalyses(doc.analyses);
});
afterEach(() => doc.dispose());
async function analyze(kind: string, shape: IShape, settings: Record<string, unknown>) {
    const source = new SourceNode({ document: doc, name: "Fixture" });
    source.shape = Result.ok(shape);
    doc.modelManager.rootNode.add(source);
    const node = doc.analyses.add({
        name: kind,
        kind,
        sources: [{ nodeId: source.id }],
        settings,
        visible: false,
    });
    node.visible = true;
    await doc.analyses.evaluate(node);
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const result = doc.analyses.result(node);
    expect(result).not.toBeUndefined();
    if (!result) throw new Error("Expected advanced analysis result");
    return result;
}

test("straight edge comb reports zero defined curvature instead of unknown samples", async () => {
    const result = await analyze("curvatureComb", unwrapOk(factory.line(XYZ.zero, new XYZ(10, 0, 0))), {
        sampleCount: 8,
        scale: 10,
    });
    expect(result.legend?.find((entry) => entry.label === "Undefined samples")?.value).toBe("0");
    expect(result.legend?.find((entry) => entry.label === "Curvature")?.value).toContain("0.000");
});

test("planar isocurves use the trimmed finite face bounds", async () => {
    const result = await analyze("isocurves", unwrapOk(factory.rect(Plane.XY, 10, 20)), {
        count: 3,
        steps: 16,
        direction: "both",
    });
    const positions = result.overlays?.[0].position;
    expect(positions).not.toBeUndefined();
    if (!positions) throw new Error("Expected isocurve overlay");
    expect(positions.length).toBeGreaterThan(24);
    for (let i = 0; i < positions.length; i += 3) {
        expect(positions[i]).toBeGreaterThanOrEqual(-1e-6);
        expect(positions[i]).toBeLessThanOrEqual(10 + 1e-6);
        expect(positions[i + 1]).toBeGreaterThanOrEqual(-1e-6);
        expect(positions[i + 1]).toBeLessThanOrEqual(20 + 1e-6);
        expect(positions[i + 2]).toBeCloseTo(0, 6);
    }
});

test("sphere draft overlay has opposite classifications above and below the equator", async () => {
    const result = await analyze("draft", unwrapOk(factory.sphere(XYZ.zero, 10)), {
        pullDirection: { x: 0, y: 0, z: 1 },
        threshold: 2,
    });
    expect(result.overlays).toHaveLength(1);
    const mesh = result.overlays?.[0] as FaceMeshData;
    expect(Array.isArray(mesh.color)).toBe(true);
    const colors = mesh.color as number[];
    let above = 0,
        below = 0;
    for (let i = 0; i < mesh.position.length; i += 9) {
        const z = (mesh.position[i + 2] + mesh.position[i + 5] + mesh.position[i + 8]) / 3;
        if (z > 5) {
            expect(colors.slice(i, i + 3)).toEqual([43 / 255, 173 / 255, 75 / 255]);
            above++;
        }
        if (z < -5) {
            expect(colors.slice(i, i + 3)).toEqual([212 / 255, 77 / 255, 77 / 255]);
            below++;
        }
    }
    expect(above).toBeGreaterThan(10);
    expect(below).toBeGreaterThan(10);
});

test("isocurves never bridge a trim hole narrower than the chosen sampling step", async () => {
    const outer = unwrapOk(factory.rect(Plane.XY, 10, 20));
    const inner = unwrapOk(
        factory.rect(new Plane({ origin: new XYZ(4, 1, 0), normal: XYZ.unitZ, xvec: XYZ.unitX }), 2, 0.2),
    );
    const outerWire = outer.outerWire();
    const innerWire = inner.outerWire();
    innerWire.reserve();
    const face = unwrapOk(factory.face([outerWire, innerWire]));
    outerWire.dispose();
    innerWire.dispose();
    outer.dispose();
    inner.dispose();
    const result = await analyze("isocurves", face, { count: 1, steps: 8, direction: "u" });
    const positions = result.overlays?.[0].position;
    expect(positions).not.toBeUndefined();
    if (!positions) throw new Error("Expected isocurve overlay");
    for (let i = 0; i < positions.length; i += 6) {
        const x = (positions[i] + positions[i + 3]) / 2;
        const minY = Math.min(positions[i + 1], positions[i + 4]);
        const maxY = Math.max(positions[i + 1], positions[i + 4]);
        const crossesHole = x > 4 && x < 6 && minY < 1.2 - 1e-6 && maxY > 1 + 1e-6;
        expect(crossesHole).toBe(false);
    }
});

test.each(["edge", "face"])("draft direction follows the transformed referenced %s", async (kind) => {
    const target = new SourceNode({ document: doc, name: "Target" });
    target.shape = factory.rect(Plane.XY, 10, 10);
    doc.modelManager.rootNode.add(target);
    const direction = new SourceNode({ document: doc, name: "Direction" });
    direction.shape =
        kind === "edge" ? factory.line(XYZ.zero, new XYZ(0, 0, 10)) : factory.rect(Plane.XY, 2, 2);
    doc.modelManager.rootNode.add(direction);
    const node = doc.analyses.add({
        name: "Draft",
        kind: "draft",
        sources: [{ nodeId: target.id }, { nodeId: direction.id }],
        settings: {
            directionSourceIndex: 1,
            directionSourceId: direction.id,
            directionSourceKind: kind,
            threshold: 2,
        },
        visible: true,
    });
    await doc.analyses.evaluate(node);
    expect(node.error).toBeUndefined();
    expect(new Set((doc.analyses.result(node)?.overlays?.[0] as FaceMeshData).color as number[])).toEqual(
        new Set([43 / 255, 173 / 255, 75 / 255]),
    );
    direction.transform = Matrix4.fromArray([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    await doc.analyses.evaluate(node);
    expect(node.error).toBeUndefined();
    expect(new Set((doc.analyses.result(node)?.overlays?.[0] as FaceMeshData).color as number[])).toEqual(
        new Set([1, 194 / 255, 71 / 255]),
    );
});

test("a direction edge from the same body does not remove the target body", async () => {
    const source = new SourceNode({ document: doc, name: "Body" });
    source.shape = factory.box(Plane.XY, 10, 20, 30);
    doc.modelManager.rootNode.add(source);
    const edges = source.shape.value.findSubShapes(ShapeTypes.edge);
    try {
        const reference = unwrapOk(doc.analyses.captureSource(source, edges[0]));
        const node = doc.analyses.add({
            name: "Draft",
            kind: "draft",
            sources: [{ nodeId: source.id }, reference],
            settings: {
                directionSourceIndex: 1,
                directionSourceId: source.id,
                directionSourceKind: "edge",
                threshold: 2,
            },
            visible: true,
        });
        await doc.analyses.evaluate(node);
        expect(node.error).toBeUndefined();
        expect(doc.analyses.result(node)?.overlays).toHaveLength(6);
    } finally {
        edges.forEach((edge) => edge.dispose());
    }
});

test("a planar direction normal uses inverse transpose under nonuniform scale", async () => {
    const target = new SourceNode({ document: doc, name: "Target" });
    target.shape = factory.rect(Plane.XY, 10, 10);
    doc.modelManager.rootNode.add(target);
    const direction = new SourceNode({ document: doc, name: "Oblique plane" });
    direction.shape = factory.rect(
        new Plane({ origin: XYZ.zero, normal: new XYZ(1, 0, 1).normalize()!, xvec: XYZ.unitY }),
        2,
        2,
    );
    direction.transform = Matrix4.fromScale(2, 1, 1);
    doc.modelManager.rootNode.add(direction);
    const node = doc.analyses.add({
        name: "Draft",
        kind: "draft",
        sources: [{ nodeId: target.id }, { nodeId: direction.id }],
        settings: {
            directionSourceIndex: 1,
            directionSourceId: direction.id,
            directionSourceKind: "face",
            threshold: 60,
        },
        visible: true,
    });
    await doc.analyses.evaluate(node);
    expect(node.error).toBeUndefined();
    expect(new Set((doc.analyses.result(node)?.overlays?.[0] as FaceMeshData).color as number[])).toEqual(
        new Set([43 / 255, 173 / 255, 75 / 255]),
    );
});
