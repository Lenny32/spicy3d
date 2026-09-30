// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DocumentRebuilds,
    EditableShapeNode,
    GroupNode,
    KernelState,
    Matrix4,
    Mesh,
    MeshNode,
    measureNodeDeviation,
    Result,
} from "../src";
import { createMockDocument, MockShape, TestDocument } from "../test-utils";

function mesh(z = 0): Mesh {
    return new Mesh({ meshType: "surface", position: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]) });
}

describe("node deviation", () => {
    afterEach(() => {
        KernelState.current.reset();
        rs.unstubAllGlobals();
        rs.restoreAllMocks();
    });

    test("includes hidden nested parent transforms and allows read-only measurement without mutation", async () => {
        const document = new TestDocument();
        document.repository.isReadOnly = () => true;
        const outer = new GroupNode({ document, name: "outer" });
        const inner = new GroupNode({ document, name: "inner" });
        outer.transform = Matrix4.fromTranslation(10, 20, 3);
        inner.transform = Matrix4.fromScale(0.5, 0.5, 1).multiply(Matrix4.fromTranslation(0, 0, 2));
        outer.visible = false;
        const model = new MeshNode({ document, name: "model", mesh: mesh() });
        const reference = new MeshNode({ document, name: "reference", mesh: mesh() });
        reference.transform = Matrix4.fromTranslation(10, 20, 1);
        document.modelManager.addNode(outer, reference);
        outer.add(inner);
        inner.add(model);
        const history = document.history.position();
        rs.stubGlobal("shapeFactory", undefined);
        rs.stubGlobal("shapeConverter", undefined);
        const result = await measureNodeDeviation(model, reference, { sampleCount: 64 });
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(4, 10);
        expect(result.value.worstSample.point.z).toBeCloseTo(5, 10);
        expect(result.value.worstSample.closestPoint.z).toBeCloseTo(1, 10);
        expect(document.history.position()).toEqual(history);
        document.dispose();
    });

    test("demands a CAD rebuild, then reads the settled face tessellation", async () => {
        const document = createMockDocument();
        const oldShape = new MockShape({ id: "old" });
        const shape = new MockShape({ id: "rebuilt" });
        const faces = shape.mesh.faces!;
        for (let i = 2; i < faces.position.length; i += 3) faces.position[i] = 2;
        const model = new EditableShapeNode({ document, name: "model", shape: oldShape });
        const reference = new MeshNode({ document, name: "reference", mesh: mesh() });
        let finish: () => void = () => {};
        const settled = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const release = DocumentRebuilds.add(document, { settled, flush: () => {} });
        const pending = measureNodeDeviation(model, reference, { sampleCount: 16 });
        expect(DocumentRebuilds.pending(document)).toBe(true);
        model.shape = Result.ok(shape);
        release();
        finish();
        const result = await pending;
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(2, 10);
        expect(result.value.modelTriangleCount).toBe(1);
    });

    test("can cancel while waiting for a CAD rebuild", async () => {
        const document = createMockDocument();
        const model = new EditableShapeNode({ document, name: "model", shape: new MockShape() });
        const reference = new MeshNode({ document, name: "reference", mesh: mesh() });
        const release = DocumentRebuilds.add(document, {
            settled: new Promise<void>(() => {}),
            flush: () => {},
        });
        const controller = new AbortController();
        try {
            const pending = measureNodeDeviation(model, reference, { signal: controller.signal });
            controller.abort();
            const result = await pending;
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("cancelled");
        } finally {
            release();
        }
    });

    test("source-unit mistakes remain visible in millimetre distances", async () => {
        const document = createMockDocument();
        const model = new MeshNode({ document, name: "model", mesh: mesh(10) });
        const reference = new MeshNode({ document, name: "reference imported as cm", mesh: mesh(10) });
        reference.transform = Matrix4.fromScale(10, 10, 10);
        const result = await measureNodeDeviation(model, reference, { sampleCount: 32 });
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(90, 10);
        expect(result.value.unit).toBe("mm");
    });

    test("rejects different documents and a reference without triangle surfaces", async () => {
        const document = createMockDocument();
        const model = new MeshNode({ document, name: "model", mesh: mesh() });
        const reference = new MeshNode({ document: createMockDocument(), name: "reference", mesh: mesh() });
        expect((await measureNodeDeviation(model, reference)).isOk).toBe(false);
        const line = new MeshNode({ document, name: "line", mesh: new Mesh({ meshType: "linesegments" }) });
        const invalid = await measureNodeDeviation(model, line);
        expect(invalid.isOk).toBe(false);
        expect(invalid.error).toContain("triangle surface");
        expect((await measureNodeDeviation(model, model)).isOk).toBe(false);
    });

    test("refuses a CAD query after kernel crash while mesh comparison still works", async () => {
        const document = createMockDocument();
        const model = new EditableShapeNode({ document, name: "model", shape: new MockShape() });
        const reference = new MeshNode({ document, name: "reference", mesh: mesh() });
        KernelState.current.markCrashed("test crash");
        const failed = await measureNodeDeviation(model, reference);
        expect(failed.isOk).toBe(false);
        expect(failed.error).toContain("Kernel crashed");
        const meshModel = new MeshNode({ document, name: "mesh model", mesh: mesh(1) });
        const result = await measureNodeDeviation(meshModel, reference, { sampleCount: 8 });
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(1, 10);
    });

    test("refuses a result when geometry changes during sampling", async () => {
        const document = createMockDocument();
        const model = new MeshNode({ document, name: "model", mesh: mesh(2) });
        const reference = new MeshNode({ document, name: "reference", mesh: mesh() });
        let clock = 0;
        rs.spyOn(performance, "now").mockImplementation(() => ++clock);
        const pending = measureNodeDeviation(model, reference, { sampleCount: 2048 });
        const timer = setTimeout(() => {
            reference.transform = Matrix4.fromTranslation(0, 0, 1);
        }, 0);
        try {
            const result = await pending;
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("changed during measurement");
        } finally {
            clearTimeout(timer);
        }
    });
});
