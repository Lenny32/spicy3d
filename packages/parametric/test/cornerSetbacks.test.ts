// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS } from "@spicy3d/core";
import { resolveCornerSetbacks } from "../src/features/cornerSetbacks";
import type { EdgeRef } from "../src/features/edgeRef";
import type { FilletFeatureData } from "../src/features/feature";

const refs: [EdgeRef, EdgeRef, EdgeRef] = [0, 1, 2].map((axis) => ({
    kind: "line" as const,
    start: { x: 0, y: 0, z: 0 },
    end: { x: axis === 0 ? 40 : 0, y: axis === 1 ? 40 : 0, z: axis === 2 ? 40 : 0 },
    edgeId: `edge:${axis}`,
})) as [EdgeRef, EdgeRef, EdgeRef];
function feature(): FilletFeatureData {
    return {
        id: "corner",
        type: "fillet",
        radius: 2,
        edges: refs,
        cornerSetbacks: [{ edges: [refs[2], refs[0], refs[1]], distances: ["base + 0.01", "2.49 mm", 2.5] }],
    };
}

test("each independent expression stays associated with its edge when the triplet order differs", () => {
    const value = feature();
    const before = JSON.stringify(value);
    const answer = resolveCornerSetbacks(value, new Map([["base", { value: 2.5, unit: LENGTH_UNITS }]]));
    expect(answer.isOk).toBe(true);
    expect(answer.value).toEqual([2.49, 2.5, 2.51]);
    expect(JSON.stringify(value)).toBe(before);
});

test("rejects combined variable radius and corner setbacks", () => {
    const value = {
        ...feature(),
        radiusLaw: [
            { position: 0, radius: 1 },
            { position: 1, radius: 2 },
        ],
    };
    expect(resolveCornerSetbacks(value, new Map()).error).toMatch(/constant fillet radius/);
});

test.each([0, -1, NaN, Infinity, "missing", "90 deg"])("rejects invalid distance %s", (distance) => {
    const value = feature();
    value.cornerSetbacks![0].distances[0] = distance;
    expect(resolveCornerSetbacks(value, new Map()).isOk).toBe(false);
});

test("rejects an ambiguous repeated reference instead of swapping independent distances", () => {
    const value = feature();
    value.cornerSetbacks![0].edges[0] = refs[0];
    expect(resolveCornerSetbacks(value, new Map()).error).toMatch(/unambiguously/);
});
