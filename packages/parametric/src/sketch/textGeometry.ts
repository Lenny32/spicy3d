// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";
import { glyphContours, type OutlineSegment, type Point2 } from "./fonts/fontOutlines";
import { NOTO_SANS } from "./fonts/notoSans.generated";
import { ConstraintKind } from "./sketchModel";
import type { SketchSolver } from "./solver";

/** Command input only: text is baked into existing v3 sketch entities, never serialized. */
export interface TextOutlineOptions {
    value: string;
    x: number;
    y: number;
    height: number;
    angle: number;
}

type TextGeometryError =
    | "error.sketch.invalidTextSize"
    | "error.sketch.unsupportedTextCharacter"
    | "error.sketch.emptyText";

const LINE_PITCH = 1.6;
const contourCache = new Map<string, OutlineSegment[][]>();

/** Exact, closed Noto Sans contours in sketch UV; height measures flat capitals such as H. */
export function textContours(options: TextOutlineOptions): Result<OutlineSegment[][], TextGeometryError> {
    const { value, x, y, height, angle } = options;
    if (![x, y, height, angle].every(Number.isFinite) || height <= 0)
        return Result.err("error.sketch.invalidTextSize");
    const scale = height / NOTO_SANS.capHeight;
    const radians = ((angle % 360) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const result: OutlineSegment[][] = [];
    for (const [row, line] of value.split("\n").entries()) {
        let pen = 0;
        for (const char of line) {
            const glyph = NOTO_SANS.glyphs[char];
            if (glyph === undefined) return Result.err("error.sketch.unsupportedTextCharacter");
            let contours = contourCache.get(char);
            if (contours === undefined) {
                contours = glyphContours(glyph[1]);
                contourCache.set(char, contours);
            }
            const place = ([u, v]: Point2): Point2 => {
                const lx = (u + pen) * scale;
                const ly = (v - row * LINE_PITCH * NOTO_SANS.capHeight) * scale;
                return [x + lx * cos - ly * sin, y + lx * sin + ly * cos];
            };
            for (const contour of contours) {
                result.push(
                    contour.map(
                        (segment): OutlineSegment =>
                            segment.length === 2
                                ? [place(segment[0]), place(segment[1])]
                                : [place(segment[0]), place(segment[1]), place(segment[2])],
                    ),
                );
            }
            pen += glyph[0];
        }
    }
    if (
        result.some((contour) =>
            contour.some((segment) => segment.some((point) => !point.every(Number.isFinite))),
        )
    )
        return Result.err("error.sketch.invalidTextSize");
    return result.length === 0 ? Result.err("error.sketch.emptyText") : Result.ok(result);
}

/**
 * Adds all contours atomically. Quadratic Beziers are exact clamped degree-2 control B-splines;
 * coincident endpoints keep contours closed through subsequent solver edits. The solver's current
 * allocator reserves every entity/constraint id, including ones already held by this sketch.
 */
export function addTextGeometry(
    solver: SketchSolver,
    options: TextOutlineOptions,
): Result<number[], TextGeometryError> {
    const contours = textContours(options);
    if (!contours.isOk) return Result.err(contours.error);
    const trial = solver.fork();
    try {
        const ids: number[] = [];
        for (const contour of contours.value) {
            const edges: { id: number; end: number }[] = [];
            for (const segment of contour) {
                if (segment.length === 2) {
                    const id = trial.addLine(...segment[0], ...segment[1]);
                    edges.push({ id, end: 1 });
                } else {
                    const added = trial.addBSpline(
                        segment.map(([u, v]): [number, number] => [u, v]),
                        {
                            control: { degree: 2, knots: [0, 1], multiplicities: [3, 3] },
                        },
                    );
                    if (!added.isOk) return Result.err("error.sketch.invalidTextSize");
                    edges.push({ id: added.value, end: 2 });
                }
            }
            for (const [index, edge] of edges.entries()) {
                trial.addConstraint({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [
                        { entityId: edge.id, pointIndex: edge.end },
                        { entityId: edges[(index + 1) % edges.length].id, pointIndex: 0 },
                    ],
                });
                ids.push(edge.id);
            }
        }
        solver.reset(trial.toData());
        return Result.ok(ids);
    } finally {
        trial.dispose();
    }
}
