// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import MainModuleFactory from "../../lib/spicy-wasm";
import { KernelWorkerHost } from "../../src/workerHost";
import { WorkerKernel } from "../../src/workerKernel";
import type { KernelMessage, KernelResponse } from "../../src/workerProtocol";

// Test-only barrier on a separate port; production RPC remains unchanged.
const scope = globalThis as unknown as {
    onmessage:
        | ((event: MessageEvent<KernelMessage | { type: "probe-port"; port: MessagePort }>) => void)
        | null;
    postMessage(response: KernelResponse, transfers: ArrayBuffer[]): void;
};
let host: KernelWorkerHost | undefined;
let probe: MessagePort | undefined;
const pending: KernelMessage[] = [];
scope.onmessage = (event) => {
    if (event.origin !== "" || !event.isTrusted) return;
    if (event.data.type === "probe-port") {
        probe = event.data.port;
        return;
    }
    if (host) host.receive(event.data);
    else pending.push(event.data);
};
MainModuleFactory()
    .then((module) => {
        const fuse = module.ShapeFactory.booleanFuseTracked;
        module.ShapeFactory.booleanFuseTracked = (...args) => {
            probe?.postMessage("native-entered");
            const result = fuse(...args);
            probe?.postMessage("native-returned");
            return result;
        };
        const corner = module.ShapeFactory.filletCornerSetbackTracked;
        module.ShapeFactory.filletCornerSetbackTracked = (...args) => {
            probe?.postMessage("corner-native-entered");
            const result = corner(...args);
            probe?.postMessage("corner-native-returned");
            return result;
        };
        host = new KernelWorkerHost(new WorkerKernel(module), (response, transfers) =>
            scope.postMessage(response, transfers),
        );
        scope.postMessage({ type: "initialized" }, []);
        for (const message of pending) host.receive(message);
        pending.length = 0;
    })
    .catch(() =>
        scope.postMessage(
            { type: "fatal", code: "unavailable", message: "Test worker initialization failed" },
            [],
        ),
    );
