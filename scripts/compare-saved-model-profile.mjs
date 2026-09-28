// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Compare immutable full evidence, without another browser run or model write. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { profileGeometryIssues } from "./profile-geometry.mjs";
import { aggregateProfileRealms } from "./profile-realms.mjs";

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        "kernel-mode": { type: "string", default: "main" },
        "repeat-cycles": { type: "string", default: "10" },
        "geometry-audit": { type: "string" },
    },
});
assert.equal(positionals.length, 2);
const bytes = (file) => (file.endsWith(".gz") ? gunzipSync(readFileSync(file)) : readFileSync(file));
const before = JSON.parse(bytes(positionals[0]));
const afterBytes = bytes(positionals[1]);
const after = JSON.parse(afterBytes);
const mode = values["kernel-mode"];
assert.ok(["main", "hybrid", "worker", "auto"].includes(mode));
const repeats = Number(values["repeat-cycles"]);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 0);
// Historical evidence predates realm telemetry. New captures must prove completeness in every realm.
if (after.realmTelemetryVersion) {
    for (const run of after.scenarios) {
        assert.equal(run.telemetryComplete, true, run.telemetryIssues?.join("; "));
        assert.equal(run.mainBooleanCount + run.workerBooleanCount, run.booleanCount);
        const replay = aggregateProfileRealms(run, {
            expectedMode: mode,
            workersObserved: run.realmTelemetry?.workersObserved ?? 0,
        });
        assert.equal(replay.complete, true, replay.issues.join("; "));
        assert.equal(replay.booleanCount, run.booleanCount);
    }
}
assert.equal(after.modelSha256Before, before.modelSha256Before);
assert.equal(after.modelSha256After, before.modelSha256Before);
for (const snapshot of [after.before, after.after]) {
    assert.equal(snapshot.featuresJson, before.before.featuresJson, "full feature payload against pristine");
    assert.deepEqual(snapshot.sketches, before.before.sketches, "all sketch payloads against pristine");
    assert.deepEqual(snapshot.visibility, before.before.visibility, "visibility against pristine");
    assert.deepEqual(
        [snapshot.faces, snapshot.edges, snapshot.vertices],
        [before.before.faces, before.before.edges, before.before.vertices],
    );
    assert.deepEqual(snapshot.bounds, before.before.bounds);
}
let comparison = after.geometryComparison;
if (values["geometry-audit"]) {
    assert.equal(mode, "hybrid", "sidecar probes require explicit hybrid mode");
    const audit = JSON.parse(bytes(values["geometry-audit"]));
    assert.equal(
        audit.evidenceSha256,
        createHash("sha256").update(afterBytes).digest("hex"),
        "audit must bind to this exact evidence",
    );
    assert.equal(
        audit.baselineArtifactSha256,
        createHash("sha256").update(readFileSync(positionals[0])).digest("hex"),
        "audit must bind to this pristine baseline artifact",
    );
    comparison = { ...comparison };
    for (const label of ["baselineCold", "afterCold", "afterCycles"])
        comparison[label] = {
            ...comparison[label],
            geometryProbe: audit.independentGeometry?.probes?.[label],
        };
}
assert.deepEqual(profileGeometryIssues(comparison, mode), []);
assert.equal(after.allSketchCount, 83);
const sessions = after.scenarios.slice(1);
assert.equal(sessions.filter((run) => run.name.startsWith("all-sketches:")).length, 83);
assert.equal(sessions.length, 86 + repeats);
assert.ok(sessions.every((run) => run.booleanCount === 0 && run.sourceFeatureMisses === 0));
assert.ok(sessions.every((run) => Object.values(run.stability).every(Boolean)));
const repeat = after.scenarios
    .slice(4, 4 + repeats)
    .map((run) => run.elapsedMs)
    .sort((a, b) => a - b);
console.log(
    JSON.stringify(
        {
            pristinePayloadsAndVisibilityIdentical: true,
            geometryValidationMode: mode === "hybrid" ? "independent-ordered-graph-and-mass" : "strict-brep",
            geometryOnlyBrepIdentical: after.geometryComparison.coldCleanBrepIdentical,
            allSketches: after.allSketchCount,
            unchangedSessions: sessions.length,
            repeatCycles: repeats,
            repeatElapsedMs: repeats
                ? {
                      min: repeat[0],
                      median: (repeat[Math.floor((repeats - 1) / 2)] + repeat[Math.floor(repeats / 2)]) / 2,
                      max: repeat.at(-1),
                  }
                : null,
            wasmCapacitiesBytes: [...new Set(after.scenarios.map((run) => run.memoryAfter.wasmHeapBytes))],
            coldElapsedMs: after.scenarios[0].elapsedMs,
            maxEventLoopGapMs: after.scenarios[0].maxEventLoopGapMs,
            longestBooleanMs: after.scenarios[0].longestBooleanMs,
        },
        null,
        2,
    ),
);
