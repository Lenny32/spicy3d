// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    EditableShapeNode,
    GroupNode,
    I18n,
    type IFace,
    Matrix4,
    Plane,
    ShapeNode,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { registerBasicInspectAnalyses } from "../../app/src/analysis/basic";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";
import { AnalysisPanel } from "../../ui/src/project/analysisPanel";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
const factory = createTestFactory();
let doc: TestDocument;
beforeEach(() => {
    rs.stubGlobal("shapeFactory", factory);
    doc = new TestDocument();
    registerBasicInspectAnalyses(doc.analyses);
});
afterEach(() => {
    doc.dispose();
    rs.unstubAllGlobals();
});
function box(name: string, x: number, size = 10) {
    const node = new SourceNode({ document: doc, name });
    node.shape = factory.box(Plane.XY, size, size, size);
    node.transform = Matrix4.fromTranslation(x, 0, 0);
    doc.modelManager.rootNode.add(node);
    return node;
}
async function analyze(kind: string, nodes: SourceNode[], settings: Record<string, unknown> = {}) {
    const node = doc.analyses.add({
        name: kind,
        kind,
        sources: nodes.map((source) => ({ nodeId: source.id })),
        settings,
        visible: false,
    });
    node.visible = true;
    await doc.analyses.evaluate(node);
    return node;
}

test.each([
    [25, 15],
    [10, 0],
    [5, 0],
])("exact box minimum distance at displacement %s is %s", async (x, expected) => {
    const first = box("first", 0);
    const second = box("second", x);
    const node = await analyze("measure", [first, second]);
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const result = doc.analyses.result(node);
    expect(Number(result?.rows?.[0].value)).toBeCloseTo(expected, 7);
    expect(result?.overlays).toHaveLength(1);
    const positions = result?.overlays?.[0].position;
    expect(positions).toHaveLength(6);
    if (!positions) throw new Error("Expected distance witness");
    expect(
        new XYZ(positions[0], positions[1], positions[2]).distanceTo(
            new XYZ(positions[3], positions[4], positions[5]),
        ),
    ).toBeCloseTo(expected, 5);
});

test.each([
    [25, "No volumetric overlap"],
    [10, "No volumetric overlap"],
])("exact interference at displacement %s reports %s without changing solids", async (x, expected) => {
    const first = box("first", 0);
    const second = box("second", x);
    const before = [first.shape.value, second.shape.value];
    const node = await analyze("interference", [first, second]);
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const rows = doc.analyses.result(node)?.rows;
    expect(rows).toHaveLength(1);
    expect(rows?.[0].value).toBe(expected);
    expect(first.shape.value).toBe(before[0]);
    expect(second.shape.value).toBe(before[1]);
    expect(first.shape.value.volume()).toBeCloseTo(1000, 6);
    expect(second.shape.value.volume()).toBeCloseTo(1000, 6);
});

test("mixed densities weight world centers and nested scaling changes volume", async () => {
    const first = box("first", 0);
    const second = box("second", 20);
    const node = await analyze("centerOfMass", [first, second], {
        densities: { [first.id]: 1, [second.id]: 3 },
    });
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const marker = doc.analyses.result(node)?.marker;
    expect(marker).not.toBeUndefined();
    if (!marker) throw new Error("Expected center marker");
    expect(new XYZ(marker).distanceTo(new XYZ(20, 5, 5))).toBeLessThan(1e-7);
    const group = new GroupNode({ document: doc, name: "Scaled" });
    group.transform = Matrix4.fromScale(2, 2, 2);
    doc.modelManager.rootNode.add(group);
    first.parent?.remove(first);
    group.add(first);
    const scaled = await analyze("centerOfMass", [first]);
    expect(scaled.status).toBe("ready");
    const result = doc.analyses.result(scaled);
    expect(result?.marker).not.toBeUndefined();
    if (!result?.marker) throw new Error("Expected scaled marker");
    expect(new XYZ(result.marker).distanceTo(new XYZ(10, 10, 10))).toBeLessThan(1e-7);
    expect(Number(result?.rows?.find((row) => row.label === "Volume (mm³)")?.value)).toBeCloseTo(8000, 6);
});

