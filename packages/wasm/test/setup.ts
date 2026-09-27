// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { initWasm } from "../src";

// Under Node there is no fetch for the .wasm; read it from disk and hand the
// bytes to Emscripten via Module.wasmBinary.
const WASM_BINARY = readFileSync(path.resolve(import.meta.dirname, "..", "lib", "spicy-wasm.wasm"));

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
});
