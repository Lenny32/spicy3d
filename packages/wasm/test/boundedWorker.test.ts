// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type IDisposable, type IFace, Matrix4, ShapeTypes, XYZ } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import type { OccShape } from "../src/shape";
import { type IKernelWorkerTransport, KernelWorkerClient } from "../src/workerClient";
import type { KernelMessage } from "../src/workerProtocol";
import { createBox, createSphere, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

class HungTransport extends EventTarget implements IKernelWorkerTransport {
    readonly messages: KernelMessage[] = [];
    terminated = 0;
    postMessage(message: KernelMessage) {
        this.messages.push(message);
    }
    terminate() {
        this.terminated++;
    }
}
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    rs.useRealTimers();
    const values = owned;
    owned = [];
    for (const value of values.reverse()) value.dispose();
});

test("corner fits keep a finite deadline with enough margin for slower machines", async () => {
    rs.useFakeTimers();
    const transport = new HungTransport();
    const client = new KernelWorkerClient(transport);
    try {
        const pending = client.request("cornerSetbackReplica", {
            shape: { brep: "test", topology: { graph: "test", faces: [], edges: [] } },
            edges: [0, 1, 2],
            radius: 1,
            distances: [2, 2, 2],
        });
        await rs.advanceTimersByTimeAsync(100_000);
        expect(client.pendingRequests).toBe(1);
        expect(transport.terminated).toBe(0);
        await rs.advanceTimersByTimeAsync(80_000);
        expect(await pending).toMatchObject({
            ok: false,
            error: { code: "timeout", message: expect.stringContaining("180000") },
        });
        expect(transport.terminated).toBe(1);
        expect(client.pendingRequests).toBe(0);
    } finally {
        client.dispose();
    }
});

test("a hung generation times out all callers, detaches stale replies and clears deadlines", async () => {
    rs.useFakeTimers();
    const transport = new HungTransport();
    const client = new KernelWorkerClient(transport, 50);
    try {
        const first = client.request("ready", undefined);
        const second = client.request("stats", undefined);
        await rs.advanceTimersByTimeAsync(50);
        expect(await first).toMatchObject({ ok: false, error: { code: "timeout" } });
        expect(await second).toMatchObject({ ok: false, error: { code: "timeout" } });
        expect(transport.terminated).toBe(1);
        expect(client.pendingRequests).toBe(0);
        expect(client.pendingNative).toBe(0);
        transport.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "result", id: 1, result: { ok: true, value: undefined } },
            }),
        );
        expect(transport.messages).toHaveLength(2);
        await rs.advanceTimersByTimeAsync(500);
        expect(transport.terminated).toBe(1);
    } finally {
        client.dispose();
    }
});

test("cancelled native work keeps its deadline until it returns or its generation is terminated", async () => {
    rs.useFakeTimers();
    const transport = new HungTransport();
    const client = new KernelWorkerClient(transport, 50);
    const abort = new AbortController();
    try {
        const first = client.request("ready", undefined, abort.signal);
        abort.abort();
        expect(await first).toMatchObject({ ok: false, error: { code: "cancelled" } });
        expect(client.pendingNative).toBe(1);
        await rs.advanceTimersByTimeAsync(50);
        expect(transport.terminated).toBe(1);
        expect(client.pendingNative).toBe(0);
    } finally {
        client.dispose();
    }
});

test.each([0, -1, Infinity, Number.NaN, 90_001])("a nonbounded deadline %s is refused", (deadline) => {
    const transport = new HungTransport();
    expect(() => new KernelWorkerClient(transport, deadline)).toThrow("deadline must be finite");
    expect(transport.terminated).toBe(1);
});

test("the strict bridge recreates a timed-out worker and the following operation succeeds", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const hung = new HungTransport();
    let native: NativeWorkerTransport | undefined;
    let generations = 0;
    const hybrid = new HybridShapeFactory(() => {
        if (++generations === 1) return new KernelWorkerClient(hung, 10);
        native = new NativeWorkerTransport();
        return native.client;
    });
    try {
        rs.useFakeTimers();
        const failed = hybrid.shapeOperation({ method: "fillet", shape: box, edges: [0], value: 1 });
        await rs.advanceTimersByTimeAsync(10);
        await failed.ready;
        expect(failed.take().error).toContain("timed out");
        expect(failed.canFallback).toBe(false);
        expect(hung.terminated).toBe(1);
        expect(hybrid.failure).toBeUndefined();
        rs.useRealTimers();
        const next = hybrid.shapeOperation({ method: "chamfer", shape: box, edges: [0], value: 1 });
        await next.ready;
        const shape = keep(unwrapOk(next.take()));
        expect(shape.checkShape()).toBe(true);
        expect(shape.volume()).toBeLessThan(box.volume());
        expect(generations).toBe(2);
        expect(native?.requests.some((r) => r.type === "request" && r.operation === "boundedReplica")).toBe(
            true,
        );
    } finally {
        hybrid.dispose();
    }
});

