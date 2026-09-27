// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    ConstructionNode,
    type ConstructionRef,
    captureConstructionRef,
    type IFace,
    type IVertex,
    Plane,
    resolveConstructionRef,
    Serializer,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
const previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (previousFactory) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});

const xyz = (x = 0, y = 0, z = 0) => new XYZ({ x, y, z });
const fixedPoint = (value: XYZ): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "point", point: value },
});
const datum = (node: ConstructionNode): ConstructionRef => ({ kind: "datum", nodeId: node.id });
const rectangle: SketchData = {
    entities: [
        { id: 1, type: "line", params: [10, 0, 20, 0] },
        { id: 2, type: "line", params: [20, 0, 20, 30] },
        { id: 3, type: "line", params: [20, 30, 10, 30] },
        { id: 4, type: "line", params: [10, 30, 10, 0] },
    ],
    constraints: [],
};
function documentFixture() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    return doc;
}

describe("associative construction consumers", () => {
    test("tracked vertex references follow a changed body and keep their captured timeline", () => {
        const doc = documentFixture();
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rectangle });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "base", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        const vertex = (body.shape.unchecked()!.findSubShapes(ShapeTypes.vertex) as IVertex[]).find(
            (item) => item.point().distanceTo(xyz(20, 30, 10)) < 1e-6,
        );
        expect(vertex).not.toBeUndefined();
        const captured = captureConstructionRef(doc, body, vertex!);
        expect(captured.isOk).toBe(true);
        const ref = captured.unchecked()!;
        expect(ref.kind).toBe("shape");
        if (ref.kind !== "shape") throw new Error("Expected tracked vertex reference");
        expect(ref.featureIndex).toBe(1);
        const point = new ConstructionNode({
            document: doc,
            definition: { kind: "point-vertex", vertex: ref },
        });
        doc.modelManager.addNode(point);
        sketch.setDataEmitShapeChanged({
            ...rectangle,
            entities: rectangle.entities.map((entity) => ({
                ...entity,
                params: entity.params.map((value, index) => (index % 2 === 0 ? value + 5 : value)),
            })),
        });
        const moved = point.geometry;
        expect(moved.isOk).toBe(true);
        const geometry = moved.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected tracked point");
        expect(geometry.point.distanceTo(xyz(25, 30, 10))).toBeLessThan(1e-6);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "extend", type: "extrude", sketchId: sketch.id, depth: 20, operation: "fuse" },
        ]);
        expect(body.shape.isOk).toBe(true);
        const anchored = point.geometry.unchecked()!;
        expect(anchored.kind).toBe("point");
        if (anchored.kind !== "point") throw new Error("Expected anchored point");
        expect(anchored.point.z).toBeCloseTo(10);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(20);
        const forward = resolveConstructionRef(doc, { ...ref, featureIndex: 99 });
        expect(forward.isOk).toBe(false);
        expect(String(forward.error)).toMatch(/future|forward|timeline|unavailable|position/i);
        for (const featureIndex of [-1, 0.5]) {
            expect(resolveConstructionRef(doc, { ...ref, featureIndex }).isOk).toBe(false);
        }
    });

    test("a body can consume a sketch on a datum anchored to its earlier feature", () => {
        const doc = documentFixture();
        const baseSketch = new SketchNode({ document: doc, plane: Plane.XY, data: rectangle });
        doc.modelManager.addNode(baseSketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "base", type: "extrude", sketchId: baseSketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        const top = (body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => face.normal(0, 0)[1].z > 0.99,
        );
        expect(top).not.toBeUndefined();
        const captured = captureConstructionRef(doc, body, top!);
        expect(captured.isOk).toBe(true);
        const source = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: captured.unchecked()!, distance: 0 },
        });
        doc.modelManager.addNode(source);
        const attached = new SketchNode({
            document: doc,
            plane: Plane.XY,
            constructionPlaneRef: datum(source),
            data: rectangle,
        });
        doc.modelManager.addNode(attached);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "extend", type: "extrude", sketchId: attached.id, depth: 5, operation: "fuse" },
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(attached.plane.origin.z).toBeCloseTo(10);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(15);
        expect(source.geometry.isOk).toBe(true);
        body.setFeaturesEmitShapeChanged([
            { id: "base", type: "extrude", sketchId: baseSketch.id, depth: 20 },
            body.features[1],
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(attached.plane.origin.z).toBeCloseTo(20);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(25);
        const savedDefinition = source.definitionJson;
        const history = doc.history.undoCount();
        const reference = captured.unchecked()!;
        expect(reference.kind).toBe("shape");
        if (reference.kind !== "shape") throw new Error("Expected face reference");
        source.definition = { kind: "plane-offset", source: { ...reference, featureIndex: 2 }, distance: 0 };
        expect(source.definitionJson).toBe(savedDefinition);
        expect(doc.history.undoCount()).toBe(history);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    });

    test("a datum edit updates an attached sketch and its extrusion before undo and redo", () => {
        const doc = documentFixture();
        const source = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 5 },
        });
        doc.modelManager.addNode(source);
        const plane = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: datum(source), distance: 2 },
        });
        doc.modelManager.addNode(plane);
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            constructionPlaneRef: datum(plane),
            data: rectangle,
        });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(sketch.plane.origin.z).toBeCloseTo(7);
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(7);
        Transaction.execute(doc, "Move source plane", () => {
            source.definition = {
                kind: "plane-offset",
                source: { kind: "origin-plane", plane: "XY" },
                distance: 20,
            };
        });
        expect(sketch.plane.origin.z).toBeCloseTo(22);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(22);
        expect(body.shape.unchecked()!.boundingBox().max.z).toBeCloseTo(32);
        doc.history.undo();
        expect(sketch.plane.origin.z).toBeCloseTo(7);
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(7);
        doc.history.redo();
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(22);
        const restored = Serializer.deserializeObject(doc, Serializer.serializeObject(sketch)) as SketchNode;
        expect(restored.constructionPlaneRef).toEqual(datum(plane));
    });

    test("deleted construction plane invalidates a sketch instead of leaving valid stale geometry", () => {
        const doc = documentFixture();
        const source = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 5 },
        });
        doc.modelManager.addNode(source);
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            constructionPlaneRef: datum(source),
            data: rectangle,
        });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(sketch.shape.isOk).toBe(true);
        Transaction.execute(doc, "Delete source", () => source.parent!.remove(source));
        expect(body.featureItems()[0].error).toMatch(/missing|deleted|invalid/i);
        expect(sketch.shape.isOk).toBe(false);
        expect(String(sketch.shape.error)).toMatch(/missing|deleted|invalid/i);
        doc.history.undo();
        expect(body.featureItems()[0].error).toBeUndefined();
        expect(body.shape.unchecked()!.boundingBox().min.z).toBeCloseTo(5);
        expect(sketch.shape.isOk).toBe(true);
        expect(sketch.plane.origin.z).toBeCloseTo(5);
    });

    test("a lost construction plane badges the sketch warning and clears once restored", () => {
        const doc = documentFixture();
        const source = new ConstructionNode({
            document: doc,
            definition: { kind: "plane-offset", source: { kind: "origin-plane", plane: "XY" }, distance: 5 },
        });
        doc.modelManager.addNode(source);
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            constructionPlaneRef: datum(source),
            data: rectangle,
        });
        doc.modelManager.addNode(sketch);
        expect(sketch.shape.isOk).toBe(true);
        expect(sketch.warningCount).toBe(0);
        expect(sketch.constructionPlaneError).toBeUndefined();
        const warningEvents: number[] = [];
        sketch.onPropertyChanged((property) => {
            if (property === "warningCount") warningEvents.push(sketch.warningCount);
        });

        Transaction.execute(doc, "Delete source", () => source.parent!.remove(source));
        expect(sketch.shape.isOk).toBe(false);
        expect(sketch.warningCount).toBe(1);
        expect(sketch.warningTooltip).toBe("sketch.constructionPlaneInvalid{0}");
        expect(sketch.constructionPlaneError).toMatch(/missing|deleted|invalid/i);
        expect(warningEvents).toEqual([1]);

        doc.history.undo();
        expect(sketch.shape.isOk).toBe(true);
        expect(sketch.warningCount).toBe(0);
        expect(sketch.warningTooltip).toBe("sketch.externalRefsLost{0}");
        expect(sketch.constructionPlaneError).toBeUndefined();
        expect(warningEvents).toEqual([1, 0]);
    });

    test("construction axis edits invalidate a cached revolve and deletion produces an error", () => {
        const doc = documentFixture();
        const first = new ConstructionNode({
            document: doc,
            definition: { kind: "point-vertex", vertex: fixedPoint(XYZ.zero) },
        });
        doc.modelManager.addNode(first);
        const second = new ConstructionNode({
            document: doc,
            definition: { kind: "point-vertex", vertex: fixedPoint(xyz(0, 0, 30)) },
        });
        doc.modelManager.addNode(second);
        const axis = new ConstructionNode({
            document: doc,
            definition: { kind: "axis-two-points", first: datum(first), second: datum(second) },
        });
        doc.modelManager.addNode(axis);
        const sketch = new SketchNode({
            document: doc,
            plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitNY, xvec: XYZ.unitX }),
            data: rectangle,
        });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "revolve",
                    type: "revolve",
                    sketchId: sketch.id,
                    angle: 90,
                    axis: { point: XYZ.zero, direction: XYZ.unitZ },
                    constructionAxisRef: datum(axis),
                },
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.unchecked()!.boundingBox().min.x).toBeCloseTo(0, 4);
        Transaction.execute(doc, "Move axis", () => {
            first.definition = { kind: "point-vertex", vertex: fixedPoint(xyz(5)) };
            second.definition = { kind: "point-vertex", vertex: fixedPoint(xyz(5, 0, 30)) };
        });
        expect(body.shape.isOk).toBe(true);
        const box = body.shape.unchecked()!.boundingBox();
        expect(box.min.x).toBeCloseTo(5, 4);
        expect(Math.max(Math.abs(box.min.y), Math.abs(box.max.y))).toBeCloseTo(15, 4);
        doc.history.undo();
        expect(body.shape.unchecked()!.boundingBox().min.x).toBeCloseTo(0, 4);
        doc.history.redo();
        expect(body.shape.unchecked()!.boundingBox().min.x).toBeCloseTo(5, 4);
        Transaction.execute(doc, "Delete axis", () => axis.parent!.remove(axis));
        expect(body.featureItems()[0].error).toMatch(/missing|deleted|invalid/i);
        doc.history.undo();
        expect(body.featureItems()[0].error).toBeUndefined();
        expect(body.shape.unchecked()!.boundingBox().min.x).toBeCloseTo(5, 4);
    });
});
