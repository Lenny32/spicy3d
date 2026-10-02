// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@spicy3d/core";
import { validateSelfIntersection } from "../src/features/selfIntersectionValidation";

test.each([
    [6, true, 1, true, false],
    [33, true, 1, true, true],
    [33, false, 1, false, false],
    [33, true, 0, false, false],
    [257, true, 1, false, false],
] as const)("validation budget: %s faces, valid %s, volume %s", (count, valid, volume, ok, warning) => {
    const dispose = rs.fn();
    const check = rs.fn(() => Result.ok(true));
    const warn = rs.fn((_message: string) => {});
    const shape = {
        findSubShapes: (type: number) =>
            Array.from(
                { length: type === ShapeTypes.face ? count : type === ShapeTypes.solid ? 1 : 0 },
                () => ({ dispose }),
            ),
        checkShape: () => valid,
        volume: () => volume,
        checkSelfIntersection: check,
    } as unknown as IShape;
    const result = validateSelfIntersection(shape, warn);
    expect(result.isOk).toBe(ok);
    expect(warn).toHaveBeenCalledTimes(warning ? 1 : 0);
    expect(check).toHaveBeenCalledTimes(count === 6 ? 1 : 0);
    expect(dispose).toHaveBeenCalledTimes(count + (count === 33 && valid ? 1 : 0));
});
