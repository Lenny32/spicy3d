// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@spicy3d/core";
import {
    SELF_INTERSECTION_SKIPPED,
    validateSelfIntersection,
} from "../src/features/selfIntersectionValidation";

test.each([
    [true, 1, 1, true],
    [true, 1, 1e-12, true], // a small positive solid is not invalid by size
    [true, 0, 0, true], // shells need not enclose volume
    [false, 1, 1, false],
    [true, 1, 0, false],
    [true, 0, Number.NaN, false],
] as const)("synchronous cheap gates: valid=%s solids=%s volume=%s", (valid, solids, volume, ok) => {
    const dispose = rs.fn();
    const check = rs.fn(() => Result.ok(true));
    const warn = rs.fn((_message: string) => {});
    const shape = {
        findSubShapes: (_type: number) => Array.from({ length: solids }, () => ({ dispose })),
        checkShape: () => valid,
        volume: () => volume,
        checkSelfIntersection: check,
    } as unknown as IShape;
    const result = validateSelfIntersection(shape, warn);
    expect(result.isOk).toBe(ok);
    expect(warn.mock.calls).toEqual(ok ? [[SELF_INTERSECTION_SKIPPED]] : []);
    expect(check).toHaveBeenCalledTimes(0);
    expect(dispose).toHaveBeenCalledTimes(valid ? solids : 0);
});