test.each(["fillet", "chamfer"] as const)("bounded %s matches the main-thread result", async (method) => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const operation = hybrid.shapeOperation({ method, shape: box, edges: [0], value: 1 });
        await operation.ready;
        const result = keep(unwrapOk(operation.take()));
        const baseline = keep(unwrapOk(factory[method](box, [0], 1)));
        expect(result.checkShape()).toBe(true);
        expect(result.volume()).toBeCloseTo(baseline.volume(), 7);
        const faces = result.findSubShapes(ShapeTypes.face);
        owned.push(...faces);
        const expectedFaces = baseline.findSubShapes(ShapeTypes.face);
        owned.push(...expectedFaces);
        expect(faces).toHaveLength(expectedFaces.length);
        expect(transport.client.isClosed).toBe(true);
    } finally {
        hybrid.dispose();
    }
});

test.each([
    "booleanFuse",
    "booleanCut",
    "booleanCommon",
] as const)("bounded %s matches existing boolean behavior", async (method) => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const other = keep(box.transformedMul(Matrix4.fromTranslation(3, 4, 5)));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const operation = hybrid.shapeOperation({ method, left: [box], right: [other] });
        await operation.ready;
        const result = keep(unwrapOk(operation.take()));
        const baseline = keep(unwrapOk(factory[method]([box], [other], false)));
        expect(result.checkShape()).toBe(true);
        expect(result.volume()).toBeCloseTo(baseline.volume(), 7);
    } finally {
        hybrid.dispose();
    }
});

test("a thick-solid opening face is mapped onto the verified worker input", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const operation = hybrid.shapeOperation({
            method: "makeThickSolidByJoin",
            shape: box,
            closingFaces: [faces[0]],
            thickness: -1,
            joinType: "arc",
            mode: "skin",
            intersection: false,
        });
        await operation.ready;
        const result = keep(unwrapOk(operation.take()));
        const baseline = keep(unwrapOk(factory.makeThickSolidByJoin(box, [faces[0]], -1, "arc")));
        expect(result.checkShape()).toBe(true);
        expect(result.volume()).toBeCloseTo(baseline.volume(), 7);
        const request = transport.requests.find(
            (r) => r.type === "request" && r.operation === "boundedReplica",
        );
        expect(request).toMatchObject({ args: { closingFaces: [0] } });
    } finally {
        hybrid.dispose();
    }
});

test("an opening face from a different shape fails before entering the worker", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const other = keep(createBox(factory));
    const faces = other.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const createWorker = rs.fn(() => new NativeWorkerTransport().client);
    const hybrid = new HybridShapeFactory(createWorker);
    try {
        const task = hybrid.shapeOperation({
            method: "makeThickSolidByJoin",
            shape: box,
            closingFaces: [faces[0]],
            thickness: -1,
            joinType: "arc",
            mode: "skin",
            intersection: false,
        });
        await task.ready;
        expect(task.take().error).toBe("Opening face is not part of the input shape");
        expect(createWorker).not.toHaveBeenCalled();
    } finally {
        hybrid.dispose();
    }
});

test("a bounded thicken failure names the limiting curvature region", async () => {
    const factory = new ShapeFactory();
    const sphere = keep(createSphere(factory, undefined, 2));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const task = hybrid.shapeOperation({
            method: "makeThickSolidByJoin",
            shape: sphere,
            closingFaces: [],
            thickness: -3.75,
            joinType: "arc",
            mode: "skin",
            intersection: false,
        });
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("input face index 0 near (");
        expect(result.error).toContain("curvature radius 2 mm <= |thickness| 3.75 mm");
        expect(sphere.checkShape()).toBe(true);
        expect(sphere.volume()).toBeCloseTo((4 / 3) * Math.PI * 8, 6);
    } finally {
        hybrid.dispose();
    }
});

