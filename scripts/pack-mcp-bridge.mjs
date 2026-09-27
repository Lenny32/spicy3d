// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Pack packages/mcp-bridge into public/mcp/, so every Spicy3D deployment serves the bridge that
 * matches it and users can start it with `npx --package=<site>/mcp/<file>.tgz` — no npm
 * publication and no checkout needed. The file name carries the app version because npx caches
 * by URL: a new release must be a new URL.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeDir = path.join(rootDir, "packages/mcp-bridge");
const outDir = path.join(rootDir, "public/mcp");
const { version } = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const target = `spicy3d-mcp-bridge-${version}.tgz`;

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) rmSync(path.join(outDir, file));

// npm <= 11 emits an array of pack results; npm >= 12 keys them by package name.
const packed = JSON.parse(
    execSync(`npm pack --json --pack-destination "${outDir}"`, { cwd: bridgeDir, encoding: "utf8" }),
);
const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
renameSync(path.join(outDir, path.basename(filename)), path.join(outDir, target));
console.log(`packed MCP bridge -> public/mcp/${target}`);
