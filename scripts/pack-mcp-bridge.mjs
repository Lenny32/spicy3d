// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Pack packages/mcp-bridge into public/downloads/mcp-bridge/, so every Spicy3D deployment serves
 * the bridge that matches it and users can start it with
 * `npx --package=<site>/downloads/mcp-bridge/<file>.tgz` — no npm publication and no checkout
 * needed. The file name carries the app version because npx caches by URL: a new release must be a
 * new URL. (Not under `mcp/`: behind SpicySrv's proxy, `/mcp` and `/mcp/*` are the server's.)
 *
 * The package is the bridge bundled into one file with its dependencies (esbuild) and declares no
 * dependencies itself, so npx never asks the npm registry for anything: it also works on a LAN
 * without internet access.
 */

import { execSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bridgeNotices } from "./mcp-bridge-notices.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeDir = path.join(rootDir, "packages/mcp-bridge");
const outDir = path.join(rootDir, "public/downloads/mcp-bridge");
const { version } = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const bridge = JSON.parse(readFileSync(path.join(bridgeDir, "package.json"), "utf8"));
const target = `spicy3d-mcp-bridge-${version}.tgz`;

mkdirSync(outDir, { recursive: true });
// Only earlier tarballs: an operator may keep the release executables in the same folder.
for (const file of readdirSync(outDir)) {
    if (/^spicy3d-mcp-bridge-.*\.tgz$/.test(file)) rmSync(path.join(outDir, file));
}

const stage = mkdtempSync(path.join(tmpdir(), "spicy3d-mcp-bridge-"));
try {
    // One CommonJS file, like the standalone executables (scripts/build-mcp-bridge-binaries.mjs).
    // bufferutil / utf-8-validate are optional `ws` speed-ups loaded inside a try/catch.
    const { metafile } = await build({
        entryPoints: [path.join(bridgeDir, "src/cli.mjs")],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["bufferutil", "utf-8-validate"],
        outfile: path.join(stage, "cli.cjs"),
        metafile: true,
        logLevel: "warning",
    });
    // The bundle carries third-party code: its licenses go with it, next to the bridge's own.
    const { license, notices } = bridgeNotices(metafile);
    writeFileSync(path.join(stage, "LICENSE"), license);
    writeFileSync(path.join(stage, "THIRD-PARTY-NOTICES.txt"), notices);
    const manifest = {
        name: bridge.name,
        version: bridge.version,
        description: bridge.description,
        keywords: bridge.keywords,
        license: bridge.license,
        repository: bridge.repository,
        bin: { "spicy3d-mcp-bridge": "cli.cjs" },
        files: ["cli.cjs", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.txt"],
        engines: bridge.engines,
    };
    writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(path.join(bridgeDir, "README.md"), path.join(stage, "README.md"));

    // npm <= 11 emits an array of pack results; npm >= 12 keys them by package name.
    const packed = JSON.parse(
        execSync(`npm pack --json --pack-destination "${stage}"`, { cwd: stage, encoding: "utf8" }),
    );
    const { filename } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    copyFileSync(path.join(stage, path.basename(filename)), path.join(outDir, target));
} finally {
    rmSync(stage, { recursive: true, force: true });
}
console.log(`packed MCP bridge -> public/downloads/mcp-bridge/${target}`);
