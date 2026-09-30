// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import MainModuleFactory from "../lib/spicy-wasm";
import { KernelWorkerHost } from "./workerHost";
import { WorkerKernel } from "./workerKernel";
import type { KernelMessage, KernelResponse } from "./workerProtocol";

// Do not import the application barrel: this realm has no document, localStorage, or UI singleton.
const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<KernelMessage>) => void) | null;
    postMessage(response: KernelResponse, transfers: ArrayBuffer[]): void;
    close(): void;
};
let host: KernelWorkerHost | undefined;
const pending: KernelMessage[] = [];
scope.onmessage = (event) => {
    if (host) host.receive(event.data);
    else pending.push(event.data);
};
function fatal(): void {
    scope.postMessage(
        {
            type: "fatal",
            code: host ? "kernel" : "unavailable",
            message: "Geometry worker initialization or runtime failed",
        },
        [],
    );
    scope.close();
}

// The checked-in web-only glue uses fetch/import.meta.url and is also exercised in a real Worker.
// No supplied URLs, imported plugin code, DOM shim, or shared-memory blocking rendezvous.
MainModuleFactory({ onAbort: fatal })
    .then((module) => {
        host = new KernelWorkerHost(new WorkerKernel(module), (response, transfers) =>
            scope.postMessage(response, transfers),
        );
        // Announce initialization before any queued request can enter the native kernel.
        scope.postMessage({ type: "initialized" }, []);
        for (const message of pending) host.receive(message);
        pending.length = 0;
    })
    .catch(fatal);
