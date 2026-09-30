// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IKernelWorkerTransport, KernelWorkerClient } from "../src/workerClient";
import { KernelWorkerHost } from "../src/workerHost";
import { WorkerKernel } from "../src/workerKernel";
import type { KernelMessage, KernelResponse } from "../src/workerProtocol";

/** Native loopback for integration tests. Browser smoke covers independent Worker/WASM realms. */
export class NativeWorkerTransport extends EventTarget implements IKernelWorkerTransport {
    readonly requests: KernelMessage[] = [];
    readonly kernel = new WorkerKernel(wasm);
    readonly host = new KernelWorkerHost(this.kernel, (data, transfer) => {
        const reply = structuredClone(data, { transfer });
        if (this.hold) this.held.push(reply);
        else this.dispatchEvent(new MessageEvent("message", { data: reply }));
    });
    hold = false;
    readonly held: KernelResponse[] = [];
    readonly client = new KernelWorkerClient(this);
    private initialized = false;
    postMessage(message: KernelMessage): void {
        if (!this.initialized) {
            this.initialized = true;
            this.dispatchEvent(new MessageEvent("message", { data: { type: "initialized" } }));
        }
        this.requests.push(message);
        this.host.receive(structuredClone(message));
    }
    deliver(): void {
        this.hold = false;
        for (const data of this.held.splice(0)) this.dispatchEvent(new MessageEvent("message", { data }));
    }
    terminate(): void {
        this.host.dispose();
    }
}
