// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IEdge,
    type IFace,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    type TrackedShape,
    XYZ,
} from "@spicy3d/core";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureEdgeRef } from "../src/features/edgeRef";
import type { LoftFeatureData } from "../src/features/feature";
import { capturePathReference } from "../src/features/pathReferences";
import { captureProjectionTarget } from "../src/features/projectionTargetReferences";
import { isReusableTopologyIdentity } from "../src/features/reusableTopologyIdentity";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch";
import {
    guidedRectangle as rectangle,
    setupGuidedLoft as setup,
    guidedVertical as vertical,
} from "./_helpers/guidedLoft";

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
afterEach(() => {
    rs.restoreAllMocks();
});
const faceIds = (body: ParametricBodyNode) =>
    body.shape.value.findSubShapes(ShapeTypes.face).map((shape, index) => {
        shape.dispose();
        return body.faceIdAt(index);
    });
const edgeIds = (body: ParametricBodyNode) =>
    body.shape.value.findSubShapes(ShapeTypes.edge).map((shape, index) => {
        shape.dispose();
        return body.edgeIdAt(index);
    });

test("guided loft deferred validation never runs a synchronous TS analyzer", () => {
    expect(shapeFactory.loftGuidedTracked).not.toBeUndefined();
    const original = shapeFactory.loftGuidedTracked!.bind(shapeFactory);
    const checks: Array<ReturnType<typeof rs.spyOn<IShape, "checkSelfIntersection">>> = [];
    rs.spyOn(shapeFactory, "loftGuidedTracked").mockImplementation((...args) => {
        const result = original(...args);
        if (result.isOk) checks.push(rs.spyOn(result.value.shape, "checkSelfIntersection"));
        return result;
    });
    const { body } = setup();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(checks).toHaveLength(1);
    expect(checks[0]).not.toHaveBeenCalled();
});

test("guided loft derives distinct reusable identities from genuine sketch ancestry", () => {
    const { body } = setup();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(1200, 5);
    const faces = faceIds(body);
    const edges = edgeIds(body);
    expect(faces).toHaveLength(6);
    expect(new Set(faces).size).toBe(faces.length);
    expect(new Set(edges).size).toBe(edges.length);
    expect(faces.every(isReusableTopologyIdentity)).toBe(true);
    expect(edges.every(isReusableTopologyIdentity)).toBe(true);
});

test("compatible upstream boundary and section edits retain a downstream picked edge", () => {
    const { first, last, boundary, feature, body } = setup();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    const beforeFaces = faceIds(body).sort();
    const beforeEdges = edgeIds(body).sort();
    const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) => edge.ends()[0].z === 0 && edge.ends()[1].z === 0);
    expect(index).toBeGreaterThanOrEqual(0);
    const ref = captureEdgeRef(edges[index], body.edgeIdAt(index));
    for (const edge of edges) edge.dispose();
    body.setFeaturesEmitShapeChanged([
        feature,
        { id: "chamfer", type: "chamfer", distance: 0.2, edges: [ref] },
    ]);
    expect(body.shape.isOk, body.shape.error).toBe(true);
    boundary.setDataEmitShapeChanged(vertical(6));
    first.setDataEmitShapeChanged(rectangle(6));
    last.setDataEmitShapeChanged(rectangle(6));
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(body.shape.value.checkShape()).toBe(true);
    expect(body.features[1]).toMatchObject({ edges: [{ edgeId: ref.edgeId }] });
    body.setFeaturesEmitShapeChanged([body.features[0]]);
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(1320, 5);
    expect(faceIds(body).sort()).toEqual(beforeFaces);
    expect(edgeIds(body).sort()).toEqual(beforeEdges);
});

test.each(["c0", "c1"] as const)("guided loft rejects unsupported continuity %s", (continuity) => {
    const { body, feature } = setup();
    body.setFeaturesEmitShapeChanged([{ ...feature, continuity }]);
    expect(body.shape.isOk).toBe(false);
    expect(body.featureItems()[0].error).toMatch(/C2 only/);
});

