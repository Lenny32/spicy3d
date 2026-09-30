// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditableShapeNode, type IEdge, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureEdgeRef } from "../src/features/edgeRef";
import type { SweepFeatureData } from "../src/features/feature";
import { capturePathReference } from "../src/features/pathReferences";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";

const binary = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
beforeAll(async () => {
    await initWasm({ wasmBinary: binary });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const square = (half: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [-half, -half, half, -half] },
        { id: 2, type: "line", params: [half, -half, half, half] },
        { id: 3, type: "line", params: [half, half, -half, half] },
        { id: 4, type: "line", params: [-half, half, -half, -half] },
    ],
    constraints: [],
});
function setup(points = [XYZ.zero, p(0, 0, 10)], options: Partial<SweepFeatureData> = {}) {
    const document = new TestDocument({ application: createMockApplication() });
    document.visual = createMockVisualWithDocument(document) as typeof document.visual;
    const profile = new SketchNode({ document, plane: Plane.XY, data: square(1) });
    document.modelManager.addNode(profile);
    const pathNode = new EditableShapeNode({
        document,
        name: "3D path",
        shape: shapeFactory.combine(
            points.slice(1).map((end, index) => shapeFactory.line(points[index], end).value),
        ).value,
    });
    document.modelManager.addNode(pathNode);
    const edges = pathNode.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const feature: SweepFeatureData = {
        id: "sweep1",
        type: "sweep",
        section: { sketchId: profile.id },
        path: {
            nodeId: pathNode.id,
            edges: edges.map((_, index) => capturePathReference(pathNode, index).value),
        },
        ...options,
    };
    const body = new ParametricBodyNode({ document, features: [feature] });
    document.modelManager.addNode(body);
    return { document, profile, pathNode, feature, body };
}
const faceIds = (body: ParametricBodyNode) =>
    body.shape.value.findSubShapes(ShapeTypes.face).map((_, index) => body.faceIdAt(index));
const edgeIds = (body: ParametricBodyNode) =>
    body.shape.value.findSubShapes(ShapeTypes.edge).map((_, index) => body.edgeIdAt(index));

describe("associative path sweep feature (real kernel)", () => {
    test("builds a tracked solid and follows profile edits with the same semantic face and edge IDs", () => {
        const { profile, body } = setup();
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(40, 5);
        const beforeFaces = faceIds(body).sort();
        const beforeEdges = edgeIds(body).sort();
        expect(beforeFaces.every((id) => id?.startsWith("sweep1:sweep:"))).toBe(true);
        expect(beforeEdges.every((id) => id?.startsWith("sweep1:sweep:"))).toBe(true);
        profile.setDataEmitShapeChanged(square(2));
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(160, 5);
        expect(faceIds(body).sort()).toEqual(beforeFaces);
        expect(edgeIds(body).sort()).toEqual(beforeEdges);
    });

    test.each([
        false,
        true,
    ])("a nonplanar multisegment path has stable semantic junctions (round=%s)", (roundCorner) => {
        const { profile, body } = setup([XYZ.zero, p(0, 0, 10), p(5, 5, 20)], { roundCorner });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        const beforeFaces = faceIds(body).sort();
        const beforeEdges = edgeIds(body).sort();
        profile.setDataEmitShapeChanged(square(0.5));
        expect(body.shape.isOk).toBe(true);
        expect(faceIds(body).sort()).toEqual(beforeFaces);
        expect(edgeIds(body).sort()).toEqual(beforeEdges);
    });

    test("profile entity permutation cannot realign semantic output IDs onto another edge", () => {
        const { profile, body } = setup();
        expect(body.shape.isOk).toBe(true);
        const beforeFaces = faceIds(body).sort();
        const beforeEdges = edgeIds(body).sort();
        profile.setDataEmitShapeChanged({ ...square(1), entities: [...square(1).entities].reverse() });
        expect(body.shape.isOk).toBe(true);
        expect(faceIds(body).sort()).toEqual(beforeFaces);
        expect(edgeIds(body).sort()).toEqual(beforeEdges);
    });

    test("a downstream fillet keeps its picked swept edge after a profile edit", () => {
        const { profile, body, feature } = setup();
        expect(body.shape.isOk).toBe(true);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => edge.ends()[1].sub(edge.ends()[0]).isParallelTo(XYZ.unitZ));
        expect(index).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(edges[index], body.edgeIdAt(index));
        body.setFeaturesEmitShapeChanged([
            feature,
            { id: "fillet1", type: "fillet", radius: 0.2, edges: [ref] },
        ]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        profile.setDataEmitShapeChanged(square(2));
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.features[1]).toMatchObject({ edges: [{ edgeId: ref.edgeId }] });
        expect(body.shape.value.volume()).toBeGreaterThan(150);
    });

    test("rejects hole-bearing sections explicitly", () => {
        const { profile, body } = setup();
        profile.setDataEmitShapeChanged({
            entities: [...square(2).entities, { id: 7, type: "circle", params: [0, 0, 0.5] }],
            constraints: [],
        });
        expect(body.shape.isOk).toBe(false);
        expect(body.shape.error).toMatch(/holes/);
    });
});
