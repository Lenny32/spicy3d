// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import MainModuleFactory from "../../lib/spicy-wasm";
import { replicaTopology } from "../../src/replicaTopology";
import { KernelWorkerClient } from "../../src/workerClient";
import { createKernelWorker } from "../../src/workerFactory";
import type { KernelResult } from "../../src/workerProtocol";
import { cornerWorkerSmoke } from "./cornerWorkerSmoke";

function ok<T>(result: KernelResult<T>): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
}
function check(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

async function cancelActiveNative() {
    const worker = new Worker(new URL("./cancellationWorker.ts", import.meta.url), { type: "module" });
    let terminations = 0;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
        terminations++;
        terminate();
    };
    const client = new KernelWorkerClient(worker);
    const probe = new MessageChannel();
    worker.postMessage({ type: "probe-port", port: probe.port2 }, [probe.port2]);
    const size = { x: 10, y: 20, z: 30 };
    let returned = false;
    const entered = new Promise<void>((resolve) => {
        probe.port1.onmessage = (event) => {
            if (event.data === "native-entered") resolve();
            else if (event.data === "native-returned") returned = true;
        };
    });
    let fresh: KernelWorkerClient | undefined;
    try {
        ok(await client.request("ready", undefined));
        const handle = ok(await client.request("box", { origin: { x: 0, y: 0, z: 0 }, size }));
        const tools: string[] = [];
        for (let i = 1; i <= 24; i++)
            tools.push(
                ok(await client.request("box", { origin: { x: i * 0.3, y: i * 0.2, z: i * 0.1 }, size })),
            );
        const signal = new AbortController();
        const running = client.request(
            "boolean",
            { operation: "fuse", left: [handle], right: tools },
            signal.signal,
            { terminateOnAbort: true },
        );
        await entered;
        check(!returned, "Native fuse returned before cancellation barrier");
        const abortStart = performance.now();
        signal.abort();
        const cancelled = await running;
        const cancellationMs = performance.now() - abortStart;
        check(
            !cancelled.ok && cancelled.error.code === "cancelled",
            "Native cancellation was reported as failure",
        );
        check(cancellationMs < 250, "Active native cancellation did not settle promptly");
        check(terminations === 1, "Active native worker was not terminated exactly once");
        check(
            client.pendingRequests === 0 && client.pendingNative === 0,
            "Cancelled generation retained requests",
        );
        const closed = await client.request("stats", undefined);
        check(!closed.ok && closed.error.code === "closed", "Cancelled generation accepted another call");
        fresh = createKernelWorker();
        ok(await fresh.request("ready", undefined));
        const stale = await fresh.request("bounds", { handle });
        check(!stale.ok && stale.error.code === "invalid", "Fresh worker accepted an old generation handle");
        const newHandle = ok(await fresh.request("box", { origin: { x: 0, y: 0, z: 0 }, size }));
        const bounds = ok(await fresh.request("bounds", { handle: newHandle }));
        check(Math.abs(bounds.max.z - 30) < 1e-6, "Fresh generation could not create valid geometry");
        ok(await fresh.request("release", { handles: [newHandle] }));
        check(ok(await fresh.request("stats", undefined)).shapes === 0, "Fresh worker leaked handles");
        return {
            cancellationMs,
            nativeEntryObserved: true,
            cancelledGenerationTerminations: terminations,
            oldHandleRejected: true,
        };
    } finally {
        probe.port1.close();
        probe.port2.close();
        client.dispose();
        fresh?.dispose();
    }
}

