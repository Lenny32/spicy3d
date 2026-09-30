// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IKernelRecoveryContext } from "@spicy3d/core";
import MainModuleFactory, { type MainModule } from "../lib/spicy-wasm";
import {
    guardKernelModule,
    onKernelModuleAbort,
    retireKernelModule,
    runKernelPreparation,
} from "./kernelGuard";

declare global {
    var wasm: MainModule;
}

export interface InitWasmOptions {
    /**
     * Raw bytes of `spicy-wasm.wasm`. Required when running under Node (e.g. the
     * MCP server or integration tests), where the Emscripten glue cannot `fetch`
     * the binary. Omit in the browser — Emscripten loads the `.wasm` itself.
     */
    wasmBinary?: BufferSource;
}

/**
 * Creates the kernel module with its crash detection (`kernelGuard.ts`): an abort or trap the module
 * does not survive marks core's `KernelState` crashed, and no call re-enters it afterwards.
 */
export async function initWasm(options?: InitWasmOptions) {
    const module = await createWasmModule(options);
    global.wasm = module;
    return module;
}

/** Creates an independent instance without installing it as the page's public kernel. */
export async function createWasmModule(options?: InitWasmOptions): Promise<MainModule> {
    let instance: MainModule | undefined;
    const module = await MainModuleFactory({
        onAbort: (what: unknown) => {
            if (instance) onKernelModuleAbort(instance, what);
        },
        ...(options?.wasmBinary && { wasmBinary: options.wasmBinary }),
    });
    probeKernel(module);
    instance = guardKernelModule(module, { probe: () => probeKernel(module) });
    return instance;
}

/** Private synchronous module selection for candidate graphs. Disposal permanently retires it. */
export async function createWasmRecoveryContext(options?: InitWasmOptions): Promise<IKernelRecoveryContext> {
    const module = await createWasmModule(options);
    let disposed = false;
    return {
        run<T>(action: () => T): T {
            if (disposed) throw new Error("Recovery context has been disposed");
            const previous = global.wasm;
            try {
                global.wasm = module;
                return runKernelPreparation(module, action);
            } finally {
                global.wasm = previous;
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            retireKernelModule(module);
        },
    };
}

/** A unit box, built and freed: throws when the module no longer works after an abort. */
function probeKernel(module: MainModule): void {
    const result = module.ShapeFactory.box(
        { location: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 } },
        1,
        1,
        1,
    );
    try {
        if (!result.isOk) throw new Error(`kernel probe failed: ${result.error}`);
    } finally {
        result.delete();
    }
}
