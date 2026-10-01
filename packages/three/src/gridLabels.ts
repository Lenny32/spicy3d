// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Plane } from "@spicy3d/core";
import { type Camera, Raycaster, Plane as ThreePlane, Vector2, Vector3 } from "three";

export interface GridLabel {
    text: string;
    x: number;
    y: number;
    z: number;
    axis: "x" | "y";
}

/** Millimetre coordinates on the workplane axes, spaced far enough apart to read. */
export function gridLabels(camera: Camera, plane: Plane, width: number, height: number): GridLabel[] {
    if (width <= 0 || height <= 0) return [];
    camera.updateMatrixWorld();
    const origin = new Vector3().copy(plane.origin);
    const normal = new Vector3().copy(plane.normal);
    const xvec = new Vector3().copy(plane.xvec);
    const yvec = new Vector3().copy(plane.yvec);
    // At the horizon the axis coordinates grow without bound and labels cannot be read.
    if (Math.abs(camera.getWorldDirection(new Vector3()).dot(normal)) < 0.3) return [];
    const surface = new ThreePlane().setFromNormalAndCoplanarPoint(normal, origin);
    const raycaster = new Raycaster();
    const corners: Vector3[] = [];
    for (const x of [-1, 1]) {
        for (const y of [-1, 1]) {
            raycaster.setFromCamera(new Vector2(x, y), camera);
            const point = raycaster.ray.intersectPlane(surface, new Vector3());
            if (!point) return [];
            corners.push(point.sub(origin));
        }
    }
    const project = (point: Vector3) => {
        const ndc = point.project(camera);
        return { x: ((ndc.x + 1) * width) / 2, y: ((1 - ndc.y) * height) / 2, z: ndc.z };
    };
    const center = project(origin.clone());
    const labels: GridLabel[] = [];
    for (const axis of ["x", "y"] as const) {
        const direction = axis === "x" ? xvec : yvec;
        const tick = project(origin.clone().addScaledVector(direction, 50));
        const pixels = Math.hypot(tick.x - center.x, tick.y - center.y);
        if (!Number.isFinite(pixels) || pixels < 1e-6) continue;
        const required = Math.max(1, 65 / pixels);
        const decade = 10 ** Math.floor(Math.log10(required));
        const multiplier = ([1, 2, 5, 10].find((value) => value * decade >= required) ?? 10) * decade;
        const step = 50 * multiplier;
        const coordinates = corners.map((point) => point.dot(direction));
        const start = Math.ceil(Math.min(...coordinates) / step);
        const end = Math.floor(Math.max(...coordinates) / step);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 200) continue;
        for (let index = start; index <= end; index++) {
            if (index === 0) continue;
            const point = project(origin.clone().addScaledVector(direction, index * step));
            const x = point.x + (axis === "y" ? 10 : 0);
            const y = point.y + (axis === "x" ? 12 : 0);
            if (point.z < -1 || point.z > 1 || x < 30 || x > width - 30 || y < 12 || y > height - 12) {
                continue;
            }
            labels.push({ text: String(index * step), x, y, z: point.z, axis });
        }
    }
    return labels;
}
