// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IAsyncShapeOperation, type IShape, Result } from "@spicy3d/core";
import {
    prepareValidatedFeature,
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

test.each([
    [Result.ok(""), undefined],
    [
        Result.ok(
            "output face indices (zero-based): 2 5; approximate faulty region center xyz (mm): (1, 2, 3)",
        ),
        "Thicken result: output face indices",
    ],
    [Result.err("Self-intersection check timed out after 30000 ms (result unknown)"), "timed out"],
    [Result.err("Self-intersection details are not available in this kernel build"), "not available"],
])("strict thicken validation rejects crossings and unknown verdicts", async (answer, error) => {
    const dispose = rs.fn(() => {});
    const shape = { dispose } as unknown as IShape;
    const diagnostic = rs.fn(
        (_shape: IShape): IAsyncShapeOperation<string> => ({
            ready: Promise.resolve(),
            canFallback: false,
            cancel: () => {},
            take: () => answer,
        }),
    );
    rs.stubGlobal("shapeFactory", {
        boundedOperations: {
            selfIntersectionDetails: diagnostic,
            shapeQuery: () => {
                throw new Error("boolean query must not replace diagnostic validation");
            },
        },
    });
    try {
        const task = prepareValidatedFeature(
            (context) => {
                context.deferSelfIntersection!(shape, "Thicken result");
                return Result.ok(shape);
            },
            { scope: {}, input: undefined } as any,
            true,
        );
        await task.ready;
        const result = task.take();
        expect(diagnostic).toHaveBeenCalledWith(shape);
        expect(result.isOk).toBe(error === undefined);
        if (error === undefined) {
            expect(result.value).toBe(shape);
            expect(dispose).toHaveBeenCalledTimes(0);
        } else {
            expect(result.error).toContain(error);
            expect(dispose).toHaveBeenCalledTimes(1);
        }
        task.cancel();
        expect(dispose).toHaveBeenCalledTimes(error === undefined ? 0 : 1);
    } finally {
        rs.unstubAllGlobals();
    }
});