test("bounded loft prepares edge sections through the existing section rules", async () => {
    const factory = new ShapeFactory();
    const a = keep(unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 5)));
    const b = keep(unwrapOk(factory.circle(XYZ.unitZ, new XYZ(0, 0, 10), 7)));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const task = hybrid.shapeOperation({
            method: "loft",
            sections: [a, b],
            isSolid: true,
            isRuled: false,
            continuity: "c2",
        });
        await task.ready;
        const result = keep(unwrapOk(task.take()));
        const baseline = keep(unwrapOk(factory.loft([a, b], true, false, "c2")));
        expect(result.checkShape()).toBe(true);
        expect(result.volume()).toBeCloseTo(baseline.volume(), 7);
    } finally {
        hybrid.dispose();
    }
});

test("bounded fuse applies requested simplification before exporting its replica", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const other = keep(box.transformedMul(Matrix4.fromTranslation(5, 0, 0)));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const task = hybrid.shapeOperation({
            method: "booleanFuse",
            left: [box],
            right: [other],
            simplifyShape: true,
        });
        await task.ready;
        const result = keep(unwrapOk(task.take()));
        const baseline = keep(unwrapOk(factory.booleanFuse([box], [other], true)));
        const faces = result.findSubShapes(ShapeTypes.face);
        owned.push(...faces);
        const expected = baseline.findSubShapes(ShapeTypes.face);
        owned.push(...expected);
        expect(faces).toHaveLength(6);
        expect(faces).toHaveLength(expected.length);
        expect(result.volume()).toBeCloseTo(baseline.volume(), 7);
    } finally {
        hybrid.dispose();
    }
});

test("bounded simple thickening repairs the existing open-shell result orientation", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const shell = keep(unwrapOk(factory.shell(faces.slice(0, 5))));
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const task = hybrid.shapeOperation({ method: "makeThickSolidBySimple", shape: shell, thickness: 1 });
        await task.ready;
        const result = keep(unwrapOk(task.take()));
        const baseline = keep(unwrapOk(factory.makeThickSolidBySimple(shell, 1)));
        expect(result.checkShape()).toBe(true);
        expect(baseline.volume()).toBeLessThan(0);
        expect(result.volume()).toBeCloseTo(-baseline.volume(), 7);
    } finally {
        hybrid.dispose();
    }
});

test("bounded thickening preserves the configured intersection face limit before creating a worker", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const createWorker = rs.fn(() => new NativeWorkerTransport().client);
    const hybrid = new HybridShapeFactory(createWorker);
    const previous = Config.instance.thickSolidIntersectionMaxFaces;
    try {
        Config.instance.thickSolidIntersectionMaxFaces = 5;
        const task = hybrid.shapeOperation({
            method: "makeThickSolidByJoin",
            shape: box,
            closingFaces: [],
            thickness: -1,
            joinType: "intersection",
            mode: "skin",
            intersection: false,
        });
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("6 faces (limit 5)");
        expect(createWorker).not.toHaveBeenCalled();
    } finally {
        Config.instance.thickSolidIntersectionMaxFaces = previous;
        hybrid.dispose();
    }
});

test("an unavailable strict worker returns an error without offering synchronous fallback", async () => {
    const factory = new ShapeFactory();
    const box = keep(createBox(factory));
    const hybrid = new HybridShapeFactory(() => {
        throw new Error("Worker unavailable");
    });
    try {
        const task = hybrid.shapeOperation({ method: "fillet", shape: box, edges: [0], value: 1 });
        await task.ready;
        expect(task.canFallback).toBe(false);
        expect(task.take().error).toBe("Worker unavailable");
        expect(box.volume()).toBeCloseTo(6000, 7);
    } finally {
        hybrid.dispose();
    }
});

test("strict abort terminates the native generation, cancels all pending calls, and clears its deadline", async () => {
    rs.useFakeTimers();
    const transport = new HungTransport();
    const client = new KernelWorkerClient(transport);
    const signal = new AbortController();
    try {
        const active = client.request("ready", undefined, signal.signal, { terminateOnAbort: true });
        const queued = client.request("stats", undefined);
        signal.abort();
        expect(await active).toMatchObject({ ok: false, error: { code: "cancelled" } });
        expect(await queued).toMatchObject({ ok: false, error: { code: "cancelled" } });
        expect(transport.terminated).toBe(1);
        expect(client.pendingNative).toBe(0);
        expect(client.pendingRequests).toBe(0);
        const sent = transport.messages.length;
        transport.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "result", id: 1, result: { ok: true, value: undefined } },
            }),
        );
        expect(transport.messages).toHaveLength(sent);
        await rs.advanceTimersByTimeAsync(90_000);
        expect(transport.terminated).toBe(1);
    } finally {
        client.dispose();
    }
});

