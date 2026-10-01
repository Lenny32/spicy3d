// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EdgeMeshData, type Plane, VisualConfig } from "@spicy3d/core";
import { toWorld } from "./sketchModel";
import { textFramePoints } from "./sketchText";
import { type TextOutlineOptions, textContours } from "./textGeometry";

/** Quadratics are sampled only for the temporary preview; saved curves remain exact. */
export function textOutlineMesh(plane: Plane, options: TextOutlineOptions): EdgeMeshData {
    const position: number[] = [];
    const contours = textContours(options);
    const push = (from: readonly [number, number], to: readonly [number, number]) => {
        const a = toWorld(plane, ...from);
        const b = toWorld(plane, ...to);
        position.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    if (contours.isOk) {
        for (const contour of contours.value) {
            for (const segment of contour) {
                if (segment.length === 2) {
                    push(segment[0], segment[1]);
                    continue;
                }
                const [p0, p1, p2] = segment;
                let previous = p0;
                for (let i = 1; i <= 6; i++) {
                    const t = i / 6;
                    const s = 1 - t;
                    const next: [number, number] = [
                        s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0],
                        s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1],
                    ];
                    push(previous, next);
                    previous = next;
                }
            }
        }
    }
    return {
        position: new Float32Array(position),
        color: VisualConfig.defaultEdgeColor,
        lineType: "solid",
        range: [],
    };
}

export function textFrameMesh(plane: Plane, options: TextOutlineOptions): EdgeMeshData {
    const points = textFramePoints(options);
    const position = points.flatMap((point, index) => {
        const a = toWorld(plane, ...point),
            b = toWorld(plane, ...points[(index + 1) % 4]);
        return [a.x, a.y, a.z, b.x, b.y, b.z];
    });
    return {
        position: new Float32Array(position),
        color: VisualConfig.selectedEdgeColor,
        lineType: "dash",
        range: [],
    };
}
