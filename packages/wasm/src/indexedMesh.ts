// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IndexedMesh } from "@spicy3d/core";
import type { StlMesh } from "./stlWriter";

/** Merge distance relative to the mesh's bounding-box diagonal. */
const RELATIVE_WELD_TOLERANCE = 1e-7;
/** Floor of the merge distance, for tiny parts. */
const MIN_WELD_TOLERANCE = 1e-9;

/**
 * Turns per-face triangle soups into one indexed mesh. OCCT meshes every face on its own, so
 * a vertex on an edge appears once per face (and twice on a seam); merging the vertices that
 * coincide within a tolerance makes a closed solid's mesh watertight. Triangles that collapse
 * to repeated vertices (sphere poles, degenerate edges) are left out. The winding is kept: the
 * mesher already reverses the triangles of reversed faces, so they stay counter-clockwise.
 */
export function weldMeshes(meshes: readonly StlMesh[]): IndexedMesh {
    const tolerance = weldTolerance(meshes);
    const cells = new Map<string, number[]>();
    const vertices: number[] = [];
    const triangles: number[] = [];
    const cellOf = (value: number) => Math.floor(value / tolerance);
    const find = (x: number, y: number, z: number): number => {
        const cx = cellOf(x);
        const cy = cellOf(y);
        const cz = cellOf(z);
        // A point near a cell border can have its twin in the neighbouring cell.
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++) {
                    for (const candidate of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                        const o = candidate * 3;
                        if (
                            Math.abs(vertices[o] - x) <= tolerance &&
                            Math.abs(vertices[o + 1] - y) <= tolerance &&
                            Math.abs(vertices[o + 2] - z) <= tolerance
                        )
                            return candidate;
                    }
                }
        const index = vertices.length / 3;
        vertices.push(x, y, z);
        const key = `${cx},${cy},${cz}`;
        const cell = cells.get(key);
        if (cell) cell.push(index);
        else cells.set(key, [index]);
        return index;
    };

    for (const { position, index } of meshes) {
        const remap = new Map<number, number>();
        const vertexOf = (i: number) => {
            let welded = remap.get(i);
            if (welded === undefined) {
                welded = find(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
                remap.set(i, welded);
            }
            return welded;
        };
        for (let t = 0; t + 2 < index.length; t += 3) {
            const a = vertexOf(index[t]);
            const b = vertexOf(index[t + 1]);
            const c = vertexOf(index[t + 2]);
            if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
        }
    }
    return compact(vertices, triangles);
}

function weldTolerance(meshes: readonly StlMesh[]): number {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const { position } of meshes) {
        for (let i = 0; i + 2 < position.length; i += 3) {
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], position[i + axis]);
                max[axis] = Math.max(max[axis], position[i + axis]);
            }
        }
    }
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return Number.isFinite(diagonal)
        ? Math.max(diagonal * RELATIVE_WELD_TOLERANCE, MIN_WELD_TOLERANCE)
        : MIN_WELD_TOLERANCE;
}

/** Drops the vertices only collapsed triangles used, renumbering the rest in order. */
function compact(vertices: number[], triangles: number[]): IndexedMesh {
    const used = new Int32Array(vertices.length / 3).fill(-1);
    let count = 0;
    for (const vertex of triangles) if (used[vertex] < 0) used[vertex] = count++;
    const packed = new Float64Array(count * 3);
    for (let i = 0; i < used.length; i++) {
        if (used[i] < 0) continue;
        packed.set(vertices.slice(i * 3, i * 3 + 3), used[i] * 3);
    }
    return { vertices: packed, triangles: Uint32Array.from(triangles, (vertex) => used[vertex]) };
}
