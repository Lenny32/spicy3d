// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Plane } from "@spicy3d/core";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { bsplineEdges } from "../../src/sketch/bsplineEdges";
import { bsplineDomain, bsplinePointAt } from "../../src/sketch/bsplineGeometry";
import { controlBSplineCurve } from "../../src/sketch/controlBSplineGeometry";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(resolve(import.meta.dirname, "../../../wasm/lib/spicy-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
test.each([
    {
        params: [1, 0, 1, 1, 0, 1],
        periodic: false,
        control: { degree: 2, knots: [0, 1], multiplicities: [3, 3], weights: [1, Math.SQRT1_2, 1] },
    },
    {
        params: [0, 0, 10, 0, 10, 10, 0, 10],
        periodic: true,
        control: {
            degree: 3,
            knots: [0, 1, 2, 3, 4],
            multiplicities: [1, 1, 1, 1, 1],
            weights: [1, 2, 1, 2],
        },
    },
])("weighted control curve agrees with OCCT over the entire domain %j", (entity) => {
    const curve = controlBSplineCurve(entity.params, entity.control, entity.periodic);
    expect(curve.isOk).toBe(true);
    const built = bsplineEdges(entity.params, entity, Plane.XY);
    expect(built.isOk).toBe(true);
    expect(built.value).toHaveLength(1);
    const kernel = built.value[0].curve;
    try {
        const [a, b] = bsplineDomain(curve.value);
        expect(kernel.firstParameter()).toBeCloseTo(a, 12);
        expect(kernel.lastParameter()).toBeCloseTo(b, 12);
        let deviation = 0;
        for (let i = 0; i <= 40; i++) {
            const u = a + ((b - a) * i) / 40;
            const xy = bsplinePointAt(curve.value, u);
            const point = kernel.value(u);
            deviation = Math.max(deviation, Math.hypot(point.x - xy[0], point.y - xy[1]));
        }
        expect(deviation).toBeLessThan(1e-8);
    } finally {
        kernel.dispose();
        for (const edge of built.value) edge.dispose();
    }
});

test("an older kernel refuses rational controls and keeps polynomial control fallback exact", () => {
    const old = Object.getOwnPropertyDescriptor(shapeFactory, "supportsBSplineEdges");
    Object.defineProperty(shapeFactory, "supportsBSplineEdges", { value: false, configurable: true });
    try {
        const control = { degree: 2, knots: [0, 1], multiplicities: [3, 3], weights: [1, Math.SQRT1_2, 1] };
        const rational = bsplineEdges([1, 0, 1, 1, 0, 1], { control }, Plane.XY);
        expect(rational.isOk).toBe(false);
        expect(rational.error).toMatch(/kernel is too old/);
        const polynomial = bsplineEdges(
            [1, 0, 1, 1, 0, 1],
            { control: { degree: 2, knots: [0, 1], multiplicities: [3, 3] } },
            Plane.XY,
        );
        expect(polynomial.isOk).toBe(true);
        expect(polynomial.value).toHaveLength(1);
        const curve = polynomial.value[0].curve;
        try {
            const mid = curve.value((curve.firstParameter() + curve.lastParameter()) / 2);
            expect(mid.x).toBeCloseTo(0.75, 10);
            expect(mid.y).toBeCloseTo(0.75, 10);
        } finally {
            curve.dispose();
            for (const edge of polynomial.value) edge.dispose();
        }
    } finally {
        if (old) Object.defineProperty(shapeFactory, "supportsBSplineEdges", old);
        else delete (shapeFactory as any).supportsBSplineEdges;
    }
});