test("malformed guided inputs report a feature error without dependency traversal throwing", () => {
    const { body, feature } = setup();
    body.setFeaturesEmitShapeChanged([{ ...feature, guided: {} as NonNullable<LoftFeatureData["guided"]> }]);
    expect(body.shape.isOk).toBe(false);
    expect(body.featureItems()[0].error).toMatch(/spine and boundary/);
});

function alterHistory(alter: (result: TrackedShape) => void) {
    const native = shapeFactory.loftGuidedTracked;
    if (!native) throw new Error("Native guided loft is required");
    return rs.spyOn(shapeFactory, "loftGuidedTracked").mockImplementation((...args) => {
        const result = native.apply(shapeFactory, args);
        if (result.isOk) alter(result.value);
        return result;
    });
}

test.each([
    [
        "odd pair",
        (result: TrackedShape) => {
            result.pipeHistory?.faceEdges.push(0);
        },
    ],
    [
        "output range",
        (result: TrackedShape) => {
            result.pipeHistory?.faceEdges.push(9999, 0);
        },
    ],
    [
        "input range",
        (result: TrackedShape) => {
            result.pipeHistory?.faceEdges.push(0, 9999);
        },
    ],
    [
        "cap range",
        (result: TrackedShape) => {
            result.capFaces?.push(9999);
        },
    ],
    [
        "edge map range",
        (result: TrackedShape) => {
            result.edgeMap[0] = 9999;
        },
    ],
] as const)("malformed native history %s fails with an explicit ancestry error", (_label, alter) => {
    alterHistory(alter);
    const { body } = setup();
    expect(body.shape.isOk).toBe(false);
    expect(body.featureItems()[0].error).toMatch(/ancestry|boundary index/);
});

test.each([
    false,
    true,
])("missing or indistinguishable side history is ephemeral (duplicate=%s)", (duplicate) => {
    alterHistory((result) => {
        const history = result.pipeHistory;
        if (!history) throw new Error("History required");
        history.faceVertices = [];
        history.faceEdges = duplicate
            ? Array.from({ length: result.faceMap.length }, (_, index) => [index, 0]).flat()
            : [];
    });
    const { body } = setup();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    const faces = faceIds(body);
    expect(faces.filter(isReusableTopologyIdentity)).toHaveLength(2);
    const ephemeral = faces.filter((id) => id?.startsWith("untracked:"));
    expect(ephemeral).toHaveLength(4);
    expect(new Set(ephemeral).size).toBe(4);
    expect(edgeIds(body).every((id) => id?.startsWith("untracked:"))).toBe(true);
});

test("host placement participates in guided loft cache identity on explicit rebuild", () => {
    const { body } = setup();
    expect(body.shape.isOk).toBe(true);
    const original = body.shape.value.geometryBoundingBox();
    body.transform = Matrix4.fromTranslation(3, 0, 0);
    const rebuilt = body["generateShape"]();
    expect(rebuilt.isOk, rebuilt.error).toBe(true);
    expect(rebuilt.value.geometryBoundingBox().max.x).toBeCloseTo(original.max.x - 3, 5);
    expect(rebuilt.value.volume()).toBeCloseTo(1200, 5);
});

