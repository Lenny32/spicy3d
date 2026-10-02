// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Result, ShapeTypes } from "@spicy3d/core";
import { validateSelfIntersection } from "../src/features/selfIntersectionValidation";

test.each([
    [6, 0, 1, true, 1, true, false, true],
    [33, 0, 1, true, 1, true, true, false],
    [6, 65, 1, true, 1, true, true, false],
    [33, 0, 0, true, 0, true, true, false], // shells need not enclose volume
    [33, 0, 1, false, 1, false, false, false],
    [33, 0, 1, true, 0, false, false, false],
    [257, 0, 1, true, 1, false, false, false],
] as const)("validation heuristic: %s faces, %s edges, %s solids", (faces, edges, solids, valid, volume, ok, warning, analyzed) => {
    const dispose = rs.fn();
    const check = rs.fn(() => Result.ok(true));
    const warn = rs.fn((_message: string) => {});
    const shape = {
        findSubShapes: (type: number) =>
            Array.from(
                { length: type === ShapeTypes.face ? faces : type === ShapeTypes.edge ? edges : solids },
                () => ({ dispose }),
            ),
        checkShape: () => valid,
        volume: () => volume,
        checkSelfIntersection: check,
    } as unknown as IShape;
    const result = validateSelfIntersection(shape, warn);
    expect(result.isOk).toBe(ok);
    expect(warn).toHaveBeenCalledTimes(warning ? 1 : 0);
    expect(check).toHaveBeenCalledTimes(analyzed ? 1 : 0);
    expect(dispose).toHaveBeenCalledTimes(faces + edges + (valid && faces <= 256 && !analyzed ? solids : 0));
});
