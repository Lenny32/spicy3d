// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type BoundedShapeQuery, type IShape, Result, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockDocument, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { buildCapabilityTools } from "../src/tools/capabilityEngine";

const methods = ["shape.inspectionMass", "shape.inspectionCommonVolume", "shape.inspectionSectionCaps"];
const box = (id: string) => ({ id, method: "box", args: { dx: 10, dy: 10, dz: 10 } });

function setup(mode: "hang" | "pass" | "intersect" | "fail" = "pass", needsCheck = true) {
    const doc = new TestDocument({ selection: createMockDocument().selection });
    const shapes: IShape[] = [];
    const inspection = rs.fn(() => Result.ok(5));
    const shapeQuery = rs.fn((_request: BoundedShapeQuery, signal?: AbortSignal) => {
        let answer: Result<boolean>;
        let finish!: () => void;
        const ready = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const timer = setTimeout(
            () => {
                answer =
                    mode === "hang"
                        ? Result.err("Self-intersection check timed out after 100 ms (result unknown)")
                        : mode === "fail"
                          ? Result.err("Worker operation failed")
                          : Result.ok(mode === "pass");
                finish();
            },
            mode === "hang" ? 100 : 1,
        );
        const abort = () => {
            answer = Result.err("Geometry worker operation cancelled");
            clearTimeout(timer);
            finish();
        };
        signal?.addEventListener("abort", abort, { once: true });
        return {
            ready,
            take: () => answer,
            cancel: () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
            },
        };
    });
    const factory = {
        box: () => {
            const shape = Object.assign(new MockShape({ shapeType: ShapeTypes.solid }), {
                needsInspectionSelfIntersectionCheck: needsCheck,
                inspectionMass: inspection,
                inspectionCommonVolume: inspection,
                inspectionSectionCaps: rs.fn(() => {
                    inspection();
                    return Result.ok(new MockShape());
                }),
                inspectionDistance: inspection,
            });
            shapes.push(shape);
            return Result.ok(shape);
        },
        boundedOperations: { shapeQuery },
    };
    const app = createMockApplication({ shapeProvider: { factory } as never });
    app.activeView = { document: doc } as never;
    rs.stubGlobal("app", app);
    return { doc, factory, shapes, inspection, shapeQuery, tool: buildCapabilityTools()[0] };
}

function ops(method: string) {
    return [
        box("source"),
        box("other"),
        { id: "answer", method, target: "source", args: { other: "other" } },
    ];
}

afterEach(() => {
    rs.useRealTimers();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

test.each(methods)("%s skips its main-thread binding when the pre-check hangs", async (method) => {
    rs.useFakeTimers();
    const { doc, tool, inspection, shapeQuery } = setup("hang");
    try {
        const running = tool.handler({ ops: ops(method) });
        const rejected = expect(running).rejects.toThrow(
            "self-intersection pre-check timed out after 100 ms (result unknown); inspection skipped",
        );
        await rs.advanceTimersByTimeAsync(100);
        await rejected;
        expect(shapeQuery).toHaveBeenCalledTimes(1);
        expect(inspection).not.toHaveBeenCalled();
        expect(doc.modelManager.findNodes(() => true)).toEqual([]);
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        doc.dispose();
    }
});

test.each(methods)("%s runs only after every input passes the worker pre-check", async (method) => {
    rs.useFakeTimers();
    const { doc, tool, inspection, shapeQuery, shapes } = setup();
    try {
        const running = tool.handler({ ops: ops(method) });
        await rs.advanceTimersByTimeAsync(0);
        expect(inspection).not.toHaveBeenCalled();
        await rs.advanceTimersByTimeAsync(2);
        const response = JSON.parse((await running) as string);
        expect(response.results.answer).toEqual(
            method === "shape.inspectionSectionCaps" ? { ref: "answer", kind: "shape" } : 5,
        );
        expect(inspection).toHaveBeenCalledTimes(1);
        expect(shapeQuery).toHaveBeenCalledTimes(method === "shape.inspectionCommonVolume" ? 2 : 1);
        expect(shapeQuery.mock.calls.map(([request]) => request.shape)).toEqual(
            method === "shape.inspectionCommonVolume" ? shapes : [shapes[0]],
        );
    } finally {
        doc.dispose();
    }
});

test.each(methods)("%s is cancelled during its pre-check without calling the binding", async (method) => {
    rs.useFakeTimers();
    const { doc, tool, inspection, shapeQuery } = setup("hang");
    const controller = new AbortController();
    try {
        const running = tool.handler({ ops: ops(method) }, controller.signal);
        const rejected = expect(running).rejects.toThrow(/cancelled/i);
        await rs.advanceTimersByTimeAsync(50);
        expect(shapeQuery).toHaveBeenCalledTimes(1);
        controller.abort();
        await rejected;
        expect(inspection).not.toHaveBeenCalled();
        expect(doc.modelManager.findNodes(() => true)).toEqual([]);
    } finally {
        doc.dispose();
    }
});

test.each(["intersect", "fail"] as const)("a %s worker result refuses inspection", async (mode) => {
    rs.useFakeTimers();
    const { doc, tool, inspection } = setup(mode);
    try {
        const running = tool.handler({ ops: ops("shape.inspectionMass") });
        const rejected = expect(running).rejects.toThrow(
            mode === "intersect"
                ? "Volume center is unavailable"
                : "Worker operation failed; inspection skipped",
        );
        await rs.advanceTimersByTimeAsync(1);
        await rejected;
        expect(inspection).not.toHaveBeenCalled();
    } finally {
        doc.dispose();
    }
});

test.each([
    "shape.inspectionMass",
    "shape.inspectionDistance",
])("%s skips an unnecessary pre-check", async (method) => {
    const { doc, tool, inspection, shapeQuery } = setup("hang", method === "shape.inspectionDistance");
    try {
        const response = JSON.parse((await tool.handler({ ops: ops(method) })) as string);
        expect(response.results.answer).toBe(5);
        expect(inspection).toHaveBeenCalledTimes(1);
        expect(shapeQuery).not.toHaveBeenCalled();
    } finally {
        doc.dispose();
    }
});

test.each([
    { op: { method: "shape.checkSelfIntersection", target: "source" }, error: "requires an id" },
    { op: { method: "shape.checkSelfIntersection", id: "clean" }, error: "requires a target" },
    {
        op: { method: "shape.checkSelfIntersection", id: "clean", target: "source" },
        error: "requires a bounded geometry worker",
    },
    {
        op: { method: "shape.inspectionMass", id: "mass", target: "source" },
        error: "requires a bounded geometry worker; inspection skipped",
    },
])("bounded query rejects $error", async ({ op, error }) => {
    const { doc, tool, factory, inspection, shapeQuery } = setup();
    Reflect.deleteProperty(factory, "boundedOperations");
    try {
        await expect(tool.handler({ ops: [box("source"), op] })).rejects.toThrow(error);
        expect(shapeQuery).not.toHaveBeenCalled();
        expect(inspection).not.toHaveBeenCalled();
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        doc.dispose();
    }
});
