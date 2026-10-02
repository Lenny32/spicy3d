// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IShape, Result } from "@spicy3d/core";
import { inspectionPrecheck } from "../src/analysis/inspectionPrecheck";

afterEach(() => {
    rs.unstubAllGlobals();
});

test.each([
    "timeout",
    "intersects",
    "cancel",
    "success",
])("bounded inspection pre-check: %s", async (mode) => {
    const controller = new AbortController();
    const cancel = rs.fn();
    const query = rs.fn(() => ({
        ready: Promise.resolve().then(() => {
            if (mode === "cancel") controller.abort();
        }),
        take: () =>
            mode === "timeout"
                ? Result.err("Self-intersection check timed out")
                : Result.ok(mode !== "intersects"),
        cancel,
    }));
    rs.stubGlobal("shapeFactory", { boundedOperations: { shapeQuery: query } });
    const shape = { checkShape: () => true, needsInspectionSelfIntersectionCheck: true } as unknown as IShape;
    const result = await inspectionPrecheck([shape, shape], controller.signal);
    expect(query).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.isOk).toBe(mode === "success");
    expect(result.isOk ? undefined : result.error).toBe(
        mode === "timeout"
            ? I18n.translate("analysis.inspectionTimedOut")
            : mode === "intersects"
              ? "Inspection input intersects itself"
              : mode === "cancel"
                ? "Inspection cancelled"
                : undefined,
    );
});

test("invalid input skips the analyzer", async () => {
    const query = rs.fn();
    rs.stubGlobal("shapeFactory", { boundedOperations: { shapeQuery: query } });
    const shape = { checkShape: () => false } as unknown as IShape;
    const result = await inspectionPrecheck([shape], new AbortController().signal);
    expect(result.error).toBe("Inspection input is invalid");
    expect(query).not.toHaveBeenCalled();
});
