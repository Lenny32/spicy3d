// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, Matrix4, Plane, Result, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { captureEdgeRef } from "../src/features/edgeRef";
import type { FaceSweepFeatureData } from "../src/features/feature";
import { capturePathReference } from "../src/features/pathReferences";
import { captureProjectionTarget } from "../src/features/projectionTargetReferences";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";
import "../src/features/faceSweep";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });
function square(half = 1): SketchData {
    return {
        entities: [
            { id: 31, type: "line", params: [-half, -half, half, -half] },
            { id: 32, type: "line", params: [half, -half, half, half] },
            { id: 33, type: "line", params: [half, half, -half, half] },
            { id: 34, type: "line", params: [-half, half, -half, -half] },
        ],
        constraints: [],
    };
}
export function fixture(operation: "join" | "cut" = "join") {
    const document = new TestDocument({ application: createMockApplication() });
    document.visual = createMockVisualWithDocument(document);
    const circle = new SketchNode({
        document,
        plane: Plane.XY,
        data: { entities: [{ id: 7, type: "circle", params: [0, 0, 10] }], constraints: [] },
    });
    const section = new SketchNode({
        document,
        plane: new Plane({ origin: p(10, 0, 5), normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: square(),
    });
    const path = new SketchNode({
        document,
        plane: new Plane({ origin: p(0, 0, 5), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: { entities: [{ id: 11, type: "arc", params: [0, 0, 10, 0, 0, 10] }], constraints: [] },
    });
    for (const node of [circle, section, path]) document.modelManager.addNode(node);
    const body = new ParametricBodyNode({
        document,
        features: [{ id: "cylinder", type: "extrude", sketchId: circle.id, depth: 20 }],
    });
    document.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    const supportIndex = (body.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
        (face) => !face.surface().isPlanar(),
    );
    expect(supportIndex).toBeGreaterThanOrEqual(0);
    const feature: FaceSweepFeatureData = {
        id: "rib",
        type: "faceSweep",
        operation,
        section: { sketchId: section.id },
        path: { nodeId: path.id, edges: [capturePathReference(path, 0).value] },
        support: captureProjectionTarget(body, supportIndex).value,
    };
    body.setFeaturesEmitShapeChanged([...body.features, feature]);
    return { document, circle, section, path, body, feature };
}
const faceIds = (body: ParametricBodyNode) =>
    body.shape.value
        .findSubShapes(ShapeTypes.face)
        .map((_, index) => body.faceIdAt(index))
        .sort();
const edgeIds = (body: ParametricBodyNode) =>
    body.shape.value
        .findSubShapes(ShapeTypes.edge)
        .map((_, index) => body.edgeIdAt(index))
        .sort();

describe("associative groove/rib on a face", () => {
    test.each([
        "join",
        "cut",
    ] as const)("a cylindrical-wall %s has real material change and preserved support input", (operation) => {
        const { body } = fixture(operation);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(
            (2000 + (operation === "join" ? 10.5 : -9.5)) * Math.PI,
            3,
        );
        const input = body.timelineStateAt(1)?.shape;
        expect(input).not.toBeUndefined();
        expect(input?.volume()).toBeCloseTo(2000 * Math.PI, 5);
        expect(faceIds(body).some((id) => id?.includes("rib:face-sweep:"))).toBe(true);
    });
    test("profile edits retain semantic face/edge IDs and support-height edits recompute the boolean", () => {
        const { section, body } = fixture();
        expect(body.shape.isOk).toBe(true);
        const faces = faceIds(body),
            edges = edgeIds(body);
        const firstVolume = body.shape.value.volume();
        section.setDataEmitShapeChanged(square(0.5));
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeLessThan(firstVolume);
        expect(faceIds(body)).toEqual(faces);
        expect(edgeIds(body)).toEqual(edges);
        body.setFeaturesEmitShapeChanged([
            { ...body.features[0], depth: 30 } as (typeof body.features)[0],
            body.features[1],
        ]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(3000 * Math.PI);
        expect(faceIds(body)).toEqual(faces);
    });
    test("a tracked path angle edit changes the rib while a downstream fillet keeps its reference", () => {
        const { path, body } = fixture();
        expect(body.shape.isOk).toBe(true);
        const faces = faceIds(body),
            edges = edgeIds(body);
        const before = body.shape.value.volume();
        const topology = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = topology.findIndex(
            (edge) =>
                edge.ends().every((point) => Math.hypot(point.x, point.y) > 10.5) &&
                edge.ends()[1].sub(edge.ends()[0]).isParallelTo(XYZ.unitZ),
        );
        expect(index).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(topology[index], body.edgeIdAt(index));
        path.setDataEmitShapeChanged({
            entities: [{ id: 11, type: "arc", params: [0, 0, 10, 0, -5, Math.sqrt(75)] }],
            constraints: [],
        });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(before);
        expect(faceIds(body)).toEqual(faces);
        expect(edgeIds(body)).toEqual(edges);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "fillet", type: "fillet", radius: 0.1, edges: [ref] },
        ]);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        path.setDataEmitShapeChanged({
            entities: [{ id: 11, type: "arc", params: [0, 0, 10, 0, -10 / Math.sqrt(2), 10 / Math.sqrt(2)] }],
            constraints: [],
        });
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.features[2]).toMatchObject({ edges: [{ edgeId: ref.edgeId }] });
    });
    test("a path that leaves its referenced trimmed wall fails instead of silently projecting", () => {
        const { path, body } = fixture();
        path.setDataEmitShapeChanged({
            entities: [{ id: 11, type: "arc", params: [0, 0, 11, 0, 0, 11] }],
            constraints: [],
        });
        expect(body.featureItems()[1].error).toMatch(/p-curve|trimmed support|authored/);
    });
    test("host placement participates in the cache key for an explicit rebuild", () => {
        const { body, path, section } = fixture();
        expect(body.shape.isOk).toBe(true);
        const matrix = Matrix4.fromTranslation(3, 4, 5);
        const host = rs.spyOn(body, "worldTransform").mockReturnValue(matrix);
        const source = rs.spyOn(path, "worldTransform").mockReturnValue(matrix);
        const profile = rs.spyOn(section, "worldTransform").mockReturnValue(matrix);
        try {
            const rebuilt = body["generateShape"]();
            expect(rebuilt.isOk).toBe(true);
            expect(rebuilt.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
        } finally {
            host.mockRestore();
            source.mockRestore();
            profile.mockRestore();
        }
    });
    test("ambiguous native copy history is rejected while retaining the last valid shape", () => {
        const { body, section } = fixture();
        const previous = body.shape.value;
        const copy = shapeFactory.copyTracked!;
        const invalid = rs.spyOn(shapeFactory, "copyTracked").mockImplementation((shape) => {
            const result = copy.call(shapeFactory, shape);
            expect(result.isOk).toBe(true);
            if (!result.isOk) return result;
            const faceMap = [...result.value.faceMap];
            faceMap[1] = faceMap[0];
            return Result.ok({ ...result.value, faceMap });
        });
        try {
            section.setDataEmitShapeChanged(square(0.5));
            expect(invalid).toHaveBeenCalled();
            expect(body.featureItems()[1].error).toBe("Face sweep entering body ancestry is incomplete");
            expect(body.shape.value).toBe(previous);
        } finally {
            invalid.mockRestore();
        }
    });
    test("nonfinite material overlap is rejected before a boolean result can be accepted", () => {
        const { body, section } = fixture();
        const previous = body.shape.value;
        const common = shapeFactory.booleanCommon;
        const invalid = rs.spyOn(shapeFactory, "booleanCommon").mockImplementation((left, right) => {
            const result = common.call(shapeFactory, left, right);
            expect(result.isOk).toBe(true);
            if (result.isOk) result.value.volume = () => Number.NaN;
            return result;
        });
        try {
            section.setDataEmitShapeChanged(square(0.5));
            expect(invalid).toHaveBeenCalled();
            expect(body.featureItems()[1].error).toMatch(/does not attach.*intersect/);
            expect(body.shape.value).toBe(previous);
        } finally {
            invalid.mockRestore();
        }
    });
    test("a projected path on its own support host refreshes from the entering timeline without cache loops", () => {
        const { document, body } = fixture();
        body.setFeaturesEmitShapeChanged(body.features.slice(0, 1));
        const source = new SketchNode({
            document,
            plane: new Plane({ origin: p(0, 0, 10), normal: XYZ.unitX, xvec: XYZ.unitY }),
            data: { entities: [{ id: 42, type: "line", params: [1, 0, 3, 0] }], constraints: [] },
        });
        document.modelManager.addNode(source);
        const supportIndex = (body.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
            (face) => !face.surface().isPlanar(),
        );
        const support = captureProjectionTarget(body, supportIndex).value;
        const projected = new ParametricBodyNode({
            document,
            features: [
                {
                    id: "projection",
                    type: "projection",
                    source: { nodeId: source.id, edges: [capturePathReference(source, 0).value] },
                    target: support,
                    direction: XYZ.unitX,
                },
            ],
        });
        document.modelManager.addNode(projected);
        expect(projected.shape.isOk).toBe(true);
        const edge = projected.shape.value.findSubShapes(ShapeTypes.edge)[0] as IEdge;
        const start = edge.ends()[0];
        const curve = edge.curve;
        const first = curve.d1(curve.firstParameter());
        const tangent = first.point.isEqualTo(start) ? first.vec : curve.d1(curve.lastParameter()).vec;
        const normal = tangent.normalize();
        expect(normal).not.toBeUndefined();
        if (!normal) throw new Error("Projected curve has no tangent");
        const section = new SketchNode({
            document,
            plane: new Plane({ origin: start, normal, xvec: XYZ.unitZ }),
            data: square(0.3),
        });
        document.modelManager.addNode(section);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "projectedRib",
                type: "faceSweep",
                operation: "join",
                section: { sketchId: section.id },
                path: { nodeId: projected.id, edges: [capturePathReference(projected, 0).value] },
                support,
            },
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        expect(body.shape.isOk).toBe(true);
        const ids = projected.shape.value
            .findSubShapes(ShapeTypes.edge)
            .map((_, index) => projected.edgeIdAt(index));
        const build = rs.spyOn(shapeFactory, "faceSweepTracked");
        try {
            const previous = body.shape.value.volume();
            body.setFeaturesEmitShapeChanged([
                { ...body.features[0], depth: 30 } as (typeof body.features)[0],
                body.features[1],
            ]);
            expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
            expect(body.shape.value.volume() - previous).toBeCloseTo(1000 * Math.PI, 3);
            expect(
                projected.shape.value
                    .findSubShapes(ShapeTypes.edge)
                    .map((_, index) => projected.edgeIdAt(index)),
            ).toEqual(ids);
            const calls = build.mock.calls.length;
            expect(calls).toBeGreaterThan(0);
            for (let i = 0; i < 5; ++i) {
                expect(body.shape.isOk).toBe(true);
                expect(projected.shape.isOk).toBe(true);
            }
            expect(build.mock.calls).toHaveLength(calls);
            expect(Math.min(Math.abs(start.y - 1), Math.abs(start.y - 3))).toBeLessThan(1e-6);
            const extended = Math.abs(start.y - 1) < 1e-6 ? [1, 0, 4, 0] : [0.5, 0, 3, 0];
            source.setDataEmitShapeChanged({
                entities: [{ id: 42, type: "line", params: extended }],
                constraints: [],
            });
            expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
            expect(body.shape.value.volume()).toBeGreaterThan(previous + 1000 * Math.PI);
            expect(
                projected.shape.value
                    .findSubShapes(ShapeTypes.edge)
                    .map((_, index) => projected.edgeIdAt(index)),
            ).toEqual(ids);
        } finally {
            build.mockRestore();
        }
    });
});
