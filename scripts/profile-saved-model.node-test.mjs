// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Opt-in real-browser regression: SPICY3D_BENCHMARK_MODEL=<read-only file> node --test scripts/profile-saved-model.node-test.mjs */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("read-only example: stable geometry/references, zero unchanged booleans, deferred hidden meshes and profile hits", {
    skip: !process.env.SPICY3D_BENCHMARK_MODEL,
    timeout: 600_000,
}, () => {
    const parent = path.join(os.tmpdir(), "opencode");
    assert.ok(existsSync(parent), "create/verify the benchmark output parent before running");
    const directory = mkdtempSync(path.join(parent, "spicy3d-regression-"));
    const output = path.join(directory, "after.json");
    execFileSync(
        process.execPath,
        [
            "scripts/profile-saved-model.mjs",
            "--source",
            ".",
            "--allow-dirty",
            "--model",
            process.env.SPICY3D_BENCHMARK_MODEL,
            "--output",
            output,
            "--all-sketches",
            "--compare-before",
            "docs/performance/before-firefox-final.json.gz",
            "--assert-optimized",
        ],
        { stdio: "inherit", timeout: 580_000 },
    );
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(evidence.modelSha256Before, evidence.modelSha256After);
    assert.equal(evidence.sourceFilesSha256, evidence.sourceFilesSha256After);
    assert.deepEqual(evidence.errors, []);
    assert.deepEqual(evidence.writeAttempts, []);
    assert.deepEqual(evidence.regressions, []);
    assert.equal(evidence.allSketchCount, 83);
    assert.equal(evidence.scenarios.filter((run) => run.name.startsWith("all-sketches:")).length, 83);
    const cold = evidence.scenarios[0];
    assert.equal(cold.booleanCount, 83);
    assert.equal(cold.sourceBooleanCount, 83);
    assert.equal(cold.sourceFeatureMisses, 84);
    assert.ok(cold.sourceTrace.records.some((record) => record.stage === "body.batch"));
    const hidden = evidence.before.hiddenGeometry;
    assert.ok(hidden.length > 0, "the fixture must actually exercise hidden geometry");
    for (const node of hidden) {
        assert.equal(node.visualFound, true, node.nodeId);
        assert.equal(node.visualMeshesBuilt, false, node.nodeId);
        assert.equal(node.kernelMeshed, false, node.nodeId);
    }
    for (const run of evidence.scenarios.slice(1)) {
        assert.equal(run.booleanCount, 0, run.name);
        assert.equal(run.sourceBooleanCount, 0, run.name);
        assert.equal(run.sourceFeatureMisses, 0, run.name);
        assert.ok(run.sourceFeatureHits > 0, run.name);
        assert.deepEqual(run.stability, { features: true, sketches: true, visibility: true }, run.name);
    }
    let hits = 0;
    for (const run of evidence.scenarios) {
        assert.equal(run.sourceTrace.dropped, 0);
        const builds = new Map();
        for (const record of run.sourceTrace.records) {
            const id = record.details?.nodeId;
            if (record.stage === "profile.build") builds.set(id, (builds.get(id) ?? 0) + 1);
            if (record.stage === "profile.query") {
                assert.equal(builds.get(id) ?? 0, record.details.cacheHit ? 0 : 1, `${run.name}:${id}`);
                if (record.details.cacheHit) hits++;
                builds.delete(id);
            }
        }
        assert.equal(builds.size, 0, "every profile build has a completed query");
    }
    assert.ok(hits >= 83, "cold display/feature queries share profiles");
    assert.equal(evidence.geometryComparison.coldCleanBrepIdentical, true);
    assert.equal(evidence.geometryComparison.cyclesCleanBrepIdentical, true);
    for (const snapshot of [evidence.before, evidence.after]) {
        assert.deepEqual([snapshot.faces, snapshot.edges, snapshot.vertices], [1232, 3448, 2255]);
        assert.deepEqual(snapshot.bounds, evidence.geometryComparison.baselineCold.bounds);
        assert.deepEqual(snapshot.featureErrors, []);
    }
    console.log(`Regression evidence retained at ${output}`);
});