test("strict signal abort retires its worker and the immediate next operation uses a fresh generation", async () => {
    const box = keep(createBox(new ShapeFactory()));
    const transport = new HungTransport();
    const signal = new AbortController();
    let generations = 0;
    const hybrid = new HybridShapeFactory(() =>
        ++generations === 1 ? new KernelWorkerClient(transport) : new NativeWorkerTransport().client,
    );
    try {
        const operation = hybrid.shapeOperation(
            { method: "fillet", shape: box, edges: [0], value: 1 },
            signal.signal,
        );
        signal.abort();
        const next = hybrid.shapeOperation({ method: "chamfer", shape: box, edges: [0], value: 1 });
        await operation.ready;
        expect(operation.take().error).toContain("cancelled");
        expect(operation.canFallback).toBe(false);
        expect(transport.terminated).toBe(1);
        expect(hybrid.failure).toBeUndefined();
        await next.ready;
        const result = keep(unwrapOk(next.take()));
        expect(result.checkShape()).toBe(true);
        expect(result.volume()).toBeLessThan(box.volume());
        expect(generations).toBe(2);
    } finally {
        hybrid.dispose();
    }
});

test("pre-aborted strict work never serializes inputs or creates a worker", async () => {
    const box = keep(createBox(new ShapeFactory()));
    const serialize = rs.spyOn(wasm.Converter, "convertToBrep");
    const createWorker = rs.fn(() => new NativeWorkerTransport().client);
    const hybrid = new HybridShapeFactory(createWorker);
    const signal = new AbortController();
    signal.abort();
    try {
        const operation = hybrid.shapeOperation(
            { method: "fillet", shape: box, edges: [0], value: 1 },
            signal.signal,
        );
        await operation.ready;
        expect(operation.take().error).toContain("cancelled");
        expect(createWorker).not.toHaveBeenCalled();
        expect(serialize).not.toHaveBeenCalled();
    } finally {
        serialize.mockRestore();
        hybrid.dispose();
    }
});

test("an already completed strict result wins over a late signal abort and detaches its listener", async () => {
    const box = keep(createBox(new ShapeFactory()));
    const transport = new NativeWorkerTransport();
    const terminate = rs.spyOn(transport, "terminate");
    const signal = new AbortController();
    const remove = rs.spyOn(signal.signal, "removeEventListener");
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const operation = hybrid.shapeOperation(
            { method: "fillet", shape: box, edges: [0], value: 1 },
            signal.signal,
        );
        await operation.ready;
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        signal.abort();
        const result = keep(unwrapOk(operation.take()));
        expect(result.checkShape()).toBe(true);
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(transport.client.pendingNative).toBe(0);
    } finally {
        remove.mockRestore();
        terminate.mockRestore();
        hybrid.dispose();
    }
});

test("cancelling a bounded operation leaves a simultaneous boolean request running", async () => {
    const transports: HungTransport[] = [];
    const hybrid = new HybridShapeFactory(() => {
        const transport = new HungTransport();
        transports.push(transport);
        return new KernelWorkerClient(transport);
    });
    const box = keep(createBox(new ShapeFactory()));
    try {
        const boolean = hybrid.booleanTracked("fuse", [box], [box]);
        expect(boolean).not.toBeUndefined();
        const bounded = hybrid.shapeOperation({ method: "fillet", shape: box, edges: [0], value: 1 });
        expect(transports).toHaveLength(2);
        bounded.cancel();
        await bounded.ready;
        expect(transports[1].terminated).toBe(1);
        expect(transports[0].terminated).toBe(0);
        expect(hybrid.available).toBe(true);
        boolean!.cancel();
    } finally {
        hybrid.dispose();
    }
});

test.each([
    true,
    false,
])("bounded self-intersection forwards the kernel answer %s without touching the source", async (answer) => {
    const box = keep(createBox(new ShapeFactory()));
    const binding = rs.spyOn(wasm.Shape, "checkSelfIntersection").mockReturnValue(answer);
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        const task = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: box });
        expect(binding).not.toHaveBeenCalled();
        await task.ready;
        expect(unwrapOk(task.take())).toBe(answer);
        expect(binding).toHaveBeenCalledTimes(1);
        expect(transport.client.isClosed).toBe(true);
        expect(box.volume()).toBeCloseTo(6000, 7);
    } finally {
        binding.mockRestore();
        hybrid.dispose();
    }
});

function freeFormShell() {
    const factory = new ShapeFactory();
    const sections = Array.from({ length: 9 }, (_, i) =>
        keep(
            unwrapOk(
                factory.polygon(
                    Array.from({ length: 8 }, (_, j) => {
                        const angle = ((j % 7) * 2 * Math.PI) / 7;
                        const radius = 80 + 15 * Math.sin(i * 0.6 + angle);
                        return new XYZ(radius * Math.cos(angle) + i * 3, radius * Math.sin(angle), i * 25);
                    }),
                ),
            ),
        ),
    );
    return keep(unwrapOk(factory.loft(sections, false, false, "c2")));
}

