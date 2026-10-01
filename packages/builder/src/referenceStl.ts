// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Mesh, Result } from "@spicy3d/core";

/** STL has no units. Decode triangles directly, independent of OCCT. */
export function parseReferenceStl(buffer: ArrayBuffer, scale = 1): Result<Mesh> {
    try {
        const view = new DataView(buffer);
        let positions: Float32Array;
        // Binary headers may start with "solid"; the exact record count disambiguates them.
        const count = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
        if (count > 0 && 84 + count * 50 === buffer.byteLength) {
            positions = new Float32Array(count * 9);
            for (let triangle = 0; triangle < count; triangle++) {
                for (let coordinate = 0; coordinate < 9; coordinate++) {
                    positions[triangle * 9 + coordinate] =
                        view.getFloat32(84 + triangle * 50 + 12 + coordinate * 4, true) * scale;
                }
            }
        } else {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
            if (!/^solid(?:\s|$)/i.test(text)) return Result.err("Invalid or truncated STL");
            const lines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            if (!/^endsolid(?:\s|$)/i.test(lines.at(-1) ?? "")) return Result.err("Missing STL endsolid");
            const numbers: number[] = [];
            let cursor = 1;
            const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
            const vertex = new RegExp(`^vertex\\s+(${number})\\s+(${number})\\s+(${number})$`, "i");
            const facet = new RegExp(`^facet\\s+normal\\s+${number}\\s+${number}\\s+${number}$`, "i");
            while (cursor < lines.length - 1) {
                if (!facet.test(lines[cursor++]) || !/^outer\s+loop$/i.test(lines[cursor++])) {
                    return Result.err("Invalid STL facet");
                }
                for (let i = 0; i < 3; i++) {
                    const match = vertex.exec(lines[cursor++] ?? "");
                    if (!match) return Result.err("STL facets must contain three finite vertices");
                    numbers.push(
                        Number(match[1]) * scale,
                        Number(match[2]) * scale,
                        Number(match[3]) * scale,
                    );
                }
                if (!/^endloop$/i.test(lines[cursor++]) || !/^endfacet$/i.test(lines[cursor++])) {
                    return Result.err("Invalid STL facet ending");
                }
            }
            positions = new Float32Array(numbers);
        }
        if (positions.length === 0 || !positions.every(Number.isFinite)) {
            return Result.err("STL contains no triangles or non-finite coordinates");
        }
        // Recompute geometric normals: scans commonly have absent/incorrect facet normals.
        const normals = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 9) {
            const ax = positions[i + 3] - positions[i];
            const ay = positions[i + 4] - positions[i + 1];
            const az = positions[i + 5] - positions[i + 2];
            const bx = positions[i + 6] - positions[i];
            const by = positions[i + 7] - positions[i + 1];
            const bz = positions[i + 8] - positions[i + 2];
            const x = ay * bz - az * by;
            const y = az * bx - ax * bz;
            const z = ax * by - ay * bx;
            const length = Math.hypot(x, y, z);
            if (!Number.isFinite(length)) return Result.err("STL contains a degenerate triangle");
            if (length === 0) continue; // Keep scan geometry; zero-area facets have no normal.
            for (let j = 0; j < 9; j += 3) normals.set([x / length, y / length, z / length], i + j);
        }
        return Result.ok(new Mesh({ meshType: "surface", position: positions, normal: normals }));
    } catch {
        return Result.err("Invalid or truncated STL");
    }
}
