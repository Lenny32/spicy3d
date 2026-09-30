// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, Matrix4 } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import { OccShape } from "../src/shape";
import type { KernelRequest } from "../src/workerProtocol";
import { createBox, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

let transport: NativeWorkerTransport;
let hybrid: HybridShapeFactory;
let shapes: IShape[];
let base: IShape;
beforeEach(() => {
    transport = new NativeWorkerTransport();
    hybrid = new HybridShapeFactory(() => transport.client);
    shapes = [];
    base = createBox(new ShapeFactory());
    shapes.push(base);
});
afterEach(() => {
    rs.restoreAllMocks();
    for (const shape of shapes) shape.dispose();
    hybrid.dispose();
});

function start(input = base) {
    const task = hybrid.booleanTracked("fuse", [input], [base]);
    expect(task).not.toBeUndefined();
    if (!task) throw new Error("Missing hybrid operation");
    return task;
}
async function finish(task = start()): Promise<OccShape> {
    await task.ready;
    const answer = unwrapOk(task.take());
    for (const input of answer.inputs) input.dispose();
    shapes.push(answer.result.shape);
    return answer.result.shape as OccShape;
}
function requests() {
    return transport.requests.filter(
        (request): request is Extract<KernelRequest, { operation: "booleanReplica" }> =>
            request.type === "request" && request.operation === "booleanReplica",
    );
}
async function count() {
    const result = await transport.client.request("stats", undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.shapes;
}

test("the next step consumes the verified worker result instead of exporting/importing that prefix again", async () => {
    const first = await finish();
    expect(await count()).toBe(1);
    const next = start(first);
    expect(requests().at(-1)?.args.left[0]).toEqual({ handle: expect.any(String) });
    expect(requests().at(-1)?.args.right[0]).toHaveProperty("brep");
    await next.ready;
    // Everything except the output is already a native immutable snapshot. take() must not parse inputs.
    const imports = rs.spyOn(wasm.Converter, "convertFromBrep");
    const result = unwrapOk(next.take());
    shapes.push(result.result.shape);
    try {
        expect(imports).toHaveBeenCalledTimes(1);
        expect(result.inputs[0]).not.toBe(first);
        expect(result.inputs[0].volume()).toBeCloseTo(first.volume(), 8);
        expect(result.result.shape.volume()).toBeCloseTo(first.volume(), 8);
    } finally {
        for (const shape of result.inputs) shape.dispose();
    }
    expect(await count()).toBe(1); // consumed predecessor + exactly one new result lease
});

test.each([
    "location",
    "tolerance",
    "orientation",
    "native alias",
] as const)("%s mutation invalidates a cached native version", async (mutation) => {
    const first = await finish();
    if (mutation === "location") first.matrix = Matrix4.fromTranslation(100, 0, 0);
    else if (mutation === "tolerance") first.setTolerance(0.01);
    else if (mutation === "orientation") {
        first.reserve();
        first.reserve();
    } else wasm.Shape.setTolerance(first.shape, 0.02); // bypass JS hooks, as a geometry alias can
    const next = start(first);
    expect(requests().at(-1)?.args.left[0]).toHaveProperty("brep");
    await next.ready;
    const answer = unwrapOk(next.take());
    shapes.push(answer.result.shape);
    try {
        const expectedMin = mutation === "location" ? 100 : 0;
        expect(answer.inputs[0].geometryBoundingBox().min.x).toBeCloseTo(expectedMin, 6);
        // The tolerant kernel path still exposes the native tolerance captured by the snapshot.
        const padding = mutation === "tolerance" ? 0.01 : mutation === "native alias" ? 0.02 : 0;
        const tolerant = wasm.Shape.boundingBox((answer.inputs[0] as OccShape).shape, true);
        expect(tolerant.min.x).toBeCloseTo(expectedMin - padding, 6);
    } finally {
        for (const input of answer.inputs) input.dispose();
    }
});

test("a resident request still owns an immutable main snapshot if its source changes while awaiting", async () => {
    const first = await finish();
    const next = start(first);
    expect(requests().at(-1)?.args.left[0]).toHaveProperty("handle");
    first.matrix = Matrix4.fromTranslation(100, 0, 0);
    await next.ready;
    const answer = unwrapOk(next.take());
    shapes.push(answer.result.shape);
    try {
        expect(answer.inputs[0].geometryBoundingBox().min.x).toBeCloseTo(0, 6);
        expect(answer.result.shape.geometryBoundingBox().max.x).toBeCloseTo(10, 6);
    } finally {
        for (const input of answer.inputs) input.dispose();
    }
});

test("a geometric surface alias invalidates reuse even without a shape setter notification", async () => {
    const first = await finish();
    const faces = wasm.Shape.findSubShapes(first.shape, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
    const face = wasm.TopoDS.face(faces[0]);
    const surface = wasm.Face.surface(face);
    const transform = new wasm.gp_Trsf();
    try {
        const geometry = surface.get();
        expect(geometry).not.toBeNull();
        if (!geometry) throw new Error("Missing surface");
        transform.setValues(1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0);
        geometry.transform(transform);
    } finally {
        transform.delete();
        surface.delete();
        face.delete();
        for (const value of faces) value.delete();
    }
    // Moving just one surface need not leave a valid solid. Verify cache invalidation, then
    // cancel before asking OCCT to boolean that intentionally inconsistent synthetic geometry.
    const task = start(first);
    expect(requests().at(-1)?.args.left[0]).toHaveProperty("brep");
    task.cancel();
    await task.ready;
    expect(await count()).toBe(0);
});

test("an arbitrary raw handle cannot bypass replica correspondence validation", async () => {
    const box = await transport.client.request("box", {
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 10, y: 20, z: 30 },
    });
    expect(box.ok).toBe(true);
    if (!box.ok) throw new Error(box.error.message);
    const reply = await transport.client.request("booleanReplica", {
        operation: "fuse",
        left: [{ handle: box.value }],
        right: [{ handle: box.value }],
        retain: true,
    });
    expect(reply).toEqual({
        ok: false,
        error: { code: "invalid", message: "Unknown or consumed replica lease" },
    });
    expect(await count()).toBe(1); // The rejected request never owned the ordinary raw handle.
    await transport.client.request("release", { handles: [box.value] });
    expect(await count()).toBe(0);
});

test("resident shapes are bounded and explicit source disposal releases them without GC", async () => {
    const outputs: OccShape[] = [];
    for (let i = 0; i < 5; i++) outputs.push(await finish());
    expect(await count()).toBe(2);
    expect(outputs[0].volume()).toBeCloseTo(6000, 6); // eviction does not dispose the main replica
    for (const shape of outputs) shape.dispose();
    expect(await count()).toBe(0);
});

test("queued cancellation releases consumed input leases as well as untaken outputs", async () => {
    const first = await finish();
    const pending = start(first);
    pending.cancel(); // before the host's native task
    await pending.ready;
    expect(pending.take().isOk).toBe(false);
    expect(await count()).toBe(0);
    const another = start(first);
    expect(requests().at(-1)?.args.left[0]).toHaveProperty("brep");
    await another.ready;
    another.cancel(); // native finished and was accepted by transport, but never taken by the caller
    expect(await count()).toBe(0);
});

test("provider disposal releases pending immutable snapshots even if the caller never takes them", async () => {
    const task = start();
    const dispose = rs.spyOn(OccShape.prototype as unknown as { disposeInternal(): void }, "disposeInternal");
    hybrid.dispose();
    await task.ready;
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(task.take().isOk).toBe(false);
    expect(
        transport.kernel.execute({ type: "request", id: 99, operation: "stats", args: undefined }, []),
    ).toEqual({ ok: true, value: { shapes: 0 } });
});

test("resident reuse never skips output topology verification", async () => {
    const first = await finish();
    transport.hold = true;
    const task = start(first);
    await rs.waitFor(() => expect(transport.held.length).toBe(1));
    const reply = transport.held[0];
    if (reply.type !== "result" || !reply.result.ok) throw new Error("No native result");
    const value = reply.result.value as { topology: { faces: string[] } };
    value.topology.faces.reverse();
    transport.deliver();
    await task.ready;
    const result = task.take();
    expect(result.isOk).toBe(false);
    expect(result.error).toBe("Output BREP topology order changed");
    expect(
        transport.kernel.execute({ type: "request", id: 99, operation: "stats", args: undefined }, []),
    ).toEqual({ ok: true, value: { shapes: 0 } });
});

test.each([
    [false, "Native operation failed"],
    [true, "Native operation failed"],
    [false, ""],
    [true, ""],
] as const)("native failure stays latched (cancelled=%s, message=%s)", async (cancelled, message) => {
    transport.hold = true;
    const task = start();
    await rs.waitFor(() => expect(transport.held.length).toBe(1));
    const reply = transport.held[0];
    if (reply.type !== "result") throw new Error("Missing terminal response");
    // Inject the wire failure, not an actual corrupted shared test heap. This also exercises
    // cleanup of an accepted-but-untaken output that the loopback had already produced.
    reply.result = { ok: false, error: { code: "kernel", message } };
    if (cancelled) task.cancel();
    transport.deliver();
    await task.ready;
    const expected = message || "Geometry worker native operation failed";
    expect(hybrid.failure).toBe(expected);
    const failed = task.take();
    expect(failed.isOk).toBe(false);
    expect(failed.error).toBe(expected);
    const submitted = requests().length;
    const next = start();
    await next.ready;
    const repeated = next.take();
    expect(repeated.isOk).toBe(false);
    expect(repeated.error).toBe(expected);
    expect(next.canFallback).toBe(false);
    expect(requests()).toHaveLength(submitted);
    expect(
        transport.kernel.execute({ type: "request", id: 99, operation: "stats", args: undefined }, []),
    ).toEqual({ ok: true, value: { shapes: 0 } });
});