test.each([
    "timeout",
    "cancel",
] as const)("a large free-form shell check ends on %s and the next query uses a fresh worker", async (stop) => {
    const shell = freeFormShell();
    const before = wasm.Converter.convertToBrep((shell as OccShape).shape);
    const faces = shell.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    expect(faces).toHaveLength(7);
    const transport = new HungTransport();
    let generations = 0;
    const hybrid = new HybridShapeFactory(() =>
        ++generations === 1 ? new KernelWorkerClient(transport) : new NativeWorkerTransport().client,
    );
    const signal = new AbortController();
    const budget = Config.instance.slowOpWarningSeconds;
    try {
        Config.instance.slowOpWarningSeconds = 30;
        rs.useFakeTimers();
        const task = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: shell }, signal.signal);
        expect(transport.messages[0]).toMatchObject({ operation: "checkSelfIntersectionReplica" });
        await rs.advanceTimersByTimeAsync(29_999);
        expect(transport.terminated).toBe(0);
        if (stop === "cancel") signal.abort();
        else await rs.advanceTimersByTimeAsync(1);
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain(stop === "cancel" ? "cancelled" : "timed out after 30000 ms");
        expect(task.canFallback).toBe(false);
        expect(transport.terminated).toBe(1);
        expect(wasm.Converter.convertToBrep((shell as OccShape).shape)).toBe(before);
        expect(shell.checkShape()).toBe(true);
        rs.useRealTimers();
        const box = keep(createBox(new ShapeFactory()));
        const next = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: box });
        await next.ready;
        expect(unwrapOk(next.take())).toBe(true);
        expect(generations).toBe(2);
    } finally {
        Config.instance.slowOpWarningSeconds = budget;
        hybrid.dispose();
    }
});

test.each([5, Infinity])("self-intersection stays bounded with slow-op budget %s", async (seconds) => {
    const box = keep(createBox(new ShapeFactory()));
    const transport = new HungTransport();
    const hybrid = new HybridShapeFactory(() => new KernelWorkerClient(transport));
    const previous = Config.instance.slowOpWarningSeconds;
    try {
        rs.useFakeTimers();
        Config.instance.slowOpWarningSeconds = seconds;
        const task = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: box });
        const deadline = seconds === Infinity ? 30_000 : seconds * 1000;
        await rs.advanceTimersByTimeAsync(deadline);
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toBe(`Self-intersection check timed out after ${deadline} ms (result unknown)`);
        expect(transport.terminated).toBe(1);
    } finally {
        Config.instance.slowOpWarningSeconds = previous;
        hybrid.dispose();
    }
});

test.each([
    "missing",
    "failure",
] as const)("a %s self-intersection binding returns an error Result", async (mode) => {
    const box = keep(createBox(new ShapeFactory()));
    const original = wasm.Shape.checkSelfIntersection;
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    try {
        if (mode === "missing")
            Object.defineProperty(wasm.Shape, "checkSelfIntersection", {
                value: undefined,
                configurable: true,
                writable: true,
            });
        else
            wasm.Shape.checkSelfIntersection = () => {
                throw new Error("native check failed");
            };
        const task = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: box });
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain(
            mode === "missing"
                ? "not available in this kernel build"
                : "Worker operation failed: checkSelfIntersectionReplica",
        );
        expect(task.canFallback).toBe(false);
        expect(transport.client.isClosed).toBe(true);
        expect(box.volume()).toBeCloseTo(6000, 7);
    } finally {
        wasm.Shape.checkSelfIntersection = original;
        hybrid.dispose();
    }
});

test("a pre-aborted self-intersection query never copies inputs or creates a worker", async () => {
    const box = keep(createBox(new ShapeFactory()));
    const serialize = rs.spyOn(wasm.Converter, "convertToBrep");
    const createWorker = rs.fn(() => new NativeWorkerTransport().client);
    const hybrid = new HybridShapeFactory(createWorker);
    const signal = new AbortController();
    signal.abort();
    try {
        const task = hybrid.shapeQuery({ method: "checkSelfIntersection", shape: box }, signal.signal);
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("cancelled");
        expect(createWorker).not.toHaveBeenCalled();
        expect(serialize).not.toHaveBeenCalled();
    } finally {
        serialize.mockRestore();
        hybrid.dispose();
    }
});
