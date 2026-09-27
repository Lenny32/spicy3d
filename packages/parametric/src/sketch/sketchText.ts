// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FontOutlines, glyphContours, type OutlineSegment, type Point2 } from "./fonts/fontOutlines";
import { NOTO_SANS } from "./fonts/notoSans.generated";

/**
 * Sketch text: a string placed on the sketch plane whose glyph outlines join the sketch's
 * profile edges — so letters extrude, cut and emboss like any closed profile (a glyph's counter,
 * the hole of an "o", becomes a hole of its face through the usual even-odd nesting).
 *
 * Texts are not solver entities: they are placed (position, height, angle), not constrained, and
 * live in `SketchData.texts` beside the entities. A text's `id` is drawn from the entity id space
 * (`sketchIds.ts`), so the profile machinery that maps edges back to entity ids — seeds, profile
 * refs, crossing splits — treats every glyph edge as an edge of entity `id`.
 */
export interface SketchTextData {
    /** Unique among the sketch's entities and texts (the entity id space). */
    id: number;
    /** The string; `\n` starts a new line. Characters the font lacks are skipped. */
    value: string;
    /** Baseline start of the first line, in sketch UV (mm). */
    x: number;
    y: number;
    /** Cap height in mm: the height of a flat capital such as "H". */
    height: number;
    /** Counter-clockwise rotation around (x, y), in degrees. */
    angle?: number;
    /** Font key of `SKETCH_FONTS`; absent = the default font. */
    font?: string;
}

export const DEFAULT_SKETCH_FONT = "sans";

/** The fonts sketch text can use, by key. */
export const SKETCH_FONTS: Readonly<Record<string, FontOutlines>> = { [DEFAULT_SKETCH_FONT]: NOTO_SANS };

/** Line pitch as a multiple of the cap height. */
const LINE_PITCH = 1.6;

const contourCache = new Map<string, Map<string, OutlineSegment[][]>>();

function contoursOf(fontKey: string, font: FontOutlines, char: string): OutlineSegment[][] | undefined {
    let cache = contourCache.get(fontKey);
    if (cache === undefined) {
        cache = new Map();
        contourCache.set(fontKey, cache);
    }
    let contours = cache.get(char);
    if (contours === undefined) {
        const glyph = font.glyphs[char];
        if (glyph === undefined) return undefined;
        contours = glyphContours(glyph[1]);
        cache.set(char, contours);
    }
    return contours;
}

/**
 * The text's outline contours in sketch UV: every glyph contour a closed chain of line /
 * quadratic segments, laid out left to right from (x, y), scaled to `height` and rotated by
 * `angle`. Deterministic — the edge count `shapeEntityIds` reports and the edges
 * `SketchNode` builds both come from here.
 */
export function textContours(text: SketchTextData): OutlineSegment[][] {
    const fontKey = text.font ?? DEFAULT_SKETCH_FONT;
    const font = SKETCH_FONTS[fontKey] ?? SKETCH_FONTS[DEFAULT_SKETCH_FONT];
    if (!(text.height > 0) || font.capHeight <= 0) return [];
    const scale = text.height / font.capHeight;
    const radians = ((text.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const space = font.glyphs[" "]?.[0] ?? font.unitsPerEm / 4;

    const result: OutlineSegment[][] = [];
    const lines = text.value.split("\n");
    for (const [row, line] of lines.entries()) {
        let pen = 0;
        const baseline = -row * LINE_PITCH * font.capHeight;
        for (const char of line) {
            const contours = contoursOf(fontKey, font, char);
            if (contours === undefined) {
                pen += space;
                continue;
            }
            const place = ([u, v]: Point2): Point2 => {
                const lx = (u + pen) * scale;
                const ly = (v + baseline) * scale;
                return [text.x + lx * cos - ly * sin, text.y + lx * sin + ly * cos];
            };
            for (const contour of contours) {
                result.push(contour.map((segment) => segment.map(place) as unknown as OutlineSegment));
            }
            pen += font.glyphs[char][0];
        }
    }
    return result;
}

/** How many edges the text contributes to the sketch shape (one per outline segment). */
export function textEdgeCount(text: SketchTextData): number {
    return textContours(text).reduce((sum, contour) => sum + contour.length, 0);
}

/** Axis-aligned UV bounds of the text's outlines, or undefined for an empty text. */
export function textBounds(
    text: SketchTextData,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
    let bounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
    for (const contour of textContours(text)) {
        for (const segment of contour) {
            for (const [u, v] of segment) {
                bounds =
                    bounds === undefined
                        ? { minX: u, minY: v, maxX: u, maxY: v }
                        : {
                              minX: Math.min(bounds.minX, u),
                              minY: Math.min(bounds.minY, v),
                              maxX: Math.max(bounds.maxX, u),
                              maxY: Math.max(bounds.maxY, v),
                          };
            }
        }
    }
    return bounds;
}
