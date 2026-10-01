// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation";
import { Matrix4, XYZ } from "../math";

export interface DeviationMesh {
    readonly position: Float32Array;
    readonly index?: Uint32Array;
    readonly transform?: Matrix4;
}

export interface MeshDeviationOptions {
    readonly sampleCount?: number;
    readonly timeBudgetMs?: number;
    readonly signal?: AbortSignal;
}

export interface MeshDeviationResult {
    readonly unit: "mm";
    readonly direction: "model-to-reference";
    readonly sampling: "deterministic-area-weighted";
    readonly sampleCount: number;
    readonly modelTriangleCount: number;
    readonly referenceTriangleCount: number;
    readonly meanDeviation: number;
    readonly rmsDeviation: number;
    /** Largest sampled value, NOT the continuous maximum or Hausdorff distance. */
    readonly maxSampledDeviation: number;
    readonly worstSample: { point: XYZ; closestPoint: XYZ };
    readonly accuracy: string;
}

type TriangleData = {
    coordinates: Float64Array;
    cumulativeArea: Float64Array;
    count: number;
    skipped: number;
};
type Bounds = [number, number, number, number, number, number];
type BvhNode = { bounds: Bounds; start: number; end: number; left?: BvhNode; right?: BvhNode };
const MAX_TRIANGLES = 1_000_000;

