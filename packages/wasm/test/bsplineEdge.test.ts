// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, ShapeTypes, type XYZLike } from "@spicy3d/core";
import type { ShapeResult } from "../lib/spicy-wasm";
import { BSPLINE_EDGE_UNAVAILABLE } from "../src/factory";
import { createTestFactory } from "./helpers";
import "./setup";

type Binding = (
    poles: XYZLike[],
    knots: number[],
    multiplicities: number[],
    degree: number,
    periodic: boolean,
    weights: number[],
) => ShapeResult;
type FactoryClass = { bspline?: Binding };

const factory = createTestFactory();
const factoryClass = () => wasm.ShapeFactory as unknown as FactoryClass;
let owned: IDisposable[] = [];
afterEach(() => {
    for (const value of owned.reverse()) value.dispose();
    owned = [];
});

/**
 * Runs `run` with `binding` standing in for the C++ `ShapeFactory.bspline` (undefined: a module
 * without it), then puts back whatever the loaded module had.
 */
function withBinding(binding: Binding | undefined, run: () => void) {
    const had = Object.hasOwn(factoryClass(), "bspline");
    const original = factoryClass().bspline;
    if (binding === undefined) delete factoryClass().bspline;
    else factoryClass().bspline = binding;
    try {
        run();
    } finally {
        if (had) factoryClass().bspline = original;
        else delete factoryClass().bspline;
    }
}

const poles: XYZLike[] = [
    { x: 0, y: 0, z: 0 },
    { x: 3, y: 5, z: 0 },
    { x: 7, y: 5, z: 0 },
    { x: 10, y: 0, z: 0 },
];

describe("bspline is feature-detected on the kernel build", () => {
    test("a module without the binding: an error and no capability, never a throw", () => {
        withBinding(undefined, () => {
            expect(factoryClass().bspline).toBeUndefined();
            expect(factory.supportsBSplineEdges).toBe(false);
            const result = factory.bspline(poles, [0, 1], [4, 4], 3, false);
            expect(result.isOk ? "" : result.error).toBe(BSPLINE_EDGE_UNAVAILABLE);
        });
    });

    test("the committed binary has the binding: one real edge through the layout", () => {
        expect(typeof factoryClass().bspline).toBe("function");
        expect(factory.supportsBSplineEdges).toBe(true);
        const result = factory.bspline(poles, [0, 1], [4, 4], 3, false);
        expect(result.isOk).toBe(true);
        owned.push(result.value);
        expect(result.value.shapeType).toBe(ShapeTypes.edge);
        const edge = result.value;
        const [start, end] = [edge.startPoint(), edge.endPoint()];
        expect([start.x, start.y, end.x, end.y].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0, 0, 10, 0]);
        // a single-span clamped cubic is its Bezier: at t = 0.5, (P0 + 3 P1 + 3 P2 + P3) / 8
        const curve = edge.curve;
        const mid = curve.value((curve.firstParameter() + curve.lastParameter()) / 2);
        owned.push(curve);
        expect(mid.x).toBeCloseTo(5, 9);
        expect(mid.y).toBeCloseTo(3.75, 9);
    });

    test("a present binding gets the layout as given and its edge comes back", () => {
        // the stand-in answers a real edge (the Bezier the single-span cubic equals)
        const binding = rs.fn<Binding>((points) => wasm.ShapeFactory.bezier(points as never, []));
        withBinding(binding, () => {
            expect(factory.supportsBSplineEdges).toBe(true);
            const result = factory.bspline(poles, [0, 1], [4, 4], 3, false);
            expect(result.isOk).toBe(true);
            owned.push(result.value);
            expect(result.value.shapeType).toBe(ShapeTypes.edge);
            expect(result.value.endPoint().x).toBeCloseTo(10);
        });
        expect(binding).toHaveBeenCalledTimes(1);
        expect(binding.mock.calls[0]).toEqual([poles, [0, 1], [4, 4], 3, false, []]);
    });

    test.each([
        ["a degree below 1", [0, 1], [4, 4], 0, false, undefined, "degree"],
        ["one knot", [0], [4], 3, false, undefined, "at least two knots"],
        ["decreasing knots", [1, 0], [4, 4], 3, false, undefined, "strictly increasing"],
        ["an end multiplicity above degree + 1", [0, 1], [5, 3], 3, false, undefined, "multiplicity"],
        ["too few poles for the knots", [0, 0.5, 1], [4, 1, 4], 3, false, undefined, "needs 5 poles"],
        [
            "a periodic curve with unequal end multiplicities",
            [0, 1, 2, 3, 4],
            [1, 1, 1, 1, 2],
            3,
            true,
            undefined,
            "equal first and last",
        ],
        ["a weight per pole missing", [0, 1], [4, 4], 3, false, [1, 1], "one weight per pole"],
        ["a non-positive weight", [0, 1], [4, 4], 3, false, [1, 0, 1, 1], "positive"],
    ])("%s is refused before the kernel sees it", (_case, knots, multiplicities, degree, periodic, weights, message) => {
        const binding = rs.fn<Binding>(() => {
            throw new Error("must not be called");
        });
        withBinding(binding, () => {
            const result = factory.bspline(poles, knots, multiplicities, degree, periodic, weights);
            expect(result.isOk ? "" : result.error).toContain(message);
        });
        expect(binding).not.toHaveBeenCalled();
    });

    test("a periodic layout of n poles for n + 1 knots passes to the kernel", () => {
        const binding = rs.fn<Binding>((points) => wasm.ShapeFactory.bezier(points as never, []));
        withBinding(binding, () => {
            const result = factory.bspline(poles, [0, 1, 2, 3, 4], [1, 1, 1, 1, 1], 3, true);
            expect(result.isOk).toBe(true);
            owned.push(result.value);
        });
        expect(binding.mock.calls[0].slice(1, 5)).toEqual([[0, 1, 2, 3, 4], [1, 1, 1, 1, 1], 3, true]);
    });
});
