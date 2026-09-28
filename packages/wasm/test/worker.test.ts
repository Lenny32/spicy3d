// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MainModule } from "../lib/spicy-wasm";
import { type IKernelWorkerTransport, KernelWorkerClient } from "../src/workerClient";
import { KernelWorkerHost } from "../src/workerHost";
import { WorkerKernel } from "../src/workerKernel";
import type { KernelMessage, KernelRequest, KernelResponse, KernelResult } from "../src/workerProtocol";
import { testAx3 } from "./helpers";
import "./setup";

function ok<T>(result: KernelResult<T>): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
}

const box = { origin: { x: 0, y: 0, z: 0 }, size: { x: 10, y: 20, z: 30 } };

/** Real native kernel, real structured-clone transfers; manually deliver answers to force races. */
class Transport extends EventTarget implements IKernelWorkerTransport {
    readonly kernel = new WorkerKernel(wasm);
    readonly replies: KernelResponse[] = [];
    readonly detached: ArrayBuffer[] = [];
    readonly host = new KernelWorkerHost(this.kernel, (reply, transfer) => {
        this.replies.push(structuredClone(reply, { transfer }));
        this.detached.push(...transfer);
    });
    terminated = false;
    postMessage(message: KernelMessage): void {
        this.host.receive(structuredClone(message));
    }
    terminate(): void {
        this.terminated = true;
        this.host.dispose();
    }
    async deliver(): Promise<void> {
        await rs.waitFor(() => expect(this.replies.length).toBeGreaterThan(0));
        this.dispatchEvent(new MessageEvent("message", { data: this.replies.shift() }));
    }
    async call<T>(promise: Promise<KernelResult<T>>): Promise<T> {
        await this.deliver();
        return ok(await promise);
    }
}

test("real kernel handles survive acceptance, transfer meshes, round-trip BREP and release explicitly", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const handle = await transport.call(client.request("box", box));
        const bounds = await transport.call(client.request("bounds", { handle }));
        expect(bounds.min.x).toBeCloseTo(0, 6);
        expect(bounds.max.x).toBeCloseTo(10, 6);
        expect(bounds.max.y).toBeCloseTo(20, 6);
        expect(bounds.max.z).toBeCloseTo(30, 6);
        const brep = await transport.call(client.request("exportBrep", { handle }));
        const copy = await transport.call(client.request("importBrep", { brep }));
        expect(await transport.call(client.request("bounds", { handle: copy }))).toEqual(bounds);
        const mesh = await transport.call(client.request("mesh", { handle }));
        expect(mesh.indices.length).toBe(36);
        expect(mesh.faceGroups.length).toBe(12);
        expect(mesh.positions.length).toBeGreaterThan(0);
        expect(mesh.normals.length).toBe(mesh.positions.length);
        expect(transport.detached.length).toBe(7);
        expect(transport.detached.every((buffer) => buffer.byteLength === 0)).toBe(true);
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 2 });
        await transport.call(client.request("release", { handles: [handle, copy, copy] }));
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 0 });
        const invalid = client.request("bounds", { handle });
        await transport.deliver();
        expect(await invalid).toMatchObject({ ok: false, error: { code: "invalid" } });
    } finally {
        client.dispose();
    }
});

test.each([
    "fuse",
    "cut",
    "common",
] as const)("tracked %s preserves all history channels", async (operation) => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const a = await transport.call(client.request("box", box));
        const b = await transport.call(client.request("box", { ...box, origin: { x: 5, y: 0, z: 0 } }));
        const result = await transport.call(client.request("boolean", { operation, left: [a], right: [b] }));
        const bounds = await transport.call(client.request("bounds", { handle: result.handle }));
        expect(bounds.max.x).toBeCloseTo(operation === "fuse" ? 15 : operation === "cut" ? 5 : 10, 6);
        expect(result.tracking.faceMap.length).toBeGreaterThan(0);
        expect(result.tracking.edgeMap.length).toBeGreaterThan(0);
        expect(result.tracking.faceAncestors.length).toBeGreaterThan(0);
        expect(result.tracking.edgeAncestors.length).toBeGreaterThan(0);
        expect(result.tracking.capFaces).toBeInstanceOf(Int32Array);
        expect(result.tracking.faceEdgeMap).toBeInstanceOf(Int32Array);
        // Compare the complete synthetic BREP and every history channel with the direct native path.
        const first = wasm.ShapeFactory.box(testAx3, 10, 20, 30);
        const second = wasm.ShapeFactory.box({ ...testAx3, location: { x: 5, y: 0, z: 0 } }, 10, 20, 30);
        expect(first.isOk && second.isOk).toBe(true);
        const methods = {
            fuse: wasm.ShapeFactory.booleanFuseTracked,
            cut: wasm.ShapeFactory.booleanCutTracked,
            common: wasm.ShapeFactory.booleanCommonTracked,
        };
        const baseline = methods[operation]([first.shape], [second.shape]);
        try {
            expect(baseline.isOk).toBe(true);
            expect(await transport.call(client.request("exportBrep", { handle: result.handle }))).toBe(
                wasm.Converter.convertToBrep(baseline.shape),
            );
            for (const key of Object.keys(result.tracking) as (keyof typeof result.tracking)[]) {
                const vector = baseline[key];
                try {
                    expect(result.tracking[key]).toEqual(Int32Array.from(vector));
                } finally {
                    vector.delete();
                }
            }
        } finally {
            baseline.delete();
            second.delete();
            first.delete();
        }
        expect(transport.detached.every((buffer) => buffer.byteLength === 0)).toBe(true);
    } finally {
        client.dispose();
    }
    expect(transport.terminated).toBe(true);
    expect(
        ok(transport.kernel.execute({ type: "request", id: 99, operation: "stats", args: undefined }, [])),
    ).toEqual({ shapes: 0 });
});