/** Exact nearest triangles, approximate sampling of the model's tessellated surface. No kernel calls. */
export async function measureMeshDeviation(
    model: DeviationMesh,
    reference: DeviationMesh,
    options: MeshDeviationOptions = {},
): Promise<Result<MeshDeviationResult>> {
    const sampleCount = options.sampleCount ?? 4096;
    const budget = options.timeBudgetMs ?? 15000;
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 65536)
        return Result.err("sampleCount must be an integer from 1 to 65536");
    if (!Number.isFinite(budget) || budget < 1 || budget > 60000)
        return Result.err("timeBudgetMs must be from 1 to 60000");
    const started = performance.now();
    let lastYield = started;
    let work = 0;
    const checkpoint = async () => {
        if (options.signal?.aborted) throw new Error("Deviation measurement cancelled");
        const now = performance.now();
        if (now - started > budget)
            throw new Error("Deviation time budget exceeded; reduce samples or increase timeBudgetMs");
        if (now - lastYield >= 8) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
            if (options.signal?.aborted) throw new Error("Deviation measurement cancelled");
        }
    };
    try {
        await checkpoint();
        const source = await triangles(model, checkpoint);
        const target = await triangles(reference, checkpoint);
        if (source.cumulativeArea.at(-1) === 0) throw new Error("Model mesh has no non-degenerate triangles");
        const ids = Array.from({ length: target.count }, (_, i) => i);
        const build = async (start: number, end: number): Promise<BvhNode> => {
            const bounds: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (let i = start; i < end; i++) {
                const offset = ids[i] * 9;
                for (let vertex = 0; vertex < 3; vertex++) {
                    for (let axis = 0; axis < 3; axis++) {
                        const value = target.coordinates[offset + vertex * 3 + axis];
                        bounds[axis] = Math.min(bounds[axis], value);
                        bounds[axis + 3] = Math.max(bounds[axis + 3], value);
                    }
                }
                if ((++work & 2047) === 0) await checkpoint();
            }
            const node: BvhNode = { bounds, start, end };
            if (end - start <= 8) return node;
            let axis = 0;
            for (let i = 1; i < 3; i++) {
                if (bounds[i + 3] - bounds[i] > bounds[axis + 3] - bounds[axis]) axis = i;
            }
            const midpoint = (bounds[axis] + bounds[axis + 3]) / 2;
            let split = start;
            for (let i = start; i < end; i++) {
                const offset = ids[i] * 9 + axis;
                const centroid =
                    (target.coordinates[offset] +
                        target.coordinates[offset + 3] +
                        target.coordinates[offset + 6]) /
                    3;
                if (centroid < midpoint) {
                    [ids[i], ids[split]] = [ids[split], ids[i]];
                    split++;
                }
                if ((++work & 2047) === 0) await checkpoint();
            }
            // Identical centroids still need a balanced tree; no triangle is dropped.
            if (split === start || split === end) split = start + Math.floor((end - start) / 2);
            node.left = await build(start, split);
            node.right = await build(split, end);
            return node;
        };
        const root = await build(0, target.count);
        let sum = 0;
        let sumSquared = 0;
        let maximum = -1;
        let worstSample = { point: XYZ.zero, closestPoint: XYZ.zero };
        let triangle = 0;
        const area = source.cumulativeArea.at(-1)!;
        for (let sample = 0; sample < sampleCount; sample++) {
            const targetArea = ((sample + 0.5) / sampleCount) * area;
            while (triangle < source.count - 1 && source.cumulativeArea[triangle] <= targetArea) triangle++;
            const [a, b, c] = vertices(source.coordinates, triangle);
            const u = Math.sqrt(radicalInverse(sample + 1, 2));
            const v = radicalInverse(sample + 1, 3);
            const point = a
                .multiply(1 - u)
                .add(b.multiply(u * (1 - v)))
                .add(c.multiply(u * v));
            let closestPoint = XYZ.zero;
            let distanceSquared = Infinity;
            const stack = [root];
            while (stack.length) {
                const node = stack.pop()!;
                if (boundsDistance(point, node.bounds) > distanceSquared) continue;
                if (node.left && node.right) {
                    const leftDistance = boundsDistance(point, node.left.bounds);
                    const rightDistance = boundsDistance(point, node.right.bounds);
                    if (leftDistance < rightDistance) stack.push(node.right, node.left);
                    else stack.push(node.left, node.right);
                } else {
                    for (let i = node.start; i < node.end; i++) {
                        const [ta, tb, tc] = vertices(target.coordinates, ids[i]);
                        const candidate = closestTrianglePoint(point, ta, tb, tc);
                        const distance = candidate.sub(point).lengthSq();
                        if (distance < distanceSquared) {
                            distanceSquared = distance;
                            closestPoint = candidate;
                        }
                    }
                }
                if ((++work & 2047) === 0) await checkpoint();
            }
            const distance = Math.sqrt(distanceSquared);
            if (!Number.isFinite(distance)) throw new Error("Deviation distance overflow");
            sum += distance;
            sumSquared += distanceSquared;
            if (distance > maximum) {
                maximum = distance;
                worstSample = { point, closestPoint };
            }
            if ((sample & 127) === 0) await checkpoint();
        }
        await checkpoint();
        return Result.ok({
            unit: "mm",
            direction: "model-to-reference",
            sampling: "deterministic-area-weighted",
            sampleCount,
            modelTriangleCount: source.count,
            referenceTriangleCount: target.count,
            meanDeviation: sum / sampleCount,
            rmsDeviation: Math.sqrt(sumSquared / sampleCount),
            maxSampledDeviation: maximum,
            worstSample,
            accuracy:
                `Skipped ${source.skipped} zero-area model triangles for sampling; retained ${target.skipped} zero-area reference triangles for nearest-point search. ` +
                "Unsigned sampled distances to reference triangles. Model uses its current tessellation; no certified CAD-surface error bound. Maximum is sampled, not a continuous maximum or Hausdorff distance. Reference regions absent from the model are not measured.",
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : "Deviation measurement failed");
    }
}

