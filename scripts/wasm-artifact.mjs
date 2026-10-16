// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The WebAssembly kernel as a release artifact (#191). `packages/wasm/lib/spicy-wasm.{wasm,js}` are
 * not committed: `packages/wasm/wasm.lock.json` pins the GitHub release holding them (tag
 * `wasm-<inputs>`), their sha256, and the hash of everything they are built from (`cpp/` and the
 * toolchain pins in `scripts/setup_wasm_deps.mjs`). `spicy-wasm.d.ts` stays committed (typecheck
 * without a download) and is pinned too. `scripts/fetch-wasm.mjs` downloads the files; the WASM
 * workflow (.github/workflows/wasm.yml) builds and publishes a new release only when the inputs
 * changed.
 *
 *   node scripts/wasm-artifact.mjs inputs           # prints the inputs hash
 *   node scripts/wasm-artifact.mjs check            # the lock matches the inputs and the committed .d.ts
 *   node scripts/wasm-artifact.mjs lock --dir <d>   # writes the lock for the files in <d> (CI), copies the .d.ts
 *   node scripts/wasm-artifact.mjs tag              # prints the release tag the inputs need
 *   node scripts/wasm-artifact.mjs verify --dir <d> # the files in <d> are the ones the lock pins
 *
 * `--root <folder>` reads another checkout (tests).
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_FILE = path.join(ROOT_DIR, "packages/wasm/wasm.lock.json");
export const LIB_DIR = path.join(ROOT_DIR, "packages/wasm/lib");
export const REPOSITORY = "Lenny32/spicy3d";
/** Downloaded from the release. */
export const FETCHED_FILES = ["spicy-wasm.wasm", "spicy-wasm.js"];
/** Committed next to them, pinned so a release never pairs with another build's types. */
export const COMMITTED_FILES = ["spicy-wasm.d.ts"];

/** Not build inputs: the local toolchain, OCCT checkout and build output, editor files. */
const IGNORED = new Set(["build", "CMakeUserPresets.json", ".DS_Store"]);
const EXTRA_INPUTS = ["scripts/setup_wasm_deps.mjs"];

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const tagOf = (inputs) => `wasm-${inputs.slice(0, 16)}`;

export const releaseUrl = (tag, repository = REPOSITORY) =>
    `https://github.com/${repository}/releases/download/${tag}`;

function* walk(dir, root) {
    for (const entry of readdirSync(dir).sort()) {
        if (IGNORED.has(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full, root);
        else yield path.relative(root, full).split(path.sep).join("/");
    }
}

/**
 * The hash of what the binary is built from: every file of `cpp/` (but its build folder) and the
 * toolchain pins, path and content, CRLF read as LF so a Windows checkout hashes the same. Needs no
 * git: the Docker build context has no `.git`.
 */
export function inputsHash(root = ROOT_DIR) {
    const files = [...walk(path.join(root, "cpp"), root), ...EXTRA_INPUTS].sort();
    const lines = files.map((file) => {
        const content = readFileSync(path.join(root, file)).toString("latin1").replaceAll("\r\n", "\n");
        return `${file}:${sha256(Buffer.from(content, "latin1"))}`;
    });
    return sha256(lines.join("\n"));
}

export function readLock(file = LOCK_FILE) {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    if (lock.schema !== 1 || typeof lock.tag !== "string" || typeof lock.files !== "object") {
        throw new Error(`${path.relative(ROOT_DIR, file)}: not a wasm lock file (schema 1)`);
    }
    return lock;
}

export const fileSha = (file) => (existsSync(file) ? sha256(readFileSync(file)) : undefined);

/** The lock for the built files in `dir`. */
export function makeLock(dir, inputs, repository = REPOSITORY) {
    const files = {};
    for (const name of [...FETCHED_FILES, ...COMMITTED_FILES]) {
        const data = readFileSync(path.join(dir, name));
        files[name] = { sha256: sha256(data), size: data.length };
    }
    return { schema: 1, inputs, tag: tagOf(inputs), url: releaseUrl(tagOf(inputs), repository), files };
}

export const writeLock = (lock, file = LOCK_FILE) =>
    writeFileSync(file, `${JSON.stringify(lock, null, 4)}\n`);

/** What is wrong with the lock for these sources, empty when nothing. */
export function lockProblems(lock, { root = ROOT_DIR, lib = LIB_DIR } = {}) {
    const problems = [];
    const inputs = inputsHash(root);
    if (lock.inputs !== inputs) {
        problems.push(
            `the kernel's sources changed (inputs ${inputs.slice(0, 16)}, lock ${lock.inputs.slice(0, 16)})`,
        );
    }
    if (lock.tag !== tagOf(lock.inputs)) problems.push(`tag ${lock.tag} is not ${tagOf(lock.inputs)}`);
    for (const name of COMMITTED_FILES) {
        if (fileSha(path.join(lib, name)) !== lock.files[name]?.sha256) {
            problems.push(`packages/wasm/lib/${name} is not the one of release ${lock.tag}`);
        }
    }
    return problems;
}

function main([command, ...args]) {
    const option = (name) => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const root = path.resolve(option("--root") ?? ROOT_DIR);
    const lockFile = path.join(root, path.relative(ROOT_DIR, LOCK_FILE));
    const lib = path.join(root, path.relative(ROOT_DIR, LIB_DIR));
    switch (command) {
        case "inputs":
            console.log(inputsHash(root));
            return 0;
        case "tag":
            console.log(tagOf(inputsHash(root)));
            return 0;
        case "check": {
            const lock = readLock(lockFile);
            const problems = lockProblems(lock, { root, lib });
            if (problems.length === 0) {
                console.log(`wasm.lock.json is up to date (${lock.tag})`);
                return 0;
            }
            console.error(`packages/wasm/wasm.lock.json is stale:\n  ${problems.join("\n  ")}`);
            console.error(
                "The WASM workflow builds and publishes the kernel and commits the lock (wasm.yml).",
            );
            return 1;
        }
        case "verify": {
            const dir = option("--dir");
            if (!dir) throw new Error("verify: --dir <folder> is required");
            const lock = readLock(lockFile);
            const wrong = Object.entries(lock.files)
                .filter(([name, { sha256: expected }]) => fileSha(path.join(dir, name)) !== expected)
                .map(([name]) => name);
            if (wrong.length === 0) {
                console.log(`${dir} holds the files of ${lock.tag}`);
                return 0;
            }
            console.error(`${dir}: not the files of ${lock.tag}: ${wrong.join(", ")}`);
            return 1;
        }
        case "lock": {
            const dir = option("--dir");
            if (!dir) throw new Error("lock: --dir <folder with the built files> is required");
            const lock = makeLock(dir, inputsHash(root), option("--repository") ?? REPOSITORY);
            for (const name of COMMITTED_FILES) {
                const target = path.join(lib, name);
                if (path.resolve(dir, name) !== target) copyFileSync(path.join(dir, name), target);
            }
            writeLock(lock, lockFile);
            console.log(`wrote packages/wasm/wasm.lock.json for ${lock.tag}`);
            return 0;
        }
        default:
            console.error(
                "usage: node scripts/wasm-artifact.mjs inputs|tag|check|verify --dir <folder>|lock --dir <folder> [--root <repo>]",
            );
            return 2;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
