// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PerformanceTrace } from "@spicy3d/core";
import { createBox, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

afterEach(() => {
    PerformanceTrace.disable();
    rs.restoreAllMocks();
});

test("one tracked boolean records one kernel call and a separate history conversion", () => {
    const factory = createTestFactory();
    const first = createBox(factory, 10, 20, 30);
    const second = createBox(factory, 5, 5, 5);
    PerformanceTrace.enable();
    const result = unwrapOk(factory.booleanCutTracked([first], [second]));
    try {
        expect(result.shape.volume()).toBeCloseTo(5875, 6);
        const records = PerformanceTrace.snapshot().records;
        expect(records.filter((record) => record.details?.["boolean"])).toHaveLength(1);
        expect(records.map((record) => record.stage)).toEqual([
            "kernel.operation",
            "kernel.historyConversion",
        ]);
        expect(records[0].details).toEqual({ operation: "BooleanCut", boolean: true, tracked: true });
        expect(records.every((record) => record.durationMs >= 0)).toBe(true);
    } finally {
        result.shape.dispose();
        first.dispose();
        second.dispose();
    }
});

test("meshing records owner and buffers once; disabled factory and mesh hooks never read clocks", () => {
    const factory = createTestFactory();
    PerformanceTrace.disable();
    const now = rs.spyOn(performance, "now");
    const unprofiled = createBox(factory);
    try {
        expect(unprofiled.mesh.faces!.position.length).toBeGreaterThan(0);
        expect(now).not.toHaveBeenCalled();
    } finally {
        unprofiled.dispose();
    }
    now.mockRestore();
    const box = createBox(factory);
    PerformanceTrace.enable();
    PerformanceTrace.tagShape(box, { nodeId: "synthetic-body", meshKind: "body", visible: true });
    try {
        const faces = box.mesh.faces;
        expect(faces!.position.length).toBeGreaterThan(0);
        expect(box.mesh.faces).toBe(faces);
        const records = PerformanceTrace.snapshot().records;
        expect(records.map((record) => record.stage)).toEqual(["mesh.kernel", "mesh.buffers"]);
        expect(records[0].details).toEqual({
            shapeId: box.id,
            nodeId: "synthetic-body",
            meshKind: "body",
            visible: true,
        });
    } finally {
        box.dispose();
    }
});
