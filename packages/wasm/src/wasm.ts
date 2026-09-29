// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import MainModuleFactory, { type MainModule } from "../lib/spicy-wasm";
import { guardKernelModule, onKernelAbort } from "./kernelGuard";

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
 * Creates the kernel module with its crash detection (`kernelGuard.ts`): an abort the module does
 * not survive, or a trap, marks core's `KernelState` crashed, and no call re-enters it afterwards.
 */
export async function initWasm(options?: InitWasmOptions) {
    const module = await MainModuleFactory({
        onAbort: onKernelAbort,
        ...(options?.wasmBinary && { wasmBinary: options.wasmBinary }),
    });
    global.wasm = guardKernelModule(module, { probe: () => probeKernel(module) });
    return global.wasm;
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
