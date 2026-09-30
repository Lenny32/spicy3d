// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IEdge, type IShapeFactory, Plane, Result, XYZ, type XYZLike } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { bsplineSpanCount, kernelBuildsBSplineEdges } from "../../src/sketch/bsplineEdges";
import { type BSplinePoint, bsplinePointAt, interpolateBSpline } from "../../src/sketch/bsplineGeometry";
import { type SketchData, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";

const FIT: BSplinePoint[] = [
    [0, 0],
    [10, 1],
    [12, 9],
    [3, 12],
    [-4, 6],
    [-8, -2],
];

const data = (periodic: boolean): SketchData => ({
    entities: [
        {
            id: 4,
            type: "bspline",
            params: FIT.flat(),
            parametrization: "chord",
            ...(periodic ? { periodic } : {}),
        },
    ],
    constraints: [],
});

/** A kernel stand-in: `bspline` and `bezier` record their input and answer a placeholder edge. */
function fakeKernel(withBinding: boolean) {
    const edge = { dispose: () => {} } as unknown as IEdge;
    const bspline = rs.fn(
        (
            _poles: XYZLike[],
            _knots: number[],
            _multiplicities: number[],
            _degree: number,
            _periodic: boolean,
            _weights?: number[],
        ) => Result.ok(edge),
    );
    const bezier = rs.fn((_points: XYZLike[], _weights?: number[]) => Result.ok(edge));
    const combine = rs.fn((shapes: IEdge[]) => Result.ok({ shapes }));
    const factory = {
        supportsBSplineEdges: withBinding,
        bspline,
        bezier,
        combine,
    } as unknown as IShapeFactory;
    return { factory, bspline, bezier, combine, edge };
}

afterEach(() => {
    rs.unstubAllGlobals();
});

describe("bspline edges, feature-detected", () => {
    test.each([
        false,
        true,
    ])("with the binding (periodic %s) the entity is ONE kernel edge from its poles and knots", (periodic) => {
        const kernel = fakeKernel(true);
        rs.stubGlobal("shapeFactory", kernel.factory);
        expect(kernelBuildsBSplineEdges()).toBe(true);
        const plane = Plane.XY.translateTo(new XYZ({ x: 0, y: 0, z: 5 }));
        const node = new SketchNode({ document: createMockDocument(), plane, data: data(periodic) });

        const shape = node.generateShape();

        expect(shape.isOk).toBe(true);
        expect(shape.value).toBe(kernel.edge);
        expect(kernel.bezier).not.toHaveBeenCalled();
        expect(kernel.bspline).toHaveBeenCalledTimes(1);
        const [poles, knots, multiplicities, degree, closed] = kernel.bspline.mock.calls[0];
        const curve = interpolateBSpline(FIT, { periodic }).value;
        expect(poles.map((p) => [p.x, p.y, p.z])).toEqual(curve.poles.map(([u, v]) => [u, v, 5]));
        expect(knots).toEqual(curve.knots);
        expect(multiplicities).toEqual(curve.multiplicities);
        expect(degree).toBe(3);
        expect(closed).toBe(periodic);
        // open: clamped ends (multiplicity degree + 1), periodic: n + 1 knots of multiplicity 1
        expect(multiplicities).toEqual(periodic ? Array(FIT.length + 1).fill(1) : [4, 1, 1, 4]);
        expect(shapeEntityIds(node.data)).toEqual([4]);
    });

    test.each([
        false,
        true,
    ])("without the binding (periodic %s) it is one Bezier edge per span, each tagged with the entity", (periodic) => {
        const kernel = fakeKernel(false);
        rs.stubGlobal("shapeFactory", kernel.factory);
        expect(kernelBuildsBSplineEdges()).toBe(false);
        const node = new SketchNode({
            document: createMockDocument(),
            plane: Plane.XY,
            data: data(periodic),
        });

        const shape = node.generateShape();

        expect(shape.isOk).toBe(true);
        expect(kernel.bspline).not.toHaveBeenCalled();
        const spans = bsplineSpanCount(FIT.length, periodic);
        expect(spans).toBe(periodic ? 6 : 3);
        expect(kernel.bezier).toHaveBeenCalledTimes(spans);
        expect(kernel.combine.mock.calls[0][0]).toHaveLength(spans);
        expect(shapeEntityIds(node.data)).toEqual(Array(spans).fill(4));
        // the segments chain: each starts where the previous one ends, cubic control polygons
        const segments = kernel.bezier.mock.calls.map(([points]) => points);
        for (const segment of segments) expect(segment).toHaveLength(4);
        for (let i = 1; i < segments.length; i++) expect(segments[i][0]).toEqual(segments[i - 1][3]);
        // and the first segment's middle is the curve's
        const curve = interpolateBSpline(FIT, { periodic }).value;
        const [a, b, c, d] = segments[0];
        const mid = [0, 1].map((k) => {
            const axis = k === 0 ? "x" : "y";
            return (a[axis] + 3 * b[axis] + 3 * c[axis] + d[axis]) / 8;
        });
        const expected = bsplinePointAt(curve, (curve.knots[0] + curve.knots[1]) / 2);
        expect(mid[0]).toBeCloseTo(expected[0], 9);
        expect(mid[1]).toBeCloseTo(expected[1], 9);
    });

    test("the fallback's open chain ends on the first and last fit points, a periodic one closes", () => {
        const kernel = fakeKernel(false);
        rs.stubGlobal("shapeFactory", kernel.factory);
        new SketchNode({
            document: createMockDocument(),
            plane: Plane.XY,
            data: data(false),
        }).generateShape();
        const open = kernel.bezier.mock.calls.map(([points]) => points);
        expect(open[0][0]).toMatchObject({ x: FIT[0][0], y: FIT[0][1], z: 0 });
        expect(open.at(-1)![3]).toMatchObject({ x: FIT.at(-1)![0], y: FIT.at(-1)![1], z: 0 });
        kernel.bezier.mockClear();
        new SketchNode({ document: createMockDocument(), plane: Plane.XY, data: data(true) }).generateShape();
        const closed = kernel.bezier.mock.calls.map(([points]) => points);
        expect(closed.at(-1)![3]).toEqual(closed[0][0]);
    });

    test("no kernel at all counts as no binding", () => {
        rs.stubGlobal("shapeFactory", undefined);
        expect(kernelBuildsBSplineEdges()).toBe(false);
    });
});