async function triangles(mesh: DeviationMesh, checkpoint: () => Promise<void>): Promise<TriangleData> {
    const positions = mesh.position;
    const count = mesh.index ? mesh.index.length / 3 : positions.length / 9;
    if (positions.length % 3 !== 0 || !Number.isInteger(count) || count < 1 || count > MAX_TRIANGLES)
        throw new Error("Expected triangle mesh with 1–1000000 triangles");
    const transform = mesh.transform ?? Matrix4.identity();
    const coordinates = new Float64Array(count * 9);
    const cumulativeArea = new Float64Array(count);
    let area = 0;
    let skipped = 0;
    for (let triangle = 0; triangle < count; triangle++) {
        for (let vertex = 0; vertex < 3; vertex++) {
            const index = mesh.index?.[triangle * 3 + vertex] ?? triangle * 3 + vertex;
            if (index * 3 + 2 >= positions.length) throw new Error("Triangle index is out of range");
            const point = transform.ofPoint({
                x: positions[index * 3],
                y: positions[index * 3 + 1],
                z: positions[index * 3 + 2],
            });
            if (![point.x, point.y, point.z].every(Number.isFinite))
                throw new Error("Mesh contains non-finite coordinates or transform");
            coordinates.set([point.x, point.y, point.z], triangle * 9 + vertex * 3);
        }
        const [a, b, c] = vertices(coordinates, triangle);
        const triangleArea = b.sub(a).cross(c.sub(a)).length() / 2;
        if (!Number.isFinite(triangleArea))
            throw new Error("Mesh contains degenerate or non-finite triangles");
        if (triangleArea === 0) skipped++;
        area += triangleArea;
        cumulativeArea[triangle] = area;
        if ((triangle & 2047) === 0) await checkpoint();
    }
    if (!Number.isFinite(area)) throw new Error("Mesh area overflow");
    return { coordinates, cumulativeArea, count, skipped };
}

function vertices(coordinates: Float64Array, triangle: number): [XYZ, XYZ, XYZ] {
    const i = triangle * 9;
    return [
        new XYZ(coordinates[i], coordinates[i + 1], coordinates[i + 2]),
        new XYZ(coordinates[i + 3], coordinates[i + 4], coordinates[i + 5]),
        new XYZ(coordinates[i + 6], coordinates[i + 7], coordinates[i + 8]),
    ];
}

function radicalInverse(index: number, base: number): number {
    let value = 0;
    let factor = 1 / base;
    while (index > 0) {
        value += (index % base) * factor;
        index = Math.floor(index / base);
        factor /= base;
    }
    return value;
}

function boundsDistance(point: XYZ, bounds: Bounds): number {
    let distance = 0;
    const values = [point.x, point.y, point.z];
    for (let axis = 0; axis < 3; axis++) {
        const delta = Math.max(bounds[axis] - values[axis], 0, values[axis] - bounds[axis + 3]);
        distance += delta * delta;
    }
    return distance;
}

/** Closest point in a triangle's face, edges or vertices (unsigned; winding independent). */
function closestTrianglePoint(p: XYZ, a: XYZ, b: XYZ, c: XYZ): XYZ {
    const ab = b.sub(a);
    const ac = c.sub(a);
    if (ab.cross(ac).lengthSq() === 0) {
        const segment = (start: XYZ, end: XYZ) => {
            const direction = end.sub(start);
            const length = direction.lengthSq();
            return length === 0
                ? start
                : start.add(
                      direction.multiply(Math.max(0, Math.min(1, p.sub(start).dot(direction) / length))),
                  );
        };
        return [segment(a, b), segment(a, c), segment(b, c)].reduce((best, point) =>
            point.sub(p).lengthSq() < best.sub(p).lengthSq() ? point : best,
        );
    }
    const ap = p.sub(a);
    const d1 = ab.dot(ap);
    const d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = p.sub(b);
    const d3 = ab.dot(bp);
    const d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.add(ab.multiply(d1 / (d1 - d3)));
    const cp = p.sub(c);
    const d5 = ab.dot(cp);
    const d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.add(ac.multiply(d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
        return b.add(c.sub(b).multiply((d4 - d3) / (d4 - d3 + d5 - d6)));
    const inverse = 1 / (va + vb + vc);
    return a.add(ab.multiply(vb * inverse)).add(ac.multiply(vc * inverse));
}