async function run() {
    const client = createKernelWorker();
    const zero = { x: 0, y: 0, z: 0 };
    const size = { x: 10, y: 20, z: 30 };
    try {
        const start = performance.now();
        ok(await client.request("ready", undefined));
        const initializationMs = performance.now() - start;
        const handle = ok(await client.request("box", { origin: zero, size }));
        const bounds = ok(await client.request("bounds", { handle }));
        check(Math.abs(bounds.max.z - 30) < 1e-6, "Wrong real worker bounds");
        const samples: number[] = [];
        for (let i = 0; i < 25; i++) {
            const before = performance.now();
            ok(await client.request("bounds", { handle }));
            samples.push(performance.now() - before);
        }
        const brep = ok(await client.request("exportBrep", { handle }));
        const main = await MainModuleFactory();
        const baselineResult = main.ShapeFactory.box(
            { location: zero, direction: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 } },
            size.x,
            size.y,
            size.z,
        );
        check(baselineResult.isOk, "Baseline box failed");
        const baseline = baselineResult.shape;
        try {
            check(main.Converter.convertToBrep(baseline) === brep, "Box BREP differs across realms");
            const imported = ok(
                await client.request("importBrep", { brep: main.Converter.convertToBrep(baseline) }),
            );
            check(
                JSON.stringify(ok(await client.request("bounds", { handle: imported }))) ===
                    JSON.stringify(bounds),
                "Imported bounds differ",
            );
            ok(await client.request("release", { handles: [imported] }));
            const bounded = ok(
                await client.request("boundedReplica", {
                    method: "fillet",
                    shape: { brep, topology: replicaTopology(main, baseline) },
                    edges: [0],
                    value: 1,
                }),
            );
            const rounded = main.Converter.convertFromBrep(bounded.brep);
            try {
                check(main.Shape.check(rounded), "Bounded fillet returned invalid geometry");
                check(
                    main.Shape.volume(rounded) < main.Shape.volume(baseline),
                    "Bounded fillet did not remove material",
                );
                check(
                    JSON.stringify(replicaTopology(main, rounded)) === JSON.stringify(bounded.topology),
                    "Bounded replica changed topology order",
                );
            } finally {
                rounded.delete();
            }
        } finally {
            baselineResult.delete();
        }
        const mesh = ok(await client.request("mesh", { handle }));
        check(
            mesh.indices instanceof Uint32Array && mesh.indices.length === 36,
            "Wrong transferred triangles",
        );
        check(
            mesh.positions instanceof Float32Array && mesh.normals.length === mesh.positions.length,
            "Wrong transferred attributes",
        );

        // Native synthetic fuse, not a delay pretending to be a kernel operation. Input stays in worker.
        const tools: string[] = [];
        for (let i = 1; i <= 24; i++) {
            tools.push(
                ok(await client.request("box", { origin: { x: i * 0.3, y: i * 0.2, z: i * 0.1 }, size })),
            );
        }
        let ticks = 0;
        let frames = 0;
        let inputEvents = 0;
        const probe = document.querySelector("#input-probe");
        if (!probe) throw new Error("Missing input probe");
        const onInput = () => {
            inputEvents++;
            probe.textContent = "Input handled during fuse";
        };
        probe.addEventListener("click", onInput);
        let drawing = true;
        const tick = setInterval(() => ticks++, 5);
        const frame = () => {
            if (drawing) {
                frames++;
                requestAnimationFrame(frame);
            }
        };
        requestAnimationFrame(frame);
        const fuseStart = performance.now();
        document.documentElement.setAttribute("data-worker-busy", "true");
        let fused: string;
        try {
            const result = ok(
                await client.request("boolean", { operation: "fuse", left: [handle], right: tools }),
            );
            fused = result.handle;
            check(result.tracking.faceAncestors.length > 0, "Missing transferred tracking");
        } finally {
            clearInterval(tick);
            drawing = false;
            document.documentElement.setAttribute("data-worker-busy", "false");
            probe.removeEventListener("click", onInput);
        }
        const fuseMs = performance.now() - fuseStart;
        check(ticks > 0 && frames > 0, "Main thread did not tick and paint during native fuse");
        check(inputEvents > 0, "Main thread did not handle browser input during native fuse");
        const fusedBounds = ok(await client.request("bounds", { handle: fused }));
        check(Math.abs(fusedBounds.max.x - 17.2) < 1e-6, "Wrong synthetic fuse geometry");

        const abort = new AbortController();
        const stale = client.request(
            "boolean",
            { operation: "fuse", left: [handle], right: tools },
            abort.signal,
        );
        // Deliver cancellation after the worker has had a chance to enter its native call.
        setTimeout(() => abort.abort(), 20);
        const cancelled = await stale;
        check(!cancelled.ok && cancelled.error.code === "cancelled", "Cancellation did not settle promptly");
        ok(await client.request("release", { handles: [handle, ...tools, fused] }));
        check(ok(await client.request("stats", undefined)).shapes === 0, "Cancelled/released shapes leaked");
        const cancellation = await cancelActiveNative();
        const corner = await cornerWorkerSmoke(main, client);
        samples.sort((a, b) => a - b);
        return {
            ...cancellation,
            corner,
            initializationMs,
            boundsRoundTripMedianMs: samples[12],
            boundsRoundTripMaxMs: samples[24],
            fuseMs,
            ticksDuringFuse: ticks,
            framesDuringFuse: frames,
            inputEventsDuringFuse: inputEvents,
            remainingHandles: 0,
        };
    } finally {
        client.dispose();
    }
}

Object.assign(globalThis, { workerSmoke: run });