test("cancellation before execution never allocates a shape", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const abort = new AbortController();
        const pending = client.request("box", box, abort.signal);
        abort.abort();
        expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
        await transport.deliver(); // Terminal queued-cancellation acknowledgement drains native accounting.
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 0 });
    } finally {
        client.dispose();
    }
});

test("cancellation after native completion disposes an unaccepted result and ignores its late answer", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const abort = new AbortController();
        const pending = client.request("box", box, abort.signal);
        await rs.waitFor(() => expect(transport.replies.length).toBe(1));
        expect(
            ok(
                transport.kernel.execute(
                    { type: "request", id: 99, operation: "stats", args: undefined },
                    [],
                ),
            ),
        ).toEqual({ shapes: 1 });
        abort.abort();
        expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
        await transport.deliver();
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 0 });
    } finally {
        client.dispose();
    }
});

test("request ids match out-of-order results; abort after acceptance does not dispose a caller-owned shape", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const abort = new AbortController();
        const a = client.request("box", box, abort.signal);
        const b = client.request("stats", undefined);
        await rs.waitFor(() => expect(transport.replies.length).toBe(2));
        transport.replies.reverse();
        await transport.deliver();
        expect(ok(await b)).toEqual({ shapes: 1 });
        await transport.deliver();
        const handle = ok(await a);
        abort.abort();
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 1 });
        expect((await transport.call(client.request("bounds", { handle }))).max.z).toBeCloseTo(30, 6);
    } finally {
        client.dispose();
    }
});

test.each([
    "error",
    "messageerror",
    "fatal",
    "dispose",
])("%s settles every pending caller and closes transport", async (kind) => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    const a = client.request("ready", undefined);
    const b = client.request("box", box);
    if (kind === "dispose") client.dispose();
    else if (kind === "fatal")
        transport.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "fatal", message: "Failed" },
            }),
        );
    else transport.dispatchEvent(new Event(kind));
    expect(await a).toMatchObject({ ok: false });
    expect(await b).toMatchObject({ ok: false });
    expect(transport.terminated).toBe(true);
    expect(await client.request("ready", undefined)).toMatchObject({ ok: false, error: { code: "closed" } });
});

test("foreign-session handles cannot alias an existing shape", () => {
    const a = new WorkerKernel(wasm);
    const b = new WorkerKernel(wasm);
    try {
        const first = ok(a.execute({ type: "request", id: 1, operation: "box", args: box }, [])) as string;
        ok(b.execute({ type: "request", id: 1, operation: "box", args: box }, []));
        expect(
            b.execute({ type: "request", id: 2, operation: "bounds", args: { handle: first } }, []),
        ).toEqual({ ok: false, error: { code: "invalid", message: "Unknown or released worker shape" } });
    } finally {
        a.dispose();
        b.dispose();
    }
});

test("failed postMessage settles rather than stranding a caller", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    rs.spyOn(transport, "postMessage").mockImplementation(() => {
        throw new DOMException("closed");
    });
    try {
        expect(await client.request("ready", undefined)).toMatchObject({
            ok: false,
            error: { code: "kernel" },
        });
        expect(transport.terminated).toBe(true);
    } finally {
        client.dispose();
        rs.restoreAllMocks();
    }
});

test("failed acceptance closes the heap and settles the pending result", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    const pending = client.request("box", box);
    await rs.waitFor(() => expect(transport.replies.length).toBe(1));
    rs.spyOn(transport, "postMessage").mockImplementation(() => {
        throw new DOMException("closed");
    });
    try {
        await transport.deliver();
        expect(await pending).toMatchObject({ ok: false, error: { code: "kernel" } });
        expect(transport.terminated).toBe(true);
        expect(
            ok(
                transport.kernel.execute(
                    { type: "request", id: 99, operation: "stats", args: undefined },
                    [],
                ),
            ),
        ).toEqual({ shapes: 0 });
    } finally {
        client.dispose();
        rs.restoreAllMocks();
    }
});

