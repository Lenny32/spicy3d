// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { parsePathData, parseSvg, type SvgDrawing, type SvgPoint, type SvgSegment } from "../src";

const PX = 25.4 / 96;

function svg(body: string, attributes = 'width="100mm" height="50mm" viewBox="0 0 100 50"') {
    return `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
}

function parsed(text: string): SvgDrawing {
    const result = parseSvg(text);
    expect(result.isOk).toBe(true);
    return result.unchecked()!;
}

function ends(segments: readonly SvgSegment[]): SvgPoint[] {
    return [segments[0].points[0], ...segments.map((segment) => segment.points[segment.points.length - 1])];
}

function expectPoints(actual: SvgPoint[], expected: [number, number][]) {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((point, i) => {
        expect(point.x).toBeCloseTo(expected[i][0], 6);
        expect(point.y).toBeCloseTo(expected[i][1], 6);
    });
}

describe("parsePathData", () => {
    test("absolute and relative lines, H/V and Z make one closed subpath", () => {
        const [subpath, ...rest] = parsePathData("M10 10 h20 v10 H10 z");
        expect(rest).toHaveLength(0);
        expect(subpath.closed).toBe(true);
        expect(subpath.segments.every((segment) => segment.kind === "line")).toBe(true);
        expectPoints(ends(subpath.segments), [
            [10, 10],
            [30, 10],
            [30, 20],
            [10, 20],
            [10, 10],
        ]);
    });

    test("implicit lineto after moveto and compact numbers", () => {
        const [subpath] = parsePathData("m1-1 2.5.5-1e1,0");
        expect(subpath.closed).toBe(false);
        expectPoints(ends(subpath.segments), [
            [1, -1],
            [3.5, -0.5],
            [-6.5, -0.5],
        ]);
    });

    test("quadratics become cubics with the same ends; smooth curves reflect the control", () => {
        const [subpath] = parsePathData("M0 0 Q10 10 20 0 T40 0");
        expect(subpath.segments.map((segment) => segment.kind)).toEqual(["cubic", "cubic"]);
        const [first, second] = subpath.segments;
        expectPoints(
            [...first.points],
            [
                [0, 0],
                [20 / 3, 20 / 3],
                [40 / 3, 20 / 3],
                [20, 0],
            ],
        );
        // T reflects (10, 10) about (20, 0): the control is (30, -10).
        expectPoints([second.points[1]], [[20 + (2 / 3) * 10, (2 / 3) * -10]]);
    });

    test("a half-circle arc is two cubics ending on the given point", () => {
        const [subpath] = parsePathData("M0 0 A10 10 0 0 1 20 0");
        expect(subpath.segments).toHaveLength(2);
        expectPoints(ends(subpath.segments), [
            [0, 0],
            [10, -10],
            [20, 0],
        ]);
    });

    test("compact arc flags are split ('011' = large 0, sweep 1, then 1)", () => {
        const [subpath] = parsePathData("M0 0a10 10 0 0110 10");
        expect(subpath.segments.length).toBeGreaterThan(0);
        expectPoints([subpath.segments.at(-1)!.points.at(-1)!], [[10, 10]]);
    });

    test("several subpaths, each closed by Z, and a degenerate one is dropped", () => {
        const subpaths = parsePathData("M0 0 L10 0 L10 10 Z M2 2 L2 2 M3 3 L5 3 L5 5 Z");
        expect(subpaths).toHaveLength(2);
        expect(subpaths.every((subpath) => subpath.closed)).toBe(true);
    });

    test("parsing stops at the first error and keeps what came before", () => {
        const subpaths = parsePathData("M0 0 L10 0 L10 X 20");
        expect(subpaths).toHaveLength(1);
        expect(subpaths[0].segments).toHaveLength(1);
    });
});

describe("parseSvg", () => {
    test("viewBox and mm size map user units to millimetres, Y flipped about the page bottom", () => {
        const drawing = parsed(svg('<path d="M10 10 L30 10"/>'));
        expect(drawing.elements).toHaveLength(1);
        expectPoints(ends(drawing.elements[0].subpaths[0].segments), [
            [10, 40],
            [30, 40],
        ]);
        expect(drawing.bounds?.min.x).toBeCloseTo(10);
        expect(drawing.bounds?.max.x).toBeCloseTo(30);
    });

    test("without a size or viewBox, user units are CSS pixels", () => {
        const drawing = parsed(svg('<line x1="0" y1="0" x2="96" y2="0"/>', ""));
        const [a, b] = ends(drawing.elements[0].subpaths[0].segments);
        expect(b.x - a.x).toBeCloseTo(96 * PX);
        expect(b.x - a.x).toBeCloseTo(25.4);
    });

    test("width in inches with a viewBox scales uniformly", () => {
        const drawing = parsed(
            svg('<rect x="0" y="0" width="10" height="10"/>', 'width="1in" viewBox="0 0 10 10"'),
        );
        expect(drawing.bounds!.max.x - drawing.bounds!.min.x).toBeCloseTo(25.4);
        expect(drawing.bounds!.max.y - drawing.bounds!.min.y).toBeCloseTo(25.4);
    });

    test("nested group transforms compose (translate then scale)", () => {
        const drawing = parsed(
            svg(
                '<g transform="translate(10 5)"><g transform="scale(2)"><line x1="0" y1="0" x2="5" y2="0"/></g></g>',
            ),
        );
        expectPoints(ends(drawing.elements[0].subpaths[0].segments), [
            [10, 45],
            [20, 45],
        ]);
    });

    test("rotate about a point", () => {
        const drawing = parsed(svg('<line x1="10" y1="10" x2="20" y2="10" transform="rotate(90 10 10)"/>'));
        expectPoints(ends(drawing.elements[0].subpaths[0].segments), [
            [10, 40],
            [10, 30],
        ]);
    });

    test("basic shapes are closed outlines", () => {
        const drawing = parsed(
            svg(
                '<rect x="1" y="1" width="10" height="5" rx="1"/><circle cx="20" cy="20" r="5"/>' +
                    '<ellipse cx="40" cy="20" rx="5" ry="3"/><polygon points="0,0 10,0 5,8"/>' +
                    '<polyline points="0,0 10,0 5,8"/>',
            ),
        );
        expect(drawing.elements.map((element) => element.tag)).toEqual([
            "rect",
            "circle",
            "ellipse",
            "polygon",
            "polyline",
        ]);
        expect(drawing.elements.map((element) => element.subpaths[0].closed)).toEqual([
            true,
            true,
            true,
            true,
            false,
        ]);
        const circle = drawing.elements[1].subpaths[0];
        expect(circle.segments).toHaveLength(4);
        const last = circle.segments.at(-1)!.points.at(-1)!;
        expect(last).toEqual(circle.segments[0].points[0]);
    });

    test("definitions and hidden elements are skipped; <use> draws its target; text is reported", () => {
        const drawing = parsed(
            svg(
                '<defs><rect id="r" width="4" height="4"/></defs>' +
                    '<rect width="4" height="4" display="none"/><g style="display: none"><circle r="3"/></g>' +
                    '<use href="#r" x="10" y="0"/><text>Hi</text>',
            ),
        );
        expect(drawing.elements).toHaveLength(1);
        expect(drawing.elements[0].tag).toBe("rect");
        expect(drawing.bounds?.min.x).toBeCloseTo(10);
        expect(drawing.skipped).toEqual(["text"]);
    });

    test("a file that is not SVG is refused", () => {
        expect(parseSvg("<html><body/></html>").isOk).toBe(false);
        expect(parseSvg("not xml at all <").isOk).toBe(false);
    });

    test("a drawing without geometry has no bounds", () => {
        const drawing = parsed(svg("<text>only text</text>"));
        expect(drawing.elements).toHaveLength(0);
        expect(drawing.bounds).toBeUndefined();
    });
});
