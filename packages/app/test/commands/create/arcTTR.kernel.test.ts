// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "@rstest/core";
import { type IEdge, XYZ } from "@spicy3d/core";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { basisCurveOf, computeTangentTangentRadiusArc } from "../../../src/commands/create/arcUtils";

/**
 * Kernel-backed tests: run the TTR solver against real OCCT curves, whose
 * behaviour differs from mocks (e.g. an infinite line's firstParameter is astronomical).
 */

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../../../wasm/lib/spicy-wasm.wasm")),
    });
    factory = new ShapeFactory();
});

function curveOf(edge: IEdge) {
    return basisCurveOf(edge.curve);
}

describe("computeTangentTangentRadiusArc with OCCT kernel curves", () => {
    test("should solve two line edges", () => {
        const l1 = factory.line(XYZ.zero, new XYZ({ x: 10, y: 0, z: 0 })).value as IEdge;
        const l2 = factory.line(new XYZ({ x: 10, y: 0, z: 0 }), new XYZ({ x: 10, y: 10, z: 0 }))
            .value as IEdge;
        const result = computeTangentTangentRadiusArc(
            curveOf(l1),
            new XYZ({ x: 5, y: 0, z: 0 }),
            curveOf(l2),
            new XYZ({ x: 10, y: 5, z: 0 }),
            3,
        );
        expect(result).not.toBeUndefined();
        expect(result!.center.isEqualTo(new XYZ({ x: 7, y: 3, z: 0 }), 1e-6)).toBe(true);
        expect(result!.start.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(Math.abs(result!.angle - 90)).toBeLessThan(0.001);
    });

    test("should solve a line edge and a circle edge", () => {
        const line = factory.line(new XYZ({ x: -10, y: 8, z: 0 }), new XYZ({ x: 10, y: 8, z: 0 }))
            .value as IEdge;
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 5).value as IEdge;
        const result = computeTangentTangentRadiusArc(
            curveOf(line),
            new XYZ({ x: 0, y: 8, z: 0 }),
            curveOf(circle),
            new XYZ({ x: 5, y: 0, z: 0 }),
            3,
        );
        expect(result).not.toBeUndefined();
        expect(Math.abs(result!.center.x - Math.sqrt(39))).toBeLessThan(0.001);
        expect(Math.abs(result!.center.y - 5)).toBeLessThan(0.001);
    });

    test("should solve two circle edges", () => {
        const c1 = factory.circle(XYZ.unitZ, XYZ.zero, 5).value as IEdge;
        const c2 = factory.circle(XYZ.unitZ, new XYZ({ x: 12, y: 0, z: 0 }), 3).value as IEdge;
        const result = computeTangentTangentRadiusArc(
            curveOf(c1),
            new XYZ({ x: 5, y: 3, z: 0 }),
            curveOf(c2),
            new XYZ({ x: 9, y: 3, z: 0 }),
            2,
        );
        expect(result).not.toBeUndefined();
        expect(result!.center.isEqualTo(new XYZ({ x: 7, y: 0, z: 0 }), 1e-6)).toBe(true);
        expect(Math.abs(Math.abs(result!.angle) - 180)).toBeLessThan(0.001);
    });
});
