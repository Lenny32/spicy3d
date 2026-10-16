// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Puts the WebAssembly kernel pinned by `packages/wasm/wasm.lock.json` into `packages/wasm/lib/`
 * (#191, see scripts/wasm-artifact.mjs). Runs on `npm install`/`npm ci` and before `dev`, `build`
 * and `test`; nothing to do (no network) when the files are already the pinned ones.
 *
 *   npm run fetch:wasm               # or node scripts/fetch-wasm.mjs
 *   npm run fetch:wasm -- --force    # replace a local `npm run build:wasm` output too
 *
 * - Every file is checked against its sha256 in the lock; a mismatch or a failed download stops with
 *   an error, never a build without the kernel or with another one.
 * - A local build (`npm run build:wasm` installs into packages/wasm/lib/) is kept: files there that
 *   this script did not write (`lib/.fetched.json` records what it wrote) are left alone, with a note
 *   when they are not the pinned ones.
 * - Sources, first that has the file with the right hash: `SPICY3D_WASM_DIR` (a folder holding
 *   `spicy-wasm.wasm`/`.js`, for machines without internet access), the download cache
 *   (`SPICY3D_WASM_CACHE`, default ~/.cache/spicy3d-wasm, files by sha256, shared by every checkout),
 *   then the release (`SPICY3D_WASM_BASE_URL` instead of the lock's URL, e.g. a mirror).
 * - `SPICY3D_SKIP_WASM_FETCH=1` skips it (jobs that only need the committed .d.ts).
 *
 * `--lib <folder>` / `--lock <file>` stand in for the defaults (tests).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FETCHED_FILES, LIB_DIR, LOCK_FILE, readLock, sha256 } from "./wasm-artifact.mjs";

const MARKER = ".fetched.json";
const ATTEMPTS = 3;

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const force = args.includes("--force");
const libDir = path.resolve(option("--lib") ?? LIB_DIR);
const lockFile = path.resolve(option("--lock") ?? LOCK_FILE);
const env = process.env;

function cacheDir() {
    if (env.SPICY3D_WASM_CACHE) return env.SPICY3D_WASM_CACHE;
    const base = env.XDG_CACHE_HOME || env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
    return path.join(base, "spicy3d-wasm");
}

const read = (file) => (existsSync(file) ? readFileSync(file) : undefined);
const shaOf = (file) => {
    const data = read(file);
    return data && sha256(data);
};

function readMarker() {
    try {
        return JSON.parse(readFileSync(path.join(libDir, MARKER), "utf8")).files ?? {};
    } catch {
        return {};
    }
}

function writeAtomic(file, data) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, file);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url) {
    for (let attempt = 1; ; attempt++) {
        let response;
        try {
            response = await fetch(url, { redirect: "follow" });
        } catch (error) {
            if (attempt >= ATTEMPTS) throw new Error(`${url}: ${error.cause?.code ?? error.message}`);
            await sleep(1000 * attempt);
            continue;
        }
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        if (response.status < 500 || attempt >= ATTEMPTS) {
            throw new Error(`${url}: HTTP ${response.status}`, { cause: response.status });
        }
        await sleep(1000 * attempt);
    }
}

/** The pinned bytes of `name`, from the first source that has them. */
async function obtain(name, expected, baseUrl, tag) {
    const candidates = [];
    if (env.SPICY3D_WASM_DIR) candidates.push(["SPICY3D_WASM_DIR", path.join(env.SPICY3D_WASM_DIR, name)]);
    candidates.push(["cache", path.join(cacheDir(), expected)]);
    for (const [source, file] of candidates) {
        const data = read(file);
        if (!data) continue;
        if (sha256(data) === expected) return { data, source };
        if (source === "SPICY3D_WASM_DIR") {
            throw new Error(
                `${file} is not the ${name} of ${tag} (sha256 ${sha256(data)}, expected ${expected})`,
            );
        }
    }
    const url = `${baseUrl.replace(/\/$/, "")}/${name}`;
    let data;
    try {
        data = await download(url);
    } catch (error) {
        const hint =
            error.cause === 404
                ? `release ${tag} has no ${name}. If this branch changed cpp/, the WASM workflow publishes ` +
                  "it (wasm.yml); otherwise build it (npm run build:wasm)."
                : "no network? Point SPICY3D_WASM_DIR at a folder holding the files, or build them (npm run build:wasm).";
        throw new Error(`${error.message}\n  ${hint}`);
    }
    const actual = sha256(data);
    if (actual !== expected) {
        throw new Error(`${url} is not the pinned ${name} (sha256 ${actual}, expected ${expected})`);
    }
    try {
        writeAtomic(path.join(cacheDir(), expected), data);
    } catch {
        // A read-only or full cache only costs the next checkout a download.
    }
    return { data, source: url };
}

async function main() {
    if (env.SPICY3D_SKIP_WASM_FETCH === "1") {
        console.log("fetch-wasm: skipped (SPICY3D_SKIP_WASM_FETCH=1)");
        return;
    }
    const lock = readLock(lockFile);
    const expected = Object.fromEntries(FETCHED_FILES.map((name) => [name, lock.files[name]?.sha256]));
    for (const [name, sha] of Object.entries(expected)) {
        if (!sha) throw new Error(`${lockFile}: no sha256 for ${name}`);
    }
    const current = Object.fromEntries(FETCHED_FILES.map((name) => [name, shaOf(path.join(libDir, name))]));

    if (FETCHED_FILES.every((name) => current[name] === expected[name])) {
        console.log(`fetch-wasm: kernel ${lock.tag} is in place`);
        return;
    }
    const marker = readMarker();
    const localBuild = FETCHED_FILES.every((name) => current[name] && current[name] !== marker[name]);
    if (localBuild && !force) {
        console.warn(
            `fetch-wasm: keeping the local build in ${path.relative(process.cwd(), libDir) || "."} ` +
                `(not the pinned ${lock.tag}); npm run fetch:wasm -- --force replaces it`,
        );
        return;
    }

    const baseUrl = env.SPICY3D_WASM_BASE_URL || lock.url;
    const obtained = [];
    for (const name of FETCHED_FILES) {
        if (current[name] === expected[name]) continue;
        obtained.push([name, await obtain(name, expected[name], baseUrl, lock.tag)]);
    }
    // Written only once every file is there: never a .wasm of one release with the .js of another.
    for (const [name, { data, source }] of obtained) {
        writeAtomic(path.join(libDir, name), data);
        console.log(
            `fetch-wasm: ${name} of ${lock.tag} (${(data.length / 1048576).toFixed(1)} MiB) from ${source}`,
        );
    }
    writeAtomic(
        path.join(libDir, MARKER),
        `${JSON.stringify({ tag: lock.tag, files: expected }, null, 4)}\n`,
    );
}

main().catch((error) => {
    for (const name of FETCHED_FILES)
        rmSync(path.join(libDir, `${name}.${process.pid}.tmp`), { force: true });
    console.error(`fetch-wasm: ${error.message}`);
    process.exitCode = 1;
});
