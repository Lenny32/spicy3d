// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@spicy3d/core";
import { glyphContours, type OutlineSegment, type Point2 } from "./fonts/fontOutlines";
import { NOTO_SANS } from "./fonts/notoSans.generated";
import { ConstraintKind } from "./planegcs";
import type { SketchSolver } from "./solver";

/** Deterministic text layout settings shared by editable text and exploded geometry. */
export interface TextOutlineOptions {
    value: string;
    x: number;
    y: number;
    height: number;
    angle: number;
    frame?: { width: number; height: number };
    alignment?: "left" | "center" | "right";
    verticalAlignment?: "bottom" | "middle" | "top";
    spacing?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
    font?: "sans";
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
    if (
        options.frame &&
        (![options.frame.width, options.frame.height].every(Number.isFinite) ||
            options.frame.width <= 0 ||
            options.frame.height <= 0)
    )
        return Result.err("error.sketch.invalidTextSize");
    if (!Number.isFinite(options.spacing ?? 0) || (options.spacing ?? 0) <= -100)
        return Result.err("error.sketch.invalidTextSize");
    if (options.font !== undefined && options.font !== "sans")
        return Result.err("error.sketch.unsupportedTextCharacter");
    const scale = height / NOTO_SANS.capHeight;
    const radians = ((angle % 360) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const result: OutlineSegment[][] = [];
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const pitch = LINE_PITCH * NOTO_SANS.capHeight;
    const spacing = 1 + (options.spacing ?? 0) / 100;
    for (const [row, line] of lines.entries()) {
        const chars = [...line];
        if (chars.some((char) => NOTO_SANS.glyphs[char] === undefined))
            return Result.err("error.sketch.unsupportedTextCharacter");
        const advance = chars.reduce((sum, char) => sum + NOTO_SANS.glyphs[char][0] * spacing, 0);
        const frameWidth = (options.frame?.width ?? 0) / scale;
        let pen =
            options.frame === undefined || options.alignment === undefined || options.alignment === "left"
                ? 0
                : (frameWidth - advance) * (options.alignment === "center" ? 0.5 : 1);
        const firstBaseline =
            options.frame === undefined
                ? 0
                : options.verticalAlignment === "top"
                  ? options.frame.height / scale - NOTO_SANS.capHeight
                  : options.verticalAlignment === "middle"
                    ? (options.frame.height / scale - NOTO_SANS.capHeight + (lines.length - 1) * pitch) / 2
                    : (lines.length - 1) * pitch;
        for (const char of line) {
            const glyph = NOTO_SANS.glyphs[char];
            if (glyph === undefined) return Result.err("error.sketch.unsupportedTextCharacter");
            let contours = contourCache.get(char);
            if (contours === undefined) {
                contours = glyphContours(glyph[1]);
                contourCache.set(char, contours);
            }
            const place = ([u, v]: Point2): Point2 => {
                let lx = (u + pen) * scale;
                let ly = (v + firstBaseline - row * pitch) * scale;
                if (options.flipHorizontal) lx = (options.frame?.width ?? 0) - lx;
                if (options.flipVertical) ly = (options.frame?.height ?? 0) - ly;
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
            pen += glyph[0] * spacing;
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
