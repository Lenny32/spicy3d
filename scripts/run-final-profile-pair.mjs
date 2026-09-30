// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** One build, two fresh Firefox regression contexts; retain failures/evidence in a new temp directory. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [model, parent] = process.argv.slice(2);
assert.ok(model && parent && existsSync(parent), "provide model and verified existing temporary parent");
const directory = mkdtempSync(path.join(parent, "spicy3d-final-pair-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (folder, filter = () => true) =>
    hash(
        readdirSync(folder, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) =>
                path.relative(folder, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
            )
            .filter(filter)
            .sort()
            .map((file) => `${file}:${hash(readFileSync(path.join(folder, file)))}`)
            .join("\n"),
    );
const source = () =>
    fingerprint("packages", (file) => file.includes("/src/") || /\/package.json$/.test(file));
const buildInputs = () =>
    hash(
        [
            "package.json",
            "package-lock.json",
            "rspack.config.ts",
            "tsconfig.json",
            "packages/wasm/lib/spicy-wasm.js",
            "packages/wasm/lib/spicy-wasm.wasm",
        ]
            .map((file) => `${file}:${hash(readFileSync(file))}`)
            .join("\n"),
    );
const metadata = {
    directory,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    modelSha256Before: hash(readFileSync(model)),
    sourceBeforeBuild: source(),
    buildInputsBefore: buildInputs(),
    modes: {},
};
console.log(`Final pair evidence directory: ${directory}`);
try {
    if (process.platform === "win32")
        execFileSync("cmd.exe", ["/d", "/s", "/c", "npm run build"], { stdio: "inherit", timeout: 240_000 });
    else execFileSync("npm", ["run", "build"], { stdio: "inherit", timeout: 240_000 });
    metadata.sourceAfterBuild = source();
    metadata.distSha256 = fingerprint("dist");
    assert.equal(metadata.sourceAfterBuild, metadata.sourceBeforeBuild, "source changed during build");
    assert.equal(buildInputs(), metadata.buildInputsBefore, "build inputs changed");
    for (const mode of ["main", "hybrid"]) {
        const output = path.join(directory, `${mode}.json`);
        execFileSync(process.execPath, ["--test", "scripts/profile-saved-model.node-test.mjs"], {
            stdio: "inherit",
            timeout: 600_000,
            env: {
                ...process.env,
                SPICY3D_BENCHMARK_MODEL: model,
                SPICY3D_BENCHMARK_MODE: mode,
                SPICY3D_BENCHMARK_OUTPUT: output,
            },
        });
        const evidence = JSON.parse(readFileSync(output));
        assert.equal(evidence.distSha256, metadata.distSha256);
        assert.equal(evidence.sourceFilesSha256, metadata.sourceBeforeBuild);
        assert.equal(evidence.sourceFilesSha256After, metadata.sourceBeforeBuild);
        assert.equal(fingerprint("dist"), metadata.distSha256, "built distribution changed during pair");
        metadata.modes[mode] = {
            output,
            rawSha256: hash(readFileSync(output)),
            trackedIdsHash: evidence.before.trackedIdsHash,
            passed: true,
        };
    }
    assert.equal(
        metadata.modes.main.trackedIdsHash,
        metadata.modes.hybrid.trackedIdsHash,
        "tracked IDs differ between modes",
    );
    metadata.passed = true;
} catch (error) {
    metadata.failure = error.stack;
    process.exitCode = 1;
} finally {
    metadata.sourceAfterPair = source();
    metadata.buildInputsAfter = buildInputs();
    metadata.modelSha256After = hash(readFileSync(model));
    if (
        metadata.sourceAfterPair !== metadata.sourceBeforeBuild ||
        metadata.buildInputsAfter !== metadata.buildInputsBefore ||
        metadata.modelSha256After !== metadata.modelSha256Before
    ) {
        metadata.passed = false;
        metadata.integrityFailure = true;
        process.exitCode = 1;
    }
    writeFileSync(path.join(directory, "pair.json"), JSON.stringify(metadata, null, 2), { flag: "wx" });
    console.log(JSON.stringify(metadata, null, 2));
}
