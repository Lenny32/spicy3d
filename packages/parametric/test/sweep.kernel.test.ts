// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditableShapeNode, type IEdge, Matrix4, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
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

    test("a sketch path length edit rebuilds geometry and retains downstream fillet ancestry", () => {
        const { document, profile } = setup();
        const path = new SketchNode({
            document,
            plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitY, xvec: XYZ.unitX }),
            data: { entities: [{ id: 11, type: "line", params: [0, 0, 0, -10] }], constraints: [] },
        });
        document.modelManager.addNode(path);
        const feature: SweepFeatureData = {
            id: "trackedSweep",
            type: "sweep",
            section: { sketchId: profile.id },
            path: { nodeId: path.id, edges: [capturePathReference(path, 0).value] },
        };
        const body = new ParametricBodyNode({ document, features: [feature] });
        document.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(40, 5);
        const beforeFaces = faceIds(body).sort();
        const beforeEdges = edgeIds(body).sort();
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => edge.ends()[1].sub(edge.ends()[0]).isParallelTo(XYZ.unitZ));
        expect(index).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(edges[index], body.edgeIdAt(index));
        path.setDataEmitShapeChanged({
            entities: [{ id: 11, type: "line", params: [0, 0, 0, -20] }],
            constraints: [],
        });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(80, 5);
        expect(faceIds(body).sort()).toEqual(beforeFaces);
        expect(edgeIds(body).sort()).toEqual(beforeEdges);
        expect((body.features[0] as SweepFeatureData).path.edges[0].edgeId).toBe(
            `sketch:${path.id}:path:ent11`,
        );
        body.setFeaturesEmitShapeChanged([
            feature,
            { id: "pathFillet", type: "fillet", radius: 0.2, edges: [ref] },
        ]);
        expect(body.shape.isOk).toBe(true);
        path.setDataEmitShapeChanged({
            entities: [{ id: 11, type: "line", params: [0, 0, 0, -30] }],
            constraints: [],
        });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(118);
        expect(body.features[1]).toMatchObject({ edges: [{ edgeId: ref.edgeId }] });
    });

    test("a closed curved sketch path keeps its seam identity through a radius edit", () => {
        const { document } = setup();
        const path = new SketchNode({
            document,
            plane: Plane.XY,
            data: { entities: [{ id: 41, type: "circle", params: [0, 0, 10] }], constraints: [] },
        });
        document.modelManager.addNode(path);
        const edge = path.shape.value.findSubShapes(ShapeTypes.edge)[0] as IEdge;
        const tangent = edge.curve.d1(edge.curve.firstParameter());
        const normal = tangent.vec.normalize();
        expect(normal).not.toBeUndefined();
        if (!normal) throw new Error("Circle tangent is degenerate");
        const section = new SketchNode({
            document,
            plane: new Plane({ origin: tangent.point, normal, xvec: XYZ.unitZ }),
            data: { entities: [{ id: 61, type: "circle", params: [0, 0, 1] }], constraints: [] },
        });
        document.modelManager.addNode(section);
        const body = new ParametricBodyNode({
            document,
            features: [
                {
                    id: "closedSweep",
                    type: "sweep",
                    section: { sketchId: section.id },
                    path: { nodeId: path.id, edges: [capturePathReference(path, 0).value] },
                },
            ],
        });
        document.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(20 * Math.PI ** 2, 4);
        const beforeFaces = faceIds(body).sort();
        const beforeEdges = edgeIds(body).sort();
        path.setDataEmitShapeChanged({
            entities: [{ id: 41, type: "circle", params: [0, 0, 15] }],
            constraints: [],
        });
        section.plane = new Plane({ origin: tangent.point.multiply(1.5), normal, xvec: XYZ.unitZ });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(30 * Math.PI ** 2, 4);
        expect(faceIds(body).sort()).toEqual(beforeFaces);
        expect(edgeIds(body).sort()).toEqual(beforeEdges);
    });

    test("a path body can consume its sweep without circular cache invalidation", () => {
        const { document } = setup();
        const base = new SketchNode({ document, plane: Plane.XY, data: square(5) });
        document.modelManager.addNode(base);
        const source = new ParametricBodyNode({
            document,
            features: [{ id: "sourceExtrude", type: "extrude", sketchId: base.id, depth: 10 }],
        });
        document.modelManager.addNode(source);
        expect(source.shape.isOk).toBe(true);
        const edges = source.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => edge.ends()[1].sub(edge.ends()[0]).isParallelTo(XYZ.unitZ));
        expect(index).toBeGreaterThanOrEqual(0);
        const start = edges[index].ends().find((point) => Math.abs(point.z) < 1e-6);
        expect(start).not.toBeUndefined();
        if (!start) throw new Error("Source vertical edge has no bottom end");
        const section = new SketchNode({
            document,
            plane: new Plane({ origin: start, normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: square(1),
        });
        document.modelManager.addNode(section);
        const tool = new ParametricBodyNode({
            document,
            features: [
                {
                    id: "consumedSweep",
                    type: "sweep",
                    section: { sketchId: section.id },
                    path: { nodeId: source.id, edges: [capturePathReference(source, index).value] },
                },
            ],
        });
        document.modelManager.addNode(tool);
        expect(tool.shape.isOk).toBe(true);
        const ids = faceIds(tool).sort();
        source.setFeaturesEmitShapeChanged([
            ...source.features,
            { id: "consume", type: "boolean", operation: "fuse", toolIds: [tool.id], consumeTools: true },
        ]);
        expect(source.shape.isOk).toBe(true);
        expect(tool.parent).toBe(source);
        expect(tool.shape.isOk).toBe(true);
        expect(tool.shape.value.volume()).toBeCloseTo(40, 5);
        const build = rs.spyOn(shapeFactory, "sweepTracked");
        try {
            for (let i = 0; i < 5; ++i) {
                expect(source.shape.isOk).toBe(true);
                expect(tool.shape.value.volume()).toBeCloseTo(40, 5);
            }
            expect(build).not.toHaveBeenCalled();
            source.setFeaturesEmitShapeChanged([
                { ...source.features[0], depth: 20 } as (typeof source.features)[0],
                source.features[1],
            ]);
            expect(source.shape.isOk).toBe(true);
            expect(source.shape.value.checkShape()).toBe(true);
            expect(tool.shape.isOk).toBe(true);
            expect(tool.shape.value.volume()).toBeCloseTo(80, 5);
            expect(faceIds(tool).sort()).toEqual(ids);
            const calls = build.mock.calls.length;
            expect(calls).toBeGreaterThan(0);
            for (let i = 0; i < 5; ++i) expect(source.shape.isOk).toBe(true);
            expect(build.mock.calls).toHaveLength(calls);
        } finally {
            build.mockRestore();
        }
    });

    test("independent source and host placement produces host-local geometry without moving inputs", () => {
        const { body, profile, pathNode } = setup();
        const sourceMatrix = Matrix4.fromTranslation(10, 20, 30);
        const hostMatrix = Matrix4.fromTranslation(3, 4, 5);
        const sectionTransform = rs.spyOn(profile, "worldTransform").mockReturnValue(sourceMatrix);
        const pathTransform = rs.spyOn(pathNode, "worldTransform").mockReturnValue(sourceMatrix);
        const hostTransform = rs.spyOn(body, "worldTransform").mockReturnValue(hostMatrix);
        try {
            expect(body.shape.isOk).toBe(true);
            const bounds = body.shape.value.boundingBox();
            expect([bounds.min.x, bounds.min.y, bounds.min.z]).toEqual([6, 15, 25]);
            expect([bounds.max.x, bounds.max.y, bounds.max.z]).toEqual([8, 17, 35]);
            expect(body.shape.value.volume()).toBeCloseTo(40, 5);
            const sourceBounds = pathNode.shape.value.boundingBox();
            expect(sourceBounds.min).toEqual({ x: 0, y: 0, z: 0 });
            expect(sourceBounds.max).toEqual({ x: 0, y: 0, z: 10 });
        } finally {
            sectionTransform.mockRestore();
            pathTransform.mockRestore();
            hostTransform.mockRestore();
        }
    });
});

test("an explicit sweep rebuild after host placement changes uses current local coordinates", () => {
    const { body } = setup();
    expect(body.shape.isOk).toBe(true);
    const original = body.shape.value.geometryBoundingBox();
    body.transform = Matrix4.fromTranslation(3, 0, 0);
    const rebuilt = body["generateShape"]();
    expect(rebuilt.isOk).toBe(true);
    expect(rebuilt.value.geometryBoundingBox().max.x).toBeCloseTo(original.max.x - 3, 5);
    expect(rebuilt.value.volume()).toBeCloseTo(40, 5);
});
