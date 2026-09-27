// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initPlaneGcs } from "../../src/sketch/planegcs";
import { sequentialSketchIds, setDefaultSketchIds } from "../../src/sketch/sketchIds";

// Load the PlaneGCS constraint-solver WASM from bytes for node tests.
const require = createRequire(import.meta.url);
await initPlaneGcs(readFileSync(require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm")));

// These suites were written against counted sketch ids (the first line is entity 1). Production draws
// them at random (`sketchIds.ts`); the id scheme itself is covered by `sketchIds.test.ts`, which
// passes its allocators explicitly.
setDefaultSketchIds(sequentialSketchIds);
