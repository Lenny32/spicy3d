// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { parseSvg, type SvgDrawing } from "@spicy3d/core";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { svgSketchClipboard } from "../../src/sketch/svgGeometry";
import "./setup";

function drawing(body: string, size = 'width="40mm" height="20mm" viewBox="0 0 40 20"'): SvgDrawing {
    const parsed = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${size}>${body}</svg>`);
    expect(parsed.isOk).toBe(true);
    return parsed.value;
}

const RECT = '<rect x="0" y="0" width="40" height="20"/>';
const round = (params: number[]) => params.map((p) => Math.round(p * 1e9) / 1e9 + 0);

test("a rectangle becomes four lines centred on the origin, joined end to end", () => {
    const clipboard = svgSketchClipboard(drawing(RECT), { scale: 1, angle: 0 });
    expect(clipboard.isOk).toBe(true);
    const { entities, constraints, origin } = clipboard.value;
    expect(origin).toEqual([0, 0]);
    expect(entities.map((e) => e.type)).toEqual(["line", "line", "line", "line"]);
    const points = entities.flatMap((e) => round(e.params));
    expect(Math.min(...points.filter((_, i) => i % 2 === 0))).toBe(-20);
    expect(Math.max(...points.filter((_, i) => i % 2 === 0))).toBe(20);
    expect(Math.min(...points.filter((_, i) => i % 2 === 1))).toBe(-10);
    expect(Math.max(...points.filter((_, i) => i % 2 === 1))).toBe(10);
    // closed: every end meets the next start, the last one the first
    expect(constraints).toHaveLength(4);
    expect(constraints.every((c) => c.kind === ConstraintKind.P2PCoincident)).toBe(true);
    for (const [index, entity] of entities.entries()) {
        const next = entities[(index + 1) % entities.length];
        expect(
            constraints.some(
                (c) =>
                    c.refs[0].entityId === entity.id &&
                    c.refs[0].pointIndex === 1 &&
                    c.refs[1].entityId === next.id &&
                    c.refs[1].pointIndex === 0,
            ),
        ).toBe(true);
        expect(round(entity.params.slice(2, 4))).toEqual(round(next.params.slice(0, 2)));
    }
});

test("the SVG's Y axis points up in the sketch", () => {
    // y = 0 is the page's top edge: the line along it lies above the centre
    const clipboard = svgSketchClipboard(
        drawing('<line x1="0" y1="0" x2="40" y2="0"/><line x1="0" y1="20" x2="0" y2="20.5"/>'),
        {
            scale: 1,
            angle: 0,
        },
    );
    expect(clipboard.isOk).toBe(true);
    expect(round(clipboard.value.entities[0].params)).toEqual([-20, 10.25, 20, 10.25]);
});

test("scale and a 90° turn apply about the drawing's centre", () => {
    const clipboard = svgSketchClipboard(drawing('<line x1="0" y1="20" x2="40" y2="20"/>'), {
        scale: 2,
        angle: 90,
    });
    expect(clipboard.isOk).toBe(true);
    // a 40 mm horizontal line, doubled and turned counter-clockwise: 80 mm upwards through the origin
    expect(round(clipboard.value.entities[0].params)).toEqual([0, -40, 0, 40]);
});

test("cubics become exact degree-3 control B-splines; open paths are not closed", () => {
    const clipboard = svgSketchClipboard(drawing('<path d="M0 20 C10 0 30 0 40 20 L40 10"/>'), {
        scale: 1,
        angle: 0,
    });
    expect(clipboard.isOk).toBe(true);
    const [curve, line] = clipboard.value.entities;
    expect(curve.type).toBe("bspline");
    // the bounds hug the curve (its top at 15 mm), not its control polygon
    expect(curve.control).toMatchObject({ degree: 3, knots: [0, 1], multiplicities: [4, 4] });
    expect(round(curve.params)).toEqual([-20, -7.5, -10, 12.5, 10, 12.5, 20, -7.5]);
    expect(line.type).toBe("line");
    expect(clipboard.value.constraints).toHaveLength(1);
    expect(clipboard.value.constraints[0].refs).toEqual([
        { entityId: curve.id, pointIndex: 3 },
        { entityId: line.id, pointIndex: 0 },
    ]);
});

test("zero-length segments are dropped and their neighbours joined", () => {
    const clipboard = svgSketchClipboard(drawing('<path d="M0 0 L40 0 L40 0 L40 20"/>'), {
        scale: 1,
        angle: 0,
    });
    expect(clipboard.isOk).toBe(true);
    expect(clipboard.value.entities).toHaveLength(2);
    expect(clipboard.value.constraints).toHaveLength(1);
});

test.each([0, -1, Number.NaN, Infinity])("scale %s is refused", (scale) => {
    expect(svgSketchClipboard(drawing(RECT), { scale, angle: 0 }).isOk).toBe(false);
});

test("kept as one piece, every piece is locked and no joint is added", () => {
    const clipboard = svgSketchClipboard(drawing(`${RECT}<circle cx="10" cy="10" r="4"/>`), {
        scale: 1,
        angle: 0,
        lock: true,
    });
    expect(clipboard.isOk).toBe(true);
    const { entities, constraints } = clipboard.value;
    expect(entities).toHaveLength(8);
    expect(constraints.map((c) => c.kind)).toEqual(entities.map(() => ConstraintKind.Block));
    expect(constraints.map((c) => c.refs[0].entityId)).toEqual(entities.map((e) => e.id));
    // the pieces still meet end to end, so the outlines close without the joints
    for (const [index, entity] of entities.slice(0, 4).entries()) {
        const next = entities[(index + 1) % 4];
        expect(entity.params.slice(2, 4)).toEqual(next.params.slice(0, 2));
    }
});
