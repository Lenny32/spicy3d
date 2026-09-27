// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Regenerates merge artifacts from their sources of truth by running the test that checks them in
// its update mode:
//   node scripts/update-merge-rules.mjs            docs/merge.md's rule list, from the rule registry
//   node scripts/update-merge-rules.mjs fixtures   packages/core/test/fixtures/merge, from fixtureCases.ts

import { spawnSync } from "node:child_process";

const targets = {
    rules: ["packages/builder/test/mergeRules.test.ts", "SPICY3D_UPDATE_MERGE_RULES"],
    fixtures: ["packages/core/test/merge/mergeFixtures.test.ts", "SPICY3D_UPDATE_MERGE_FIXTURES"],
};
const target = targets[process.argv[2] ?? "rules"];
if (target === undefined) {
    console.error(`Unknown target ${process.argv[2]}: use ${Object.keys(targets).join(" or ")}`);
    process.exit(2);
}
const [test, variable] = target;
const result = spawnSync("npx", ["rstest", test], {
    stdio: "inherit",
    env: { ...process.env, [variable]: "1" },
    shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
