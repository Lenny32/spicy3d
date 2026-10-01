// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Glyph outlines baked from a TrueType font by `scripts/generate-font-outlines.mjs`: per
 * character its advance width and a compact path in font units (`M x y` starts a contour,
 * `L x y` a line, `Q cx cy x y` a quadratic segment; contours close back to their start).
 */
export interface FontOutlines {
    readonly unitsPerEm: number;
    /** Height of flat capitals ("H") in font units: a sketch text's `height` maps onto it. */
    readonly capHeight: number;
    readonly glyphs: Readonly<Record<string, readonly [advance: number, path: string]>>;
}

export type Point2 = readonly [number, number];

/** One outline segment: a line (2 points) or a quadratic Bézier (start, control, end). */
export type OutlineSegment = readonly [Point2, Point2] | readonly [Point2, Point2, Point2];

/** A glyph's contours, each a closed chain of segments, in font units. */
export function glyphContours(path: string): OutlineSegment[][] {
    const tokens = path.match(/[MLQ]|-?\d+(?:\.\d+)?/g) ?? [];
    const contours: OutlineSegment[][] = [];
    let contour: OutlineSegment[] = [];
    let start: Point2 = [0, 0];
    let current: Point2 = [0, 0];
    const closeContour = () => {
        if (contour.length === 0) return;
        if (current[0] !== start[0] || current[1] !== start[1]) contour.push([current, start]);
        contours.push(contour);
        contour = [];
    };
    let i = 0;
    const next = () => Number(tokens[i++]);
    while (i < tokens.length) {
        const command = tokens[i++];
        if (command === "M") {
            closeContour();
            start = current = [next(), next()];
        } else if (command === "L") {
            const to: Point2 = [next(), next()];
            contour.push([current, to]);
            current = to;
        } else if (command === "Q") {
            const control: Point2 = [next(), next()];
            const to: Point2 = [next(), next()];
            contour.push([current, control, to]);
            current = to;
        }
    }
    closeContour();
    return contours;
}
