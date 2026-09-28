// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Compare immutable full evidence, without another browser run or model write. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const read = (file) => JSON.parse(file.endsWith(".gz") ? gunzipSync(readFileSync(file)) : readFileSync(file));
const before = read(process.argv[2]);
const after = read(process.argv[3]);
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
assert.equal(after.geometryComparison.coldCleanBrepIdentical, true);
assert.equal(after.geometryComparison.cyclesCleanBrepIdentical, true);
assert.equal(after.allSketchCount, 83);
const sessions = after.scenarios.slice(1);
assert.equal(sessions.length, 96);
assert.ok(sessions.every((run) => run.booleanCount === 0 && run.sourceFeatureMisses === 0));
assert.ok(sessions.every((run) => Object.values(run.stability).every(Boolean)));
const repeat = after.scenarios
    .slice(4, 14)
    .map((run) => run.elapsedMs)
    .sort((a, b) => a - b);
console.log(
    JSON.stringify(
        {
            pristinePayloadsAndVisibilityIdentical: true,
            geometryOnlyBrepIdentical: true,
            allSketches: after.allSketchCount,
            unchangedSessions: sessions.length,
            repeatElapsedMs: { min: repeat[0], median: (repeat[4] + repeat[5]) / 2, max: repeat.at(-1) },
            wasmCapacitiesBytes: [...new Set(after.scenarios.map((run) => run.memoryAfter.wasmHeapBytes))],
            coldElapsedMs: after.scenarios[0].elapsedMs,
            maxEventLoopGapMs: after.scenarios[0].maxEventLoopGapMs,
            longestBooleanMs: after.scenarios[0].longestBooleanMs,
        },
        null,
        2,
    ),
);
