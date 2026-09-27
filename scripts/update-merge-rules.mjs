// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Rewrites the generated class/payload section of docs/merge.md from the merge rule registry: runs
// the coverage test, which writes the file instead of comparing it when SPICY3D_UPDATE_MERGE_RULES
// is set.

import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["rstest", "packages/builder/test/mergeRules.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, SPICY3D_UPDATE_MERGE_RULES: "1" },
    shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
