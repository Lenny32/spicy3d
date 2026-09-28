// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelWorkerClient } from "./workerClient";

/** Bundler-owned same-origin URL. No caller-controlled executable or WASM URL. */
export function createKernelWorker(): KernelWorkerClient {
    return new KernelWorkerClient(
        new Worker(new URL("./worker.ts", import.meta.url), {
            type: "module",
            name: "spicy3d-geometry",
        }),
    );
}
