// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PerformanceTrace } from "@spicy3d/core";
import type { MainModule, TrackedShapeResult } from "../lib/spicy-wasm";
import { captureReplica } from "../src/replicaTopology";
import { WorkerKernel } from "../src/workerKernel";
import { workerProfile } from "../src/workerProfile";
import type { BooleanReplica, KernelResponse, KernelResult } from "../src/workerProtocol";
import { testAx3 } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

function ok<T>(result: KernelResult<T>): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
}
const box = { origin: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 20, z: 30 } };
let transport: NativeWorkerTransport | undefined;
beforeEach(() => {
    PerformanceTrace.disable();
    expect(workerProfile.reset()).toBe(true);
});
afterEach(() => {
    rs.restoreAllMocks();
    transport?.client.dispose();
    transport = undefined;
    PerformanceTrace.disable();
    expect(workerProfile.reset()).toBe(true);
});

test("untraced worker booleans, replica export and meshes read no profiling clock and allocate no events", () => {
    // Control native calls that may legitimately read a platform clock themselves. The remaining
    // actual kernel ownership/clone/export/verification paths run unchanged, including nativeMs.
    const nativeBox = wasm.ShapeFactory.box(testAx3, 10, 20, 30);
    expect(nativeBox.isOk).toBe(true);
    const vector = () => Object.assign([0], { delete: () => {} });
    const module = {
        ...wasm,
        ShapeFactory: {
            ...wasm.ShapeFactory,
            booleanFuseTracked: () =>
                ({
                    isOk: true,
                    shape: nativeBox.shape,
                    delete: () => {},
                    faceMap: vector(),
                    edgeMap: vector(),
                    faceEdgeMap: vector(),
                    faceAncestors: vector(),
                    edgeAncestors: vector(),
                    capFaces: vector(),
                }) as unknown as TrackedShapeResult,
        },
        Mesher: class {
            delete() {}
            mesh() {
                return {
                    delete: () => {},
                    faceMeshData: {
                        delete: () => {},
                        position: [],
                        normal: [],
                        uv: [],
                        index: [],
                        group: [],
                        faces: [],
                    },
                    edgeMeshData: { delete: () => {}, position: [], group: [], edges: [] },
                };
            }
        },
    } as unknown as MainModule;
    const kernel = new WorkerKernel(module);
    const snapshot = captureReplica(wasm, nativeBox.shape);
    try {
        const handle = ok(
            kernel.execute({ type: "request", id: 1, operation: "box", args: box }, []),
        ) as string;
        const clock = rs.spyOn(performance, "now").mockReturnValue(10);
        const replica = ok(
            kernel.execute(
                {
                    type: "request",
                    id: 2,
                    operation: "booleanReplica",
                    args: { operation: "fuse", left: [snapshot], right: [snapshot] },
                },
                [],
            ),
        ) as BooleanReplica;
        ok(kernel.execute({ type: "request", id: 3, operation: "mesh", args: { handle } }, []));
        expect(clock).not.toHaveBeenCalled();
        expect(replica.nativeMs).toBeUndefined();
        expect(kernel.takeEvents()).toBeUndefined();

        ok(
            kernel.execute(
                {
                    type: "request",
                    id: 4,
                    operation: "booleanReplica",
                    trace: 1,
                    args: { operation: "fuse", left: [snapshot], right: [snapshot] },
                },
                [],
            ),
        );
        const events = kernel.takeEvents();
        expect(events?.map((event) => event.stage)).toEqual([
            "worker.replica.import",
            "worker.replica.verify",
            "worker.replica.import",
            "worker.replica.verify",
            "worker.kernel.operation",
            "worker.kernel.historyConversion",
            "worker.replica.export",
        ]);
        expect(clock.mock.calls.length).toBeGreaterThan(0);
        clock.mockClear();
        ok(kernel.execute({ type: "request", id: 5, operation: "mesh", args: { handle } }, []));
        expect(clock).not.toHaveBeenCalled(); // tracing does not stick on after the profiled request
        expect(kernel.takeEvents()).toBeUndefined();
    } finally {
        kernel.dispose();
        nativeBox.delete();
    }
});

test("request opt-in is fixed at submission and unprofiled work never enters counters", async () => {
    transport = new NativeWorkerTransport();
    const handle = ok(await transport.client.request("box", box));
    transport.hold = true;
    const untraced = transport.client.request("boolean", {
        operation: "fuse",
        left: [handle],
        right: [handle],
    });
    PerformanceTrace.enable();
    await rs.waitFor(() => expect(transport?.held.length).toBe(1));
    transport.deliver();
    ok(await untraced);
    expect(workerProfile.snapshot().booleanCount).toBe(0);
    expect(PerformanceTrace.snapshot().records).toEqual([]);
    ok(await transport.client.request("boolean", { operation: "fuse", left: [handle], right: [handle] }));
    expect(workerProfile.snapshot()).toMatchObject({
        booleanCount: 1,
        historyCount: 1,
        telemetryComplete: true,
    });
    expect(
        PerformanceTrace.snapshot().records.filter((event) => event.stage === "worker.kernel.operation"),
    ).toHaveLength(1);
});

