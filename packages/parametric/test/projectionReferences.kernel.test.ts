// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IFace, Matrix4, Plane, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import type { FeatureContext } from "../src/features/feature";
import {
    captureProjectionTarget,
    projectionTargetDependencies,
    resolveProjectionTarget,
} from "../src/features/projectionTargetReferences";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";
const factory = createTestFactory();
beforeAll(() => {
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});
function scene() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    const circle = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 10] }], constraints: [] },
    });
    doc.modelManager.addNode(circle);
    const target = new ParametricBodyNode({
        document: doc,
        id: "projection-target",
        features: [{ id: "cylinder", type: "extrude", sketchId: circle.id, depth: 20 }],
    });
    doc.modelManager.addNode(target);
    expect(target.shape.isOk).toBe(true);
    const faces = target.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => !face.surface().isPlanar());
    expect(index).toBeGreaterThanOrEqual(0);
    const context: FeatureContext = {
        document: doc,
        host: { id: "projection-host", worldTransform: () => Matrix4.identity() },
        scope: new Map(),
    };
    return { doc, circle, target, index, context };
}

test.each([
    "untracked:runtime-face",
    "section-face|untracked:runtime-face",
    "path-ref:authored-face",
])("projection target token %s cannot become claimed reusable native ancestry", (id) => {
    const { target, index, context } = scene();
    const original = target.faceIdAt.bind(target);
    const spy = rs
        .spyOn(target, "faceIdAt")
        .mockImplementation((faceIndex) => (faceIndex === index ? id : original(faceIndex)));
    try {
        const reference = captureProjectionTarget(target, index);
        expect(reference.isOk).toBe(true);
        const result = resolveProjectionTarget(reference.value, context);
        expect(result.isOk).toBe(true);
        try {
            expect(result.value.seed).toBe(id);
            expect(result.value.stableIdentity).toBe(false);
            expect(result.value.face.surface().isPlanar()).toBe(false);
        } finally {
            result.value.dispose();
        }
    } finally {
        spy.mockRestore();
    }
});

test("projection target refs resolve world placement into host space and retain real radius ancestry", () => {
    const { circle, target, index, context } = scene();
    target.transform = Matrix4.fromTranslation(100, 0, 0);
    const captured = captureProjectionTarget(target, index);
    expect(captured.isOk).toBe(true);
    const placed = {
        ...context,
        host: { ...context.host, worldTransform: () => Matrix4.fromTranslation(50, 0, 0) },
    };
    const first = resolveProjectionTarget(captured.value, placed);
    expect(first.isOk).toBe(true);
    expect(first.value.stableIdentity).toBe(true);
    expect(first.value.anchor.id).toBe(target.faceIdAt(index));
    const seed = first.value.seed;
    try {
        expect(first.value.face.geometryBoundingBox().min.x).toBeCloseTo(40, 5);
        expect(first.value.face.geometryBoundingBox().max.x).toBeCloseTo(60, 5);
    } finally {
        first.value.dispose();
    }
    circle.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 12] }],
        constraints: [],
    });
    const edited = resolveProjectionTarget(captured.value, placed);
    expect(edited.isOk).toBe(true);
    try {
        expect(edited.value.seed).toBe(seed);
        expect(edited.value.face.geometryBoundingBox().min.x).toBeCloseTo(38, 5);
    } finally {
        edited.value.dispose();
    }
});

test("projection target refs reject missing, rolled-back and ambiguous input states", () => {
    const { target, index, context } = scene();
    const captured = captureProjectionTarget(target, index);
    expect(captured.isOk).toBe(true);
    const missing = resolveProjectionTarget({ ...captured.value, nodeId: "missing" }, context);
    expect(missing.isOk).toBe(false);
    expect(missing.error).toMatch(/Projection target.*not found/);
    target.setRollbackIndex(0);
    const rolledBack = resolveProjectionTarget(captured.value, context);
    expect(rolledBack.isOk).toBe(false);
    expect(rolledBack.error).toContain("rolled back");
    target.setRollbackIndex(undefined);
    expect(target.shape.isOk).toBe(true);
    const curved = target.shape.value.findSubShapes(ShapeTypes.face)[index] as IFace;
    const copy = curved.clone();
    const duplicate = factory.combine([curved, copy]);
    expect(duplicate.isOk).toBe(true);
    expect(duplicate.value.findSubShapes(ShapeTypes.face)).toHaveLength(2);
    const ambiguousContext = {
        ...context,
        host: target,
        input: duplicate.value,
        tracking: {
            inputFaceIds: ["shared", "shared"],
            inputEdgeIds: [],
            outputFaceIds: [],
            outputEdgeIds: [],
        },
    };
    const ambiguous = resolveProjectionTarget(
        { ...captured.value, nodeId: target.id, face: { ...captured.value.face, id: "shared" } },
        ambiguousContext,
    );
    expect(ambiguous.isOk).toBe(false);
    expect(ambiguous.error).toContain("ambiguous");
    duplicate.value.dispose();
    copy.dispose();
});

test.each([-1, 0.5, 999])("projection capture rejects invalid face index %s", (index) => {
    const { target } = scene();
    const result = captureProjectionTarget(target, index);
    expect(result.isOk).toBe(false);
    expect(result.error).toMatch(/nonnegative integer|out of bounds/);
});

test("projection cache dependencies compare pre-consumption timeline geometry and placement", () => {
    const { doc, target, index, context } = scene();
    const circle = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 1] }], constraints: [] },
    });
    doc.modelManager.addNode(circle);
    const host = new ParametricBodyNode({
        document: doc,
        id: context.host.id,
        features: [{ id: "host-base", type: "extrude", sketchId: circle.id, depth: 5 }],
    });
    doc.modelManager.addNode(host);
    expect(host.shape.isOk).toBe(true);
    const captured = captureProjectionTarget(target, index);
    expect(captured.isOk).toBe(true);
    expect(projectionTargetDependencies(captured.value, doc, host.id).refIds).toEqual([target.id]);
    target.setFeaturesEmitShapeChanged([
        ...target.features,
        { id: "consume", type: "boolean", operation: "fuse", toolIds: [host.id] },
    ]);
    expect(target.shape.isOk).toBe(true);
    const initial = projectionTargetDependencies(captured.value, doc, host.id);
    expect(initial.refIds).toEqual([]);
    expect(typeof initial.key).toBe("string");
    const resolved = resolveProjectionTarget(captured.value, { ...context, host });
    expect(resolved.isOk).toBe(true);
    try {
        expect(resolved.value.seed).toBe(captured.value.face.id);
    } finally {
        resolved.value.dispose();
    }
    target.transform = Matrix4.fromTranslation(5, 0, 0);
    expect(projectionTargetDependencies(captured.value, doc, host.id).key).not.toBe(initial.key);
});
