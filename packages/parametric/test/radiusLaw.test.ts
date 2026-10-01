// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, MAX_FILLET_RADIUS_SAMPLES, validateFilletRadiusLaw } from "@spicy3d/core";
import { resolveFilletRadiusLaw } from "../src/features/radiusLaw";

describe("fillet radius law", () => {
    test("resolves explicit units and length expressions without changing the stored law", () => {
        const law = [
            { position: 0, radius: "2 cm" },
            { position: 0.3, radius: "base * 2" },
            { position: 1, radius: 4 },
        ];
        const result = resolveFilletRadiusLaw(law, new Map([["base", { value: 3, unit: LENGTH_UNITS }]]));
        expect(result.isOk).toBe(true);
        expect(result.value).toEqual([
            { position: 0, radius: 20 },
            { position: 0.3, radius: 6 },
            { position: 1, radius: 4 },
        ]);
        expect(law[1].radius).toBe("base * 2");
    });

    test.each([
        [
            "missing start",
            [
                { position: 0.1, radius: 1 },
                { position: 1, radius: 2 },
            ],
        ],
        [
            "missing end",
            [
                { position: 0, radius: 1 },
                { position: 0.9, radius: 2 },
            ],
        ],
        [
            "duplicate position",
            [
                { position: 0, radius: 1 },
                { position: 0, radius: 2 },
                { position: 1, radius: 3 },
            ],
        ],
        [
            "descending position",
            [
                { position: 0, radius: 1 },
                { position: 0.8, radius: 2 },
                { position: 0.2, radius: 2 },
                { position: 1, radius: 3 },
            ],
        ],
        [
            "nonfinite position",
            [
                { position: 0, radius: 1 },
                { position: Number.NaN, radius: 2 },
                { position: 1, radius: 3 },
            ],
        ],
        [
            "negative radius",
            [
                { position: 0, radius: -1 },
                { position: 1, radius: 2 },
            ],
        ],
        [
            "zero radius",
            [
                { position: 0, radius: 0 },
                { position: 1, radius: 2 },
            ],
        ],
        [
            "nonfinite radius",
            [
                { position: 0, radius: 1 },
                { position: 1, radius: Number.POSITIVE_INFINITY },
            ],
        ],
        ["one sample", [{ position: 0, radius: 1 }]],
    ])("rejects %s", (_description, law) => {
        expect(validateFilletRadiusLaw(law)).toMatch(/Radius law/);
        expect(resolveFilletRadiusLaw(law, new Map()).isOk).toBe(false);
    });

    test("bounds interpolation work and accepts the maximum number of samples", () => {
        const law = Array.from({ length: MAX_FILLET_RADIUS_SAMPLES }, (_, index) => ({
            position: index / (MAX_FILLET_RADIUS_SAMPLES - 1),
            radius: 1,
        }));
        expect(validateFilletRadiusLaw(law)).toBeUndefined();
        expect(validateFilletRadiusLaw([...law, { position: 1, radius: 1 }])).toMatch(/2 to 64/);
    });

    test.each([
        "missing",
        "2 deg",
        "1 / 0",
        "-2 mm",
    ])("rejects unresolved or invalid radius %s with a sample diagnostic", (radius) => {
        const result = resolveFilletRadiusLaw(
            [
                { position: 0, radius },
                { position: 1, radius: 2 },
            ],
            new Map(),
        );
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/sample 1|positive finite/);
    });
});
