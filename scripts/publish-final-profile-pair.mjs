// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Publish one small paired summary and each measured raw file exactly once (gzip). No browser rerun. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { profileGeometryIssues } from "./profile-geometry.mjs";
import { aggregateProfileRealms } from "./profile-realms.mjs";

const [directory, prefix] = process.argv.slice(2);
assert.ok(directory && prefix && existsSync(path.dirname(path.resolve(prefix))));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pair = JSON.parse(readFileSync(path.join(directory, "pair.json")));
assert.equal(pair.passed, true);
assert.equal(pair.sourceBeforeBuild, pair.sourceAfterBuild);
assert.equal(pair.sourceBeforeBuild, pair.sourceAfterPair);
assert.equal(pair.buildInputsBefore, pair.buildInputsAfter);
assert.equal(pair.modelSha256Before, pair.modelSha256After);
const baseline = JSON.parse(gunzipSync(readFileSync("docs/performance/before-firefox-final.json.gz")));
const reports = {};
for (const mode of ["main", "hybrid"]) {
    const bytes = readFileSync(path.join(directory, `${mode}.json`));
    const data = JSON.parse(bytes);
    assert.equal(hash(bytes), pair.modes[mode].rawSha256);
    assert.equal(data.distSha256, pair.distSha256);
    assert.equal(data.sourceFilesSha256, pair.sourceBeforeBuild);
    assert.equal(data.sourceFilesSha256After, pair.sourceBeforeBuild);
    assert.equal(data.modelSha256Before, baseline.modelSha256Before);
    assert.equal(data.modelSha256After, baseline.modelSha256Before);
    assert.deepEqual(data.regressions, []);
    assert.deepEqual(data.errors, []);
    assert.deepEqual(data.writeAttempts, []);
    assert.deepEqual(profileGeometryIssues(data.geometryComparison, mode), []);
    assert.equal(data.scenarios.length, 97);
    for (const run of data.scenarios) {
        const realms = aggregateProfileRealms(run, {
            expectedMode: mode,
            workersObserved: run.realmTelemetry.workersObserved,
        });
        assert.equal(realms.complete, true, realms.issues.join("; "));
        assert.equal(realms.booleanCount, run.booleanCount);
        if (run.name !== "cold-open") {
            assert.equal(run.booleanCount, 0);
            assert.equal(run.sourceFeatureMisses, 0);
            assert.deepEqual(run.stability, {
                features: true,
                sketches: true,
                visibility: true,
                trackedIds: true,
            });
        }
    }
    for (const snapshot of [data.before, data.after]) {
        assert.equal(snapshot.featuresJson, baseline.before.featuresJson);
        assert.deepEqual(snapshot.sketches, baseline.before.sketches);
        assert.deepEqual(snapshot.visibility, baseline.before.visibility);
    }
    const cold = data.scenarios[0];
    const repeats = data.scenarios.slice(4, 14);
    const sorted = repeats.map((run) => run.elapsedMs).sort((a, b) => a - b);
    const stageTotals = {};
    for (const record of cold.sourceTrace.records) {
        stageTotals[record.stage] ??= { count: 0, totalMs: 0, maxMs: 0 };
        const stage = stageTotals[record.stage];
        stage.count++;
        stage.totalMs += record.durationMs;
        stage.maxMs = Math.max(stage.maxMs, record.durationMs);
    }
    const compact = (run) => ({
        name: run.name,
        elapsedMs: run.elapsedMs,
        maxEventLoopGapMs: run.maxEventLoopGapMs,
        mainBooleanCount: run.mainBooleanCount,
        workerBooleanCount: run.workerBooleanCount,
        longestMainBooleanMs: run.longestMainBooleanMs,
        longestWorkerBooleanMs: run.longestWorkerBooleanMs,
        meshCount: run.meshCount,
        mainWasmCapacityBytes: run.memoryAfter.wasmHeapBytes,
    });
    const cancellation = data.cancellationProbe;
    if (mode === "hybrid") {
        const replay = aggregateProfileRealms(cancellation, { expectedMode: mode, workersObserved: 1 });
        assert.equal(replay.complete, true);
        assert.equal(replay.worker.booleanCount, 1);
        assert.deepEqual(replay.worker.pendingAfter, { requests: 0, native: 0 });
    }
    reports[mode] = {
        rawSha256: hash(bytes),
        browserVersion: data.browserVersion,
        environment: data.environment,
        deploymentOverride: data.deploymentOverride,
        startupConfig: data.startupConfig,
        scenarios: data.scenarios.slice(0, 4).map(compact),
        repeatedPlate: {
            count: 10,
            elapsedMs: repeats.map((run) => run.elapsedMs),
            minMs: sorted[0],
            medianMs: (sorted[4] + sorted[5]) / 2,
            maxMs: sorted[9],
        },
        unchangedSessions: 96,
        allSketchCount: data.allSketchCount,
        allPayloadsAndTrackedIdsStable: true,
        allUnchangedBooleansAndFeatureMissesZero: true,
        completeCaptures: 97,
        geometry: {
            mode: data.geometryComparison.validationMode,
            pristineCleanBrepIdentical: data.geometryComparison.coldCleanBrepIdentical,
            cycleCleanBrepIdentical: data.geometryComparison.cyclesCleanBrepIdentical,
            independentCold: data.geometryComparison.independentCold,
            independentCycles: data.geometryComparison.independentCycles,
            faces: data.before.faces,
            edges: data.before.edges,
            vertices: data.before.vertices,
            bounds: data.before.bounds,
            volumeBefore: data.before.volume,
            volumeAfter: data.after.volume,
        },
        pickingBefore: data.before.picking,
        pickingAfter: data.after.picking,
        trackedIdsHash: data.before.trackedIdsHash,
        hiddenGeometry: data.before.hiddenGeometry,
        mainWasmCapacitiesBytes: [...new Set(data.scenarios.map((run) => run.memoryAfter.wasmHeapBytes))],
        workerHeapCapacityBytes: data.scenarios.at(-1).workerCapture?.after?.workerHeapCapacityBytes ?? null,
        residentHits: cold.sourceTrace.records
            .filter((record) => record.stage === "replica.capture")
            .reduce((sum, record) => sum + (record.details?.residentHits ?? 0), 0),
        coldSourceStages: stageTotals,
        cancellation: cancellation && {
            elapsedMs: cancellation.elapsedMs,
            callerSettled: cancellation.callerSettled,
            realmTelemetry: cancellation.realmTelemetry,
            sourceDropped: cancellation.sourceTrace.dropped,
        },
        errors: data.errors,
        writeAttempts: data.writeAttempts,
    };
    writeFileSync(`${prefix}-${mode}.json.gz`, gzipSync(bytes), { flag: "wx" });
}
assert.equal(reports.main.trackedIdsHash, reports.hybrid.trackedIdsHash);
const summary = {
    ...pair,
    baselineRevision: baseline.revision,
    reports,
    limitations: [
        "Shared machine; independent full suite running concurrently",
        "Capacity is not live allocation",
        "Worker heap/JS/GPU memory not measured",
        "Hybrid uses explicit graph/anchors/bounds/volume criterion, not pristine BREP byte identity",
    ],
};
writeFileSync(`${prefix}.json`, JSON.stringify(summary, null, 2), { flag: "wx" });
console.log(
    JSON.stringify(
        {
            sourceHash: pair.sourceBeforeBuild,
            buildHash: pair.distSha256,
            modes: Object.fromEntries(
                Object.entries(reports).map(([mode, report]) => [
                    mode,
                    {
                        scenarios: report.scenarios,
                        repeatedPlate: report.repeatedPlate,
                        mainWasmCapacitiesBytes: report.mainWasmCapacitiesBytes,
                        geometry: report.geometry,
                        picking: report.pickingBefore,
                        residentHits: report.residentHits,
                        coldSourceStages: report.coldSourceStages,
                        cancellation: report.cancellation,
                    },
                ]),
            ),
        },
        null,
        2,
    ),
);
