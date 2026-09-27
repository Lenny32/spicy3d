// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Build standalone spicy3d-mcp-bridge executables (no Node.js needed on the user's machine) for
 * every release platform into dist-bridge/, as Node.js single executable applications:
 *
 *   1. esbuild bundles the bridge and `ws` into one CommonJS file (what SEA runs);
 *   2. node --experimental-sea-config turns it into a preparation blob;
 *   3. postject injects the blob into each platform's official Node.js binary, downloaded from
 *      nodejs.org for exactly this Node version and checked against its SHASUMS256.txt.
 *
 * The blob carries no code cache or snapshot, so one blob fits every platform and one machine can
 * build any target. macOS targets are the exception worth respecting: Node's signature has to be
 * removed before the injection and an ad-hoc one applied after (Apple silicon runs nothing
 * unsigned), which needs `codesign` — so build them on macOS, where this script does both.
 *
 *   node scripts/build-mcp-bridge-binaries.mjs            # all targets
 *   node scripts/build-mcp-bridge-binaries.mjs linux-x64  # some targets
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const TARGETS = {
    "windows-x64": { dist: "win-x64", archive: "node.exe", ext: ".exe" },
    "linux-x64": { dist: "linux-x64", archive: "tar.gz", ext: "" },
    "linux-arm64": { dist: "linux-arm64", archive: "tar.gz", ext: "" },
    "macos-x64": { dist: "darwin-x64", archive: "tar.gz", ext: "" },
    "macos-arm64": { dist: "darwin-arm64", archive: "tar.gz", ext: "" },
};

// The fuse string Node looks for to know a SEA blob was injected (from the Node.js SEA docs).
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist-bridge");
const workDir = path.join(outDir, ".build");

const requested = process.argv.slice(2);
const unknown = requested.filter((t) => !(t in TARGETS));
if (unknown.length > 0) {
    console.error(`unknown target(s): ${unknown.join(", ")}; known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(2);
}
const targets = requested.length > 0 ? requested : Object.keys(TARGETS);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// 1. One CommonJS file. bufferutil / utf-8-validate are optional `ws` speed-ups it loads inside a
//    try/catch; leaving them out keeps ws on its pure-JS path.
await build({
    entryPoints: [path.join(rootDir, "packages/mcp-bridge/src/cli.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: `node${process.versions.node.split(".")[0]}`,
    external: ["bufferutil", "utf-8-validate"],
    // cli.mjs starts with a shebang; SEA runs the file as a script, where it is harmless, but
    // esbuild keeps it only on the first line, which is what we want.
    outfile: path.join(workDir, "bridge.cjs"),
    logLevel: "warning",
});

// 2. The preparation blob.
const blob = path.join(workDir, "bridge.blob");
writeFileSync(
    path.join(workDir, "sea-config.json"),
    JSON.stringify({
        main: path.join(workDir, "bridge.cjs"),
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
    }),
);
execFileSync(process.execPath, ["--experimental-sea-config", path.join(workDir, "sea-config.json")], {
    stdio: "inherit",
});
const blobData = readFileSync(blob);

// 3. Inject into each platform's Node binary.
const shasums = await fetchText(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`);
const sums = [];
for (const name of targets) {
    const target = TARGETS[name];
    const file = `spicy3d-mcp-bridge-${name}${target.ext}`;
    const output = path.join(outDir, file);
    const macos = name.startsWith("macos");
    writeFileSync(output, await nodeBinary(target));
    chmodSync(output, 0o755);
    if (macos && process.platform === "darwin") execFileSync("codesign", ["--remove-signature", output]);
    await inject(output, "NODE_SEA_BLOB", blobData, {
        sentinelFuse: SEA_FUSE,
        ...(macos && { machoSegmentName: "NODE_SEA" }),
    });
    if (macos) {
        if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", output]);
        else console.warn(`warning: ${file} is unsigned; build macOS targets on macOS so they run`);
    }
    sums.push(`${sha256(readFileSync(output))}  ${file}`);
    console.log(`built ${file}`);
}

rmSync(workDir, { recursive: true, force: true });
writeFileSync(path.join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`built ${targets.length} bridge executable(s) into dist-bridge/ (Node ${process.version})`);

/**
 * The official `node` binary for a target, as bytes: downloaded, checked against nodejs.org's
 * SHASUMS256.txt, and extracted in memory, so nothing unverified ever touches the disk.
 */
async function nodeBinary(target) {
    const archiveName =
        target.archive === "node.exe"
            ? `${target.dist}/node.exe`
            : `node-${process.version}-${target.dist}.${target.archive}`;
    const expected = shasums
        .split("\n")
        .find((l) => l.endsWith(`  ${archiveName}`))
        ?.split(" ")[0];
    if (!expected) throw new Error(`${archiveName} is not listed in SHASUMS256.txt`);

    const response = await fetchOk(`https://nodejs.org/dist/${process.version}/${archiveName}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== expected) {
        throw new Error(`checksum mismatch for ${archiveName}: refusing to build with it`);
    }
    if (target.archive === "node.exe") return archive;

    // tar ships with Linux, macOS and Windows 10+; the archive's top folder is node-<v>-<dist>.
    // It reads the archive from stdin and writes the one member to stdout.
    const member = `node-${process.version}-${target.dist}/bin/node`;
    return execFileSync("tar", ["-xzOf", "-", member], { input: archive, maxBuffer: 512 * 1024 * 1024 });
}

async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return response;
}

async function fetchText(url) {
    return (await fetchOk(url)).text();
}

function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