test.each([0, -1, NaN, Infinity])("invalid density %s is rejected", async (density) => {
    const node = await analyze("centerOfMass", [box("first", 0)], { density });
    expect(node.status).toBe("invalid");
    expect(node.error).toContain("Density");
    expect(doc.analyses.result(node)).toBeUndefined();
});

test("mass query rejects an open planar face even after translating it away from the origin", () => {
    const face = unwrapOk(factory.rect(Plane.XY, 10, 10));
    const translated = face.transformedMul(Matrix4.fromTranslation(0, 0, 10));
    try {
        expect(translated.inspectionMass).toBeTypeOf("function");
        expect(translated.inspectionMass?.().isOk).toBe(false);
    } finally {
        translated.dispose();
        face.dispose();
    }
});

test("rotated nested boxes have the exact common volume", async () => {
    const first = box("first", 0);
    const second = box("second", 5);
    const parent = new GroupNode({ document: doc, name: "Rotation" });
    const c = Math.SQRT1_2;
    parent.transform = Matrix4.fromArray([c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 13, 7, 2, 1]);
    doc.modelManager.rootNode.add(parent);
    first.parent?.remove(first);
    second.parent?.remove(second);
    parent.add(first, second);
    const node = await analyze("interference", [first, second]);
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const rows = doc.analyses.result(node)?.rows;
    expect(rows).toHaveLength(1);
    expect(Number.parseFloat(rows?.[0].value ?? "NaN")).toBeCloseTo(500, 6);
    expect(rows?.[0].value).toContain("mm³ overlap");
    expect(first.shape.value.volume()).toBeCloseTo(1000, 6);
    expect(second.shape.value.volume()).toBeCloseTo(1000, 6);
});

test("unequal solids produce the analytic volume-weighted center rather than the bounding-box midpoint", async () => {
    const first = box("large", 0, 10);
    const second = box("small", 20, 5);
    const node = await analyze("centerOfMass", [first, second]);
    expect(node.error).toBeUndefined();
    expect(node.status).toBe("ready");
    const marker = doc.analyses.result(node)?.marker;
    expect(marker).not.toBeUndefined();
    if (!marker) throw new Error("Expected center marker");
    expect(marker.x).toBeCloseTo((1000 * 5 + 125 * 22.5) / 1125, 7);
    expect(marker.y).toBeCloseTo((1000 * 5 + 125 * 2.5) / 1125, 7);
    expect(marker.z).toBeCloseTo(marker.y, 7);
    expect(Math.abs(marker.x - 12.5)).toBeGreaterThan(5);
});

test("measure units and precision convert values while keeping geometric witness coordinates in millimetres", async () => {
    const first = box("first", 0);
    const second = box("second", 35.4);
    const node = await analyze("measure", [first, second], { unit: "in", precision: 2 });
    expect(node.error).toBeUndefined();
    const result = doc.analyses.result(node);
    expect(result?.rows?.[0].label).toContain("in");
    expect(result?.rows?.[0].value).toBe("1.00");
    const positions = result?.overlays?.[0].position;
    expect(positions).toHaveLength(6);
    if (!positions) throw new Error("Expected witness");
    expect(
        new XYZ(positions[0], positions[1], positions[2]).distanceTo(
            new XYZ(positions[3], positions[4], positions[5]),
        ),
    ).toBeCloseTo(25.4, 5);
});

test("circle measure reports circumference, radius, and diameter in the chosen units", async () => {
    const source = new SourceNode({ document: doc, name: "Circle" });
    source.shape = factory.circle(XYZ.unitZ, XYZ.zero, 25.4);
    doc.modelManager.rootNode.add(source);
    const node = await analyze("measure", [source], { unit: "in", precision: 4 });
    expect(node.error).toBeUndefined();
    const rows = doc.analyses.result(node)?.rows;
    expect(rows?.find((row) => row.label === "Radius (in)")?.value).toBe("1.0000");
    expect(rows?.find((row) => row.label === "Diameter (in)")?.value).toBe("2.0000");
    expect(Number(rows?.find((row) => row.label === "Length (in)")?.value)).toBeCloseTo(2 * Math.PI, 4);
});