test("a projected guide reads the host state entering its guided loft and host edits cannot loop", () => {
    const { document, first, last, spine, feature } = setup();
    const source = new SketchNode({
        document,
        plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: vertical(5),
    });
    document.modelManager.addNode(source);
    const host = new ParametricBodyNode({
        document,
        features: [{ id: "support", type: "extrude", sketchId: first.id, depth: 20 }],
    });
    document.modelManager.addNode(host);
    expect(host.shape.isOk).toBe(true);
    const faces = host.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex(
        (face) =>
            Math.abs(face.geometryBoundingBox().min.y - 3) < 1e-6 &&
            Math.abs(face.geometryBoundingBox().max.y - 3) < 1e-6,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    for (const face of faces) face.dispose();
    const target = captureProjectionTarget(host, index);
    expect(target.isOk).toBe(true);
    const projection = new ParametricBodyNode({
        document,
        features: [
            {
                id: "projectedGuide",
                type: "projection",
                source: { nodeId: source.id, edges: [capturePathReference(source, 0).value] },
                target: target.value,
                direction: XYZ.unitY,
            },
        ],
    });
    document.modelManager.addNode(projection);
    expect(projection.shape.isOk, projection.shape.error).toBe(true);
    const originalParent = projection.parent;
    expect(originalParent).not.toBeUndefined();
    const guideRef = capturePathReference(projection, 0);
    expect(guideRef.isOk).toBe(true);
    const guided: LoftFeatureData = {
        ...feature,
        id: "consumingLoft",
        guided: {
            spine: { nodeId: spine.id, edges: [capturePathReference(spine, 0).value] },
            boundary: { nodeId: projection.id, edges: [guideRef.value] },
        },
    };
    host.setFeaturesEmitShapeChanged([...host.features, guided]);
    expect(host.shape.isOk, host.shape.error).toBe(true);
    expect(host.consumingFeatureIndex(projection.id)).toBe(1);
    const before = projection.edgeIdAt(0);
    const rebuild = rs.spyOn(projection as unknown as { generateShape(): unknown }, "generateShape");
    first.setDataEmitShapeChanged(rectangle(6));
    last.setDataEmitShapeChanged(rectangle(6));
    source.setDataEmitShapeChanged(vertical(6));
    expect(host.shape.isOk, host.shape.error).toBe(true);
    expect(host.shape.value.volume()).toBeCloseTo(1320, 5);
    expect(projection.shape.isOk, projection.shape.error).toBe(true);
    expect(projection.edgeIdAt(0)).toBe(before);
    expect(rebuild.mock.calls.length).toBeGreaterThan(0);
    expect(rebuild.mock.calls.length).toBeLessThan(20);
    expect(projection.parent).toBe(originalParent);
});

test("separate logical spine and boundary anchors re-anchor without crossing groups", () => {
    const { body, first, last, spine, boundary, feature } = setup();
    spine.setDataEmitShapeChanged({
        entities: [
            { id: 11, type: "line", params: [0, 0, 0, -10] },
            { id: 12, type: "line", params: [0, -10, 0, -20] },
        ],
        constraints: [],
    });
    body.setFeaturesEmitShapeChanged([
        {
            ...feature,
            guided: {
                spine: {
                    nodeId: spine.id,
                    edges: [capturePathReference(spine, 0).value, capturePathReference(spine, 1).value],
                },
                boundary: { nodeId: boundary.id, edges: [capturePathReference(boundary, 0).value] },
            },
        },
    ]);
    expect(body.featureItems()[0].error).toBeUndefined();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    first.setDataEmitShapeChanged(rectangle(6));
    last.setDataEmitShapeChanged(rectangle(6));
    boundary.setDataEmitShapeChanged(vertical(6));
    expect(body.featureItems()[0].error).toBeUndefined();
    expect(body.shape.isOk, body.shape.error).toBe(true);
    const updated = body.features[0] as LoftFeatureData;
    expect(updated.guided?.spine.edges).toHaveLength(2);
    expect(updated.guided?.boundary.edges).toHaveLength(1);
    expect(updated.guided?.spine.edges.map((edge) => edge.edgeId)).toEqual([
        `sketch:${spine.id}:path:ent11`,
        `sketch:${spine.id}:path:ent12`,
    ]);
    expect(updated.guided?.boundary.edges[0]).toMatchObject({
        edgeId: `sketch:${boundary.id}:path:ent11`,
        start: { x: 6 },
        end: { x: 6 },
    });
});

test("section entity order changes retain actual semantic output identities", () => {
    const { body, first } = setup();
    expect(body.shape.isOk).toBe(true);
    const beforeFaces = faceIds(body).sort();
    const beforeEdges = edgeIds(body).sort();
    first.setDataEmitShapeChanged({ ...rectangle(5), entities: [...rectangle(5).entities].reverse() });
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(faceIds(body).sort()).toEqual(beforeFaces);
    expect(edgeIds(body).sort()).toEqual(beforeEdges);
});
