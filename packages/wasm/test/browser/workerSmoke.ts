// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import MainModuleFactory from "../../lib/spicy-wasm";
import { createKernelWorker } from "../../src/workerFactory";
import type { KernelResult } from "../../src/workerProtocol";

function ok<T>(result: KernelResult<T>): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
}
function check(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
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
        samples.sort((a, b) => a - b);
        return {
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