test("linear edge and planar face pairs report ninety-degree angles", async () => {
    const sources = [
        factory.line(XYZ.zero, new XYZ(10, 0, 0)),
        factory.line(XYZ.zero, new XYZ(0, 10, 0)),
        factory.rect(Plane.XY, 10, 10),
        factory.rect(Plane.YZ, 10, 10),
    ].map((shape, index) => {
        const node = new SourceNode({ document: doc, name: `source${index}` });
        node.shape = shape;
        doc.modelManager.rootNode.add(node);
        return node;
    });
    const edges = await analyze("measure", sources.slice(0, 2));
    expect(edges.error).toBeUndefined();
    expect(
        Number(doc.analyses.result(edges)?.rows?.find((row) => row.label.includes("angle"))?.value),
    ).toBeCloseTo(90, 5);
    const faces = await analyze("measure", sources.slice(2, 4));
    expect(faces.error).toBeUndefined();
    expect(
        Number(doc.analyses.result(faces)?.rows?.find((row) => row.label.includes("angle"))?.value),
    ).toBeCloseTo(90, 5);
});

test("overlap extraction creates an inspectable body and participates in undo/redo", async () => {
    const first = box("A", 0),
        second = box("B", 5);
    const analysis = await analyze("interference", [first, second]);
    expect(analysis.error).toBeUndefined();
    const panel = new AnalysisPanel(analysis);
    document.body.append(panel);
    try {
        const extract = Array.from(panel.querySelectorAll("button")).find(
            (button) => button.textContent === I18n.translate("analysis.panel.extract"),
        );
        expect(extract).not.toBeUndefined();
        if (!extract) throw new Error("Missing extraction action");
        extract.click();
        const inserted = doc.modelManager.findNode((node) => node.name === "Overlap");
        expect(inserted).toBeInstanceOf(EditableShapeNode);
        if (!(inserted instanceof EditableShapeNode)) throw new Error("Expected editable overlap");
        expect(unwrapOk(inserted.shape).volume()).toBeCloseTo(500, 6);
        const resolved = doc.analyses.resolveSource({ nodeId: inserted.id });
        expect(resolved.isOk).toBe(true);
        if (!resolved.isOk) throw new Error(resolved.error);
        resolved.value.dispose();
        doc.history.undo();
        expect(doc.modelManager.findNode((node) => node.id === inserted.id)).toBeUndefined();
        doc.history.redo();
        expect(doc.modelManager.findNode((node) => node.id === inserted.id)).toBe(inserted);
    } finally {
        panel.remove();
    }
});

test("face-defined section uses inverse transpose for a nonuniformly transformed plane", async () => {
    const source = new SourceNode({ document: doc, name: "Oblique face" });
    source.shape = factory.box(
        new Plane({ origin: XYZ.zero, normal: new XYZ(1, 0, 1).normalize()!, xvec: XYZ.unitY }),
        10,
        20,
        30,
    );
    source.transform = Matrix4.fromScale(2, 1, 1);
    doc.modelManager.rootNode.add(source);
    const planes: Plane[] = [];
    doc.visual.context.acquireAnalysisClip = (_owner, plane) => {
        planes.push(plane);
        return () => {};
    };
    const faces = source.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const picked = faces.find((face) => face.normal(0, 0)[1].dot(new XYZ(1, 0, 1).normalize()!) > 0.99);
    expect(picked).not.toBeUndefined();
    if (!picked) throw new Error("Expected aligned box face");
    const reference = unwrapOk(doc.analyses.captureSource(source, picked));
    faces.forEach((face) => face.dispose());
    const analysis = doc.analyses.add({
        name: "Section",
        kind: "section",
        sources: [reference],
        settings: { plane: "face", offset: 0 },
        visible: true,
    });
    await doc.analyses.evaluate(analysis);
    expect(analysis.error).toBeUndefined();
    expect(planes.length).toBeGreaterThan(0);
    const plane = planes.at(-1)!;
    expect(plane.normal.dot(new XYZ(1, 0, 2).normalize()!)).toBeCloseTo(1, 7);
    expect(plane.normal.dot(plane.xvec)).toBeCloseTo(0, 7);
});
