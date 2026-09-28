// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Validate and optionally preserve the owner's small paired report verbatim; no browser/build/model writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [input, output] = process.argv.slice(2);
assert.ok(input, "usage: publish-worker-pair.mjs <paired report> [new.json]");
const bytes = readFileSync(input);
const evidence = JSON.parse(bytes);
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(evidence.modelHash, "9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569");
assert.equal(evidence.baselineHash, hash(readFileSync("docs/performance/before-firefox-final.json.gz")));
assert.equal(evidence.reports.length, 2);
const main = evidence.reports.find((report) => report.mode === "main");
const hybrid = evidence.reports.find((report) => report.mode === "hybrid");
assert.ok(main && hybrid);
assert.deepEqual(
    [main.mainBooleans, main.workerBooleans, hybrid.mainBooleans, hybrid.workerBooleans],
    [83, 0, 0, 83],
);
assert.match(main.trackedIdsHash, /^[a-f0-9]{64}$/);
assert.equal(main.trackedIdsHash, hybrid.trackedIdsHash);
for (const report of [main, hybrid]) {
    assert.equal(report.topologyMatches, true);
    assert.equal(report.unchangedPristinePayloads, true);
    assert.ok(Math.abs(report.volume - 22330.460970036078) <= 1e-6);
    assert.equal(report.unchangedSketchSessions.length, 83);
    assert.equal(new Set(report.unchangedSketchSessions.map((session) => session.name)).size, 83);
}
assert.deepEqual(
    main.unchangedSketchSessions.map((session) => session.name),
    hybrid.unchangedSketchSessions.map((session) => session.name),
);
assert.equal(hybrid.inputDuringFirstOperation, true);
if (output) {
    assert.ok(existsSync(path.dirname(path.resolve(output))), "output parent must exist");
    assert.equal(path.extname(output), ".json");
    writeFileSync(output, bytes, { flag: "wx" });
}
console.log(
    JSON.stringify(
        {
            artifactSha256: hash(bytes),
            artifactBytes: bytes.length,
            sourceHash: evidence.sourceHash,
            buildHash: evidence.buildHash,
            modelHash: evidence.modelHash,
            browser: evidence.browser,
            trackedIdsHash: main.trackedIdsHash,
            modes: [main, hybrid].map((report) => ({
                mode: report.mode,
                elapsedMs: report.elapsedMs,
                maxEventLoopGapMs: report.maxEventLoopGapMs,
                mainWasmCapacityCold: report.mainWasmCapacityCold,
                mainWasmCapacityAfterSessions: report.mainWasmCapacityAfterSessions,
                residentHits: report.residentHits,
                allSketchCount: report.unchangedSketchSessions.length,
                captureMs: report.stages["replica.capture"]?.totalMs ?? 0,
                exportMs: report.stages["worker.replica.export"]?.totalMs ?? 0,
                installMs: report.stages["replica.install"]?.totalMs ?? 0,
            })),
        },
        null,
        2,
    ),
);
