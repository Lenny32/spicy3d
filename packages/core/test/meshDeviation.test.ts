// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type DeviationMesh, Matrix4, measureMeshDeviation } from "../src";

function square(z = 0): DeviationMesh {
    return { position: new Float32Array([0, 0, z, 10, 0, z, 10, 10, z, 0, 0, z, 10, 10, z, 0, 10, z]) };
}
const plane: DeviationMesh = { position: new Float32Array([-100, -100, 0, 1000, -100, 0, -100, 1000, 0]) };

describe("mesh deviation", () => {
    afterEach(() => {
        rs.restoreAllMocks();
    });

    test.each([0, 2, -3])("measures constant planar gap %s in millimetres", async (offset) => {
        const result = await measureMeshDeviation(square(offset), square(), { sampleCount: 128 });
        expect(result.isOk).toBe(true);
        expect(result.value.unit).toBe("mm");
        expect(result.value.sampleCount).toBe(128);
        expect(result.value.direction).toBe("model-to-reference");
        expect(result.value.meanDeviation).toBeCloseTo(Math.abs(offset), 10);
        expect(result.value.rmsDeviation).toBeCloseTo(Math.abs(offset), 10);
        expect(result.value.maxSampledDeviation).toBeCloseTo(Math.abs(offset), 10);
    });

    test("finds nearest points inside triangles rather than nearest vertices", async () => {
        const model = { position: new Float32Array([200, 200, 3, 210, 200, 3, 200, 210, 3]) };
        const reference = { position: new Float32Array([0, 0, 0, 1000, 0, 0, 0, 1000, 0]) };
        const result = await measureMeshDeviation(model, reference, { sampleCount: 64 });
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(3, 10);
        expect(result.value.worstSample.closestPoint.z).toBe(0);
        expect(result.value.worstSample.closestPoint.x).toBeCloseTo(result.value.worstSample.point.x, 10);
        expect(result.value.worstSample.closestPoint.y).toBeCloseTo(result.value.worstSample.point.y, 10);
    });

    test.each(["edge", "vertex"])("includes nearest %s regions", async (region) => {
        const model = {
            position: new Float32Array(
                region === "edge" ? [-1, 1, 0, -1, 2, 0, -2, 1, 0] : [-1, -1, 0, -1, -2, 0, -2, -1, 0],
            ),
        };
        const result = await measureMeshDeviation(model, square(), { sampleCount: 128 });
        expect(result.isOk).toBe(true);
        const { point, closestPoint } = result.value.worstSample;
        expect(closestPoint.x).toBeCloseTo(0, 10);
        expect(closestPoint.y).toBeCloseTo(region === "edge" ? point.y : 0, 10);
        expect(result.value.maxSampledDeviation).toBeCloseTo(point.distanceTo(closestPoint), 10);
    });

    test("area weighting does not give a small triangle the same weight as a large one", async () => {
        const model = {
            position: new Float32Array([0, 0, 1, 2, 0, 1, 0, 1, 1, 100, 0, 3, 106, 0, 3, 100, 1, 3]),
        };
        const result = await measureMeshDeviation(model, plane, { sampleCount: 400 });
        expect(result.isOk).toBe(true);
        expect(result.value.meanDeviation).toBeCloseTo(2.5, 10);
        expect(result.value.rmsDeviation).toBeCloseTo(Math.sqrt(7), 10);
        expect(result.value.maxSampledDeviation).toBeCloseTo(3, 10);
    });

    test("uses reflected/nonuniformly scaled world coordinates and ignores winding", async () => {
        const model = {
            ...square(),
            transform: Matrix4.fromScale(-2, 3, 1).multiply(Matrix4.fromTranslation(10, 20, 4)),
        };
        const forward = await measureMeshDeviation(model, plane, { sampleCount: 64 });
        const reversed = await measureMeshDeviation(
            model,
            { ...plane, index: new Uint32Array([0, 2, 1]) },
            { sampleCount: 64 },
        );
        expect(forward.isOk).toBe(true);
        expect(reversed.isOk).toBe(true);
        expect(forward.value.rmsDeviation).toBeCloseTo(4, 10);
        expect(reversed.value.rmsDeviation).toBeCloseTo(forward.value.rmsDeviation, 10);
        expect(forward.value.worstSample.point.x).toBeGreaterThanOrEqual(-10);
        expect(forward.value.worstSample.point.x).toBeLessThanOrEqual(10);
        expect(forward.value.worstSample.point.y).toBeGreaterThanOrEqual(20);
    });

    test("sampling is deterministic without changing input arrays", async () => {
        const model = square(2);
        const original = Array.from(model.position);
        const first = await measureMeshDeviation(model, plane, { sampleCount: 97 });
        const second = await measureMeshDeviation(model, plane, { sampleCount: 97 });
        expect(first.isOk).toBe(true);
        expect(second.isOk).toBe(true);
        expect(second.value).toEqual(first.value);
        expect(Array.from(model.position)).toEqual(original);
    });

    test("rotates both surfaces before measuring the gap", async () => {
        const transform = Matrix4.fromAxisRad({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, Math.PI / 2);
        const result = await measureMeshDeviation(
            { ...square(2), transform },
            { ...square(), transform },
            { sampleCount: 64 },
        );
        expect(result.isOk).toBe(true);
        expect(result.value.rmsDeviation).toBeCloseTo(2, 10);
        expect(result.value.worstSample.point.y).toBeCloseTo(-2, 10);
        expect(result.value.worstSample.closestPoint.y).toBeCloseTo(0, 10);
    });

    test("processes a 100000-triangle scan with its full reference geometry", async () => {
        const coordinates = new Float32Array(100000 * 9);
        for (let i = 0; i < 100000; i++) {
            const x = (i % 316) * 2;
            const y = Math.floor(i / 316) * 2;
            coordinates.set([x, y, 0, x + 1, y, 0, x, y + 1, 0], i * 9);
        }
        const model = { position: new Float32Array([246.1, 444.1, 2, 246.3, 444.1, 2, 246.1, 444.3, 2]) };
        const result = await measureMeshDeviation(model, { position: coordinates }, { sampleCount: 128 });
        expect(result.isOk).toBe(true);
        expect(result.value.referenceTriangleCount).toBe(100000);
        expect(result.value.rmsDeviation).toBeCloseTo(2, 10);
    });

    test("reports a sampled maximum that can miss a very small high-deviation patch", async () => {
        const model = {
            position: new Float32Array([
                0, 0, 0, 10, 0, 0, 0, 10, 0, 100, 0, 20, 100.001, 0, 20, 100, 0.001, 20,
            ]),
        };
        const result = await measureMeshDeviation(model, plane, { sampleCount: 1 });
        expect(result.isOk).toBe(true);
        expect(result.value.maxSampledDeviation).toBeCloseTo(0, 10);
        expect(result.value.modelTriangleCount).toBe(2);
        expect(result.value.accuracy).toContain("not a continuous maximum or Hausdorff distance");
    });

    test("compares coarse curved-surface faceting without claiming an exact CAD error bound", async () => {
        const octant = { position: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
        const result = await measureMeshDeviation(octant, octant, { sampleCount: 64 });
        expect(result.isOk).toBe(true);
        expect(result.value.maxSampledDeviation).toBeCloseTo(0, 10);
        // The vertices lie on the unit sphere; an interior tessellation sample does not.
        expect(result.value.worstSample.point.length()).toBeLessThan(1);
        expect(result.value.accuracy).toContain("current tessellation");
        expect(result.value.accuracy).toContain("no certified CAD-surface error bound");
    });

    test("BVH searches all reference triangles, including a distant indexed tile", async () => {
        const positions: number[] = [];
        for (let x = 0; x < 40; x++)
            for (let y = 0; y < 40; y++) {
                positions.push(x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y, 0, x + 1, y + 1, 0, x, y + 1, 0);
            }
        const reference = {
            position: new Float32Array(positions),
            index: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
        };
        const model = { position: new Float32Array([31.1, 27.1, 2, 31.4, 27.1, 2, 31.1, 27.4, 2]) };
        const result = await measureMeshDeviation(model, reference, { sampleCount: 32 });
        expect(result.isOk).toBe(true);
        expect(result.value.referenceTriangleCount).toBe(3200);
        expect(result.value.rmsDeviation).toBeCloseTo(2, 10);
    });

    test.each([
        ["incomplete triangles", { position: new Float32Array([0, 0, 0, 1, 0, 0]) }],
        ["empty mesh", { position: new Float32Array() }],
        ["non-finite positions", { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0]) }],
        ["bad indices", { ...square(), index: new Uint32Array([0, 1, 999]) }],
        ["degenerate triangles", { position: new Float32Array(9) }],
    ])("rejects %s", async (_label, mesh) => {
        const result = await measureMeshDeviation(mesh as DeviationMesh, plane, { sampleCount: 4 });
        expect(result.isOk).toBe(false);
        expect(typeof result.error).toBe("string");
    });

    test.each([0, 1.5, 65537, Number.NaN])("rejects invalid sample count %s", async (sampleCount) => {
        const result = await measureMeshDeviation(square(), plane, { sampleCount });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("sampleCount");
    });

    test("refuses an already cancelled request", async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await measureMeshDeviation(square(), plane, { signal: controller.signal });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("cancelled");
    });

    test("cancellation yields during BVH construction, before querying samples", async () => {
        const count = 8000;
        const coordinates = new Float32Array(count * 9);
        for (let i = 0; i < count; i++) coordinates.set([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0], i * 9);
        const controller = new AbortController();
        let clock = 0;
        rs.spyOn(performance, "now").mockImplementation(() => ++clock);
        // Initial input checks/mesh conversion use fewer than 15 clock calls; the BVH does not.
        const pending = measureMeshDeviation(
            square(2),
            { position: coordinates },
            { signal: controller.signal },
        );
        const timer = setTimeout(() => controller.abort(), 0);
        try {
            const result = await pending;
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("cancelled");
            expect(clock).toBeLessThan(100);
        } finally {
            clearTimeout(timer);
        }
    });

    test("stops when the processing time budget is exceeded", async () => {
        let clock = 0;
        rs.spyOn(performance, "now").mockImplementation(() => (clock += 2));
        const result = await measureMeshDeviation(square(), plane, { timeBudgetMs: 1 });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("budget exceeded");
    });

    test("can cancel during sample queries after a small BVH has already been built", async () => {
        const controller = new AbortController();
        let clock = 0;
        rs.spyOn(performance, "now").mockImplementation(() => ++clock);
        const pending = measureMeshDeviation(square(2), square(), {
            sampleCount: 65536,
            signal: controller.signal,
        });
        const timer = setTimeout(() => controller.abort(), 0);
        try {
            const result = await pending;
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("cancelled");
            expect(clock).toBeGreaterThanOrEqual(9);
            expect(clock).toBeLessThan(100);
        } finally {
            clearTimeout(timer);
        }
    });
});