test("invalid dimensions fail before entering an unsafe native constructor", async () => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    try {
        const invalid = client.request("box", { ...box, size: { x: Number.NaN, y: 0, z: 0 } });
        await transport.deliver();
        expect(await invalid).toMatchObject({ ok: false, error: { code: "invalid" } });
        expect(await transport.call(client.request("stats", undefined))).toEqual({ shapes: 0 });
    } finally {
        client.dispose();
    }
});

test("a native trap stops the queue without touching the potentially invalid heap", async () => {
    const transport = new Transport();
    const execute = rs.spyOn(transport.kernel, "execute").mockImplementation(() => {
        throw new WebAssembly.RuntimeError("unreachable");
    });
    const release = rs.spyOn(transport.kernel, "release");
    try {
        transport.postMessage({ type: "request", id: 1, operation: "box", args: box });
        transport.postMessage({ type: "request", id: 2, operation: "ready", args: undefined });
        await rs.waitFor(() =>
            expect(transport.replies).toEqual([
                { type: "fatal", message: "Geometry worker native runtime failed" },
            ]),
        );
        transport.postMessage({ type: "request", id: 3, operation: "box", args: box });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
    } finally {
        rs.restoreAllMocks();
        // The test injected a trap without damaging the real kernel; the browser would terminate it.
        transport.terminate();
    }
});

test.each([
    null,
    undefined,
    {},
    [],
    { type: "unknown" },
    { type: "result", id: 1 },
    { type: "result", id: 1, result: null },
    { type: "result", id: 1, result: { ok: true } },
    { type: "result", id: 1, result: { ok: false, error: {} } },
    { type: "fatal" },
    { type: "fatal", message: "invalid", code: "unknown" },
    { type: "result", id: 1, result: { ok: false, error: { code: ["kernel"], message: "invalid" } } },
])("malformed response %j closes and settles without acknowledging", async (data) => {
    const transport = new Transport();
    const client = new KernelWorkerClient(transport);
    const first = client.request("ready", undefined);
    const second = client.request("box", box);
    const sent = rs.spyOn(transport, "postMessage");
    try {
        transport.dispatchEvent(new MessageEvent("message", { data }));
        expect(await first).toMatchObject({
            ok: false,
            error: { message: "Invalid geometry worker response" },
        });
        expect(await second).toMatchObject({ ok: false });
        expect(sent).not.toHaveBeenCalled();
        expect(transport.terminated).toBe(true);
    } finally {
        client.dispose();
        rs.restoreAllMocks();
    }
});

test.each([
    "result",
    "location",
    "vector",
    "mesh",
    "cleanup",
] as const)("native %s trap skips every enclosing native cleanup", (stage) => {
    const trap = () => {
        throw new WebAssembly.RuntimeError("injected trap");
    };
    const destroyed = rs.fn();
    const location = { delete: destroyed };
    const shape = {
        getLocation: () => location,
        located: stage === "location" ? trap : (): object => shape,
        isNull: () => false,
        delete: destroyed,
    };
    const result = {
        get isOk() {
            return stage === "result" ? trap() : true;
        },
        shape,
        faceMap: { [Symbol.iterator]: trap, delete: destroyed },
        delete: stage === "cleanup" ? trap : destroyed,
    };
    const module = {
        ...wasm,
        ShapeFactory: { ...wasm.ShapeFactory, box: () => result, booleanFuseTracked: () => result },
        Converter: { ...wasm.Converter, convertFromBrep: () => shape },
        Mesher: class {
            delete = destroyed;
            mesh = trap;
        },
    } as unknown as MainModule;
    const kernel = new WorkerKernel(module);
    const id = ok(
        kernel.execute({ type: "request", id: 1, operation: "importBrep", args: { brep: "test" } }, []),
    ) as string;
    destroyed.mockClear();
    const request: KernelRequest =
        stage === "vector"
            ? {
                  type: "request",
                  id: 2,
                  operation: "boolean",
                  args: { operation: "fuse", left: [id], right: [id] },
              }
            : stage === "mesh"
              ? { type: "request", id: 2, operation: "mesh", args: { handle: id } }
              : { type: "request", id: 2, operation: "box", args: box };
    expect(() => kernel.execute(request, [])).toThrow(WebAssembly.RuntimeError);
    // The location is validly released before the later result.delete trap; nothing follows it.
    expect(destroyed).toHaveBeenCalledTimes(stage === "cleanup" ? 1 : 0);
    kernel.dispose();
    expect(destroyed).toHaveBeenCalledTimes(stage === "cleanup" ? 1 : 0);
    expect(() =>
        kernel.execute({ type: "request", id: 3, operation: "bounds", args: { handle: id } }, []),
    ).toThrow("Geometry worker heap is unavailable");
});
