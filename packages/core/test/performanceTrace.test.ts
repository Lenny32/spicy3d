// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PerformanceTrace } from "../src/performanceTrace";

afterEach(() => {
    PerformanceTrace.disable();
    rs.restoreAllMocks();
});

test("disabled hooks do not read the clock or evaluate metadata", () => {
    PerformanceTrace.disable();
    const now = rs.spyOn(performance, "now").mockImplementation(() => {
        throw new Error("disabled profiling read the clock");
    });
    const metadata = rs.fn(() => ({ nodeId: "synthetic" }));
    const span = PerformanceTrace.enabled
        ? PerformanceTrace.begin("node.deserialize", metadata())
        : undefined;
    if (PerformanceTrace.enabled) PerformanceTrace.end(span);
    expect(PerformanceTrace.begin("direct-disabled-call")).toBeUndefined();
    PerformanceTrace.end(undefined);
    expect(now).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
});

test("interleaved spans keep independent metadata and duration", () => {
    const now = rs.spyOn(performance, "now");
    PerformanceTrace.enable();
    now.mockReturnValueOnce(10).mockReturnValueOnce(15).mockReturnValueOnce(25).mockReturnValueOnce(40);
    const first = PerformanceTrace.begin("feature.step", { featureIndex: 1 });
    const second = PerformanceTrace.begin("feature.step", { featureIndex: 2 });
    PerformanceTrace.end(first, { cacheHit: true });
    PerformanceTrace.end(second, { cacheHit: false });
    expect(PerformanceTrace.snapshot().records).toEqual([
        { stage: "feature.step", started: 10, durationMs: 15, details: { featureIndex: 1, cacheHit: true } },
        { stage: "feature.step", started: 15, durationMs: 25, details: { featureIndex: 2, cacheHit: false } },
    ]);
});

test("bounded captures report loss and discard spans from an earlier capture", () => {
    PerformanceTrace.enable();
    const stale = PerformanceTrace.begin("old");
    PerformanceTrace.enable(1);
    PerformanceTrace.end(stale);
    PerformanceTrace.record("first", 0, 1);
    PerformanceTrace.record("overflow", 1, 2);
    expect(PerformanceTrace.snapshot()).toEqual({
        records: [{ stage: "first", started: 0, durationMs: 1, details: undefined }],
        dropped: 1,
    });
});

test("shape tags are capture-local and exported records cannot mutate the capture", () => {
    const shape = {};
    PerformanceTrace.enable();
    PerformanceTrace.tagShape(shape, { meshKind: "body", visible: true });
    expect(PerformanceTrace.shapeDetails(shape)).toEqual({ meshKind: "body", visible: true });
    PerformanceTrace.record("mesh.kernel", 0, 1, PerformanceTrace.shapeDetails(shape));
    const snapshot = PerformanceTrace.snapshot();
    snapshot.records[0].details!["meshKind"] = "changed";
    PerformanceTrace.disable();
    expect(PerformanceTrace.shapeDetails(shape)).toBeUndefined();
    expect(PerformanceTrace.snapshot().records[0].details).toEqual({ meshKind: "body", visible: true });
    PerformanceTrace.enable();
    expect(PerformanceTrace.snapshot().records).toEqual([]);
});