test("cancelled but executed work stays profiled until terminal delivery, then drains", async () => {
    transport = new NativeWorkerTransport();
    const handle = ok(await transport.client.request("box", box));
    PerformanceTrace.enable();
    transport.hold = true;
    const abort = new AbortController();
    const task = transport.client.request(
        "boolean",
        { operation: "fuse", left: [handle], right: [handle] },
        abort.signal,
    );
    await rs.waitFor(() => expect(transport?.held.length).toBe(1));
    abort.abort();
    expect(await task).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(workerProfile.snapshot()).toMatchObject({ pendingRequests: 0, pendingNative: 1, booleanCount: 0 });
    transport.deliver();
    await transport.client.drain();
    expect(workerProfile.snapshot()).toMatchObject({
        pendingRequests: 0,
        pendingNative: 0,
        booleanCount: 1,
        historyCount: 1,
        telemetryComplete: true,
        dropped: 0,
    });
    expect(
        PerformanceTrace.snapshot().records.filter((event) => event.stage === "worker.kernel.operation"),
    ).toHaveLength(1);
});

test("late events cannot contaminate a newer capture; reset requires disabled and drained state", async () => {
    transport = new NativeWorkerTransport();
    const handle = ok(await transport.client.request("box", box));
    const epoch = workerProfile.snapshot().epoch;
    PerformanceTrace.enable();
    transport.hold = true;
    const task = transport.client.request("boolean", { operation: "fuse", left: [handle], right: [handle] });
    await rs.waitFor(() => expect(transport?.held.length).toBe(1));
    PerformanceTrace.disable();
    expect(workerProfile.reset()).toBe(false); // caller/native work is still outstanding
    PerformanceTrace.enable();
    transport.deliver();
    ok(await task);
    expect(PerformanceTrace.snapshot().records).toEqual([]);
    expect(workerProfile.snapshot()).toMatchObject({
        epoch,
        booleanCount: 1,
        historyCount: 1,
        telemetryComplete: false,
        dropped: 2,
    });
    expect(workerProfile.reset()).toBe(false); // active capture cannot reset its own counters
    PerformanceTrace.disable();
    await transport.client.drain();
    expect(workerProfile.reset()).toBe(true);
    expect(workerProfile.snapshot().epoch).not.toBe(epoch);
    expect(workerProfile.snapshot()).toMatchObject({
        booleanCount: 0,
        historyCount: 0,
        dropped: 0,
        telemetryComplete: true,
    });
});

test("profiling counters are cumulative across captures, but only explicitly traced invocations count", async () => {
    transport = new NativeWorkerTransport();
    const handle = ok(await transport.client.request("box", box));
    const epoch = workerProfile.snapshot().epoch;
    PerformanceTrace.enable();
    ok(await transport.client.request("boolean", { operation: "fuse", left: [handle], right: [handle] }));
    PerformanceTrace.disable();
    ok(await transport.client.request("boolean", { operation: "fuse", left: [handle], right: [handle] }));
    expect(workerProfile.snapshot()).toMatchObject({ epoch, booleanCount: 1 });
    PerformanceTrace.enable();
    ok(await transport.client.request("boolean", { operation: "fuse", left: [handle], right: [handle] }));
    expect(workerProfile.snapshot()).toMatchObject({
        epoch,
        booleanCount: 2,
        historyCount: 2,
        dropped: 0,
        telemetryComplete: true,
    });
    expect(
        PerformanceTrace.snapshot().records.filter((event) => event.stage === "worker.kernel.operation"),
    ).toHaveLength(1);
});

test("a reply-send failure preserves timings of the native work already executed", async () => {
    transport = new NativeWorkerTransport();
    const handle = ok(await transport.client.request("box", box));
    PerformanceTrace.enable();
    rs.spyOn(
        transport.host as unknown as {
            send(response: KernelResponse, transfers: ArrayBuffer[]): void;
        },
        "send",
    ).mockImplementationOnce(() => {
        throw new DOMException("clone failed", "DataCloneError");
    });
    const result = await transport.client.request("boolean", {
        operation: "fuse",
        left: [handle],
        right: [handle],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "kernel" } });
    expect(workerProfile.snapshot()).toMatchObject({
        booleanCount: 1,
        historyCount: 1,
        pendingNative: 0,
        telemetryComplete: true,
        dropped: 0,
    });
    expect(
        PerformanceTrace.snapshot().records.filter((event) => event.stage === "worker.kernel.operation"),
    ).toHaveLength(1);
});
