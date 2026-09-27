// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@spicy3d/core";

export interface ShapeDescriptor {
    volume: number;
    area: number;
    inertia: [number, number, number];
    radial: number[];
}

/** Principal covariance eigenvalues and a radial histogram are invariant to rigid placement. */
export function describeShape(shape: IShape): Result<ShapeDescriptor> {
    const positions = shape.mesh.faces?.position;
    if (!positions || positions.length < 9) return Result.err("Shape has no inspectable surface mesh");
    if (positions.some((coordinate) => !Number.isFinite(coordinate)))
        return Result.err("Surface mesh contains nonfinite coordinates");
    const count = positions.length / 3;
    const center = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        center[0] += positions[i];
        center[1] += positions[i + 1];
        center[2] += positions[i + 2];
    }
    for (let i = 0; i < 3; i++) center[i] /= count;
    const covariance = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    const radii: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
        const delta = [positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]];
        radii.push(Math.hypot(...delta));
        for (let row = 0; row < 3; row++)
            for (let col = 0; col < 3; col++) covariance[row][col] += (delta[row] * delta[col]) / count;
    }
    const rms = Math.sqrt(radii.reduce((sum, radius) => sum + radius * radius, 0) / count);
    if (!Number.isFinite(rms) || !(rms > 0)) return Result.err("Shape descriptor has zero or invalid extent");
    const radial = Array(8).fill(0) as number[];
    for (const radius of radii) radial[Math.min(7, Math.floor((radius / rms) * 4))] += 1 / count;
    const inertia = eigenvaluesSymmetric3(covariance).map((value) => value / (rms * rms)) as [
        number,
        number,
        number,
    ];
    const properties = shape.inspectionMass?.();
    if (!properties) return Result.err("Guarded solid mass query is unavailable");
    if (!properties.isOk) return Result.err(properties.error);
    const volume = properties.value.volume;
    if (!Number.isFinite(volume) || volume <= 0)
        return Result.err("Only closed positive-volume solids can be indexed");
    const faces = shape.findSubShapes(ShapeTypes.face);
    let area = 0;
    try {
        for (const face of faces) area += (face as IShape & { area(): number }).area();
    } finally {
        faces.forEach((face) => face.dispose());
    }
    if (
        !Number.isFinite(area) ||
        area <= 0 ||
        inertia.some((value) => !Number.isFinite(value)) ||
        radial.some((value) => !Number.isFinite(value))
    )
        return Result.err("Shape descriptor is nonfinite");
    return Result.ok({ volume, area, inertia, radial });
}

function eigenvaluesSymmetric3(matrix: number[][]): number[] {
    const values = matrix.map((row) => [...row]);
    for (let iteration = 0; iteration < 24; iteration++) {
        const pairs: Array<[number, number]> = [
            [0, 1],
            [0, 2],
            [1, 2],
        ];
        const [p, q] = pairs.reduce((best, pair) =>
            Math.abs(values[pair[0]][pair[1]]) > Math.abs(values[best[0]][best[1]]) ? pair : best,
        );
        if (Math.abs(values[p][q]) < 1e-12) break;
        const theta = 0.5 * Math.atan2(2 * values[p][q], values[q][q] - values[p][p]);
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const rotation = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ];
        rotation[p][p] = c;
        rotation[q][q] = c;
        rotation[p][q] = s;
        rotation[q][p] = -s;
        const intermediate = Array.from({ length: 3 }, () => [0, 0, 0]);
        const result = Array.from({ length: 3 }, () => [0, 0, 0]);
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 3; k++) {
                    intermediate[i][j] += values[i][k] * rotation[k][j];
                }
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 3; k++) {
                    result[i][j] += rotation[k][i] * intermediate[k][j];
                }
        for (let i = 0; i < 3; i++) values[i] = result[i];
    }
    return [values[0][0], values[1][1], values[2][2]].sort((left, right) => right - left);
}

export function similarityScoreParts(
    query: ShapeDescriptor,
    candidate: ShapeDescriptor,
    scaleInvariant: boolean,
): { size: number; covariance: number; radial: number; total: number } {
    const logarithmic = (left: number, right: number) =>
        Math.abs(Math.log(Math.max(left, 1e-12) / Math.max(right, 1e-12)));
    const size = scaleInvariant
        ? 0
        : logarithmic(query.volume, candidate.volume) / 3 + logarithmic(query.area, candidate.area) / 2;
    const covariance =
        query.inertia.reduce((sum, value, index) => sum + Math.abs(value - candidate.inertia[index]), 0) * 2;
    const radial = query.radial.reduce(
        (sum, value, index) => sum + Math.abs(value - candidate.radial[index]),
        0,
    );
    return { size, covariance, radial, total: size + covariance + radial };
}

export function similarityScore(
    query: ShapeDescriptor,
    candidate: ShapeDescriptor,
    scaleInvariant: boolean,
): number {
    return similarityScoreParts(query, candidate, scaleInvariant).total;
}
