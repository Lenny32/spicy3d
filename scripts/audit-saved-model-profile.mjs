// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Replay immutable telemetry; optionally audit detached BREPs in a bare kernel (NOT a model benchmark). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { firefox } from "playwright";
import { captureProfileGeometry, compareProfileGeometry } from "./profile-geometry.mjs";
import { aggregateProfileRealms } from "./profile-realms.mjs";

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        geometry: { type: "boolean" },
        output: { type: "string" },
        "publish-prefix": { type: "string" },
        "reuse-audit": { type: "string" },
    },
});
assert.equal(
    positionals.length,
    2,
    "usage: audit-saved-model-profile.mjs <full evidence> <before evidence> [--geometry] [--output new.json]",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => {
    const bytes = readFileSync(file);
    return { hash: hash(bytes), data: JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes) };
};
const input = read(positionals[0]);
const baseline = read(positionals[1]);
const evidence = input.data;
const cold = evidence.scenarios[0];
const stageTotals = {};
for (const record of cold.sourceTrace.records) {
    stageTotals[record.stage] ??= { count: 0, totalMs: 0, maxMs: 0 };
    const stage = stageTotals[record.stage];
    stage.count++;
    stage.totalMs += record.durationMs;
    stage.maxMs = Math.max(stage.maxMs, record.durationMs);
}
const replay = evidence.scenarios.map((run) =>
    aggregateProfileRealms(run, {
        expectedMode: evidence.expectedKernelMode,
        workersObserved: run.realmTelemetry?.workersObserved ?? 0,
    }),
);
assert.ok(
    replay.every((result) => result.complete),
    "recorded native telemetry must reconcile before publication",
);
assert.ok(
    replay.every(
        (result, index) =>
            result.booleanCount === evidence.scenarios[index].booleanCount &&
            result.main.booleanCount === evidence.scenarios[index].mainBooleanCount &&
            result.worker.booleanCount === evidence.scenarios[index].workerBooleanCount,
    ),
    "current aggregation must agree with recorded counters",
);
assert.equal(evidence.modelSha256Before, baseline.data.modelSha256Before);
assert.equal(evidence.modelSha256After, evidence.modelSha256Before);
for (const snapshot of [evidence.before, evidence.after]) {
    assert.equal(snapshot.featuresJson, baseline.data.before.featuresJson);
    assert.deepEqual(snapshot.sketches, baseline.data.before.sketches);
    assert.deepEqual(snapshot.visibility, baseline.data.before.visibility);
}
const sessions = evidence.scenarios.slice(1);
const allSketches = sessions.filter((run) => run.name.startsWith("all-sketches:"));
const named = sessions.filter((run) => run.name.startsWith("unchanged:"));
const report = {
    auditScope: "existing evidence replay and detached BREP validation; no new application benchmark",
    evidenceSha256: input.hash,
    baselineArtifactSha256: baseline.hash,
    measuredRevision: evidence.revision,
    sourceFilesSha256: evidence.sourceFilesSha256,
    sourceStableDuringRun: evidence.sourceFilesSha256 === evidence.sourceFilesSha256After,
    measuredDistSha256: evidence.distSha256,
    browserVersion: evidence.browserVersion,
    modelSha256: evidence.modelSha256Before,
    payloadsAndVisibilityMatchPristine: true,
    telemetryReplay: { captures: replay.length, complete: true, storedCountsMatch: true },
    cold: {
        elapsedMs: cold.elapsedMs,
        mainLoopGapMs: cold.maxEventLoopGapMs,
        realms: replay[0],
        stageTotals,
    },
    sessions: {
        count: sessions.length,
        allSketchCount: allSketches.length,
        additionalPlateRepeats: Math.max(
            0,
            named.filter((run) => run.name === "unchanged:Sk_Plate").length - 1,
        ),
        allZeroBooleans: sessions.every((run) => run.booleanCount === 0),
        allZeroFeatureMisses: sessions.every((run) => run.sourceFeatureMisses === 0),
        allPayloadsStable: sessions.every((run) => Object.values(run.stability).every(Boolean)),
        minElapsedMs: Math.min(...sessions.map((run) => run.elapsedMs)),
        maxElapsedMs: Math.max(...sessions.map((run) => run.elapsedMs)),
        named: named.map((run) => ({
            name: run.name,
            elapsedMs: run.elapsedMs,
            mainLoopGapMs: run.maxEventLoopGapMs,
            meshCount: run.meshCount,
        })),
    },
    memory: {
        mainWasmCapacityByFirstSessions: evidence.scenarios
            .slice(0, 4)
            .map((run) => run.memoryAfter.wasmHeapBytes),
        allSketchMainCapacities: [...new Set(allSketches.map((run) => run.memoryAfter.wasmHeapBytes))],
        workerHeapCapacityBytes:
            evidence.scenarios.at(-1).workerCapture?.after?.workerHeapCapacityBytes ?? null,
    },
    recordedByteChecks: {
        cold: evidence.geometryComparison?.coldCleanBrepIdentical,
        cycles: evidence.geometryComparison?.cyclesCleanBrepIdentical,
    },
    geometry: {
        counts: [evidence.before.faces, evidence.before.edges, evidence.before.vertices],
        bounds: evidence.before.bounds,
        volume: evidence.before.volume,
        hiddenGeometry: evidence.before.hiddenGeometry,
    },
    errors: evidence.errors,
    writeAttempts: evidence.writeAttempts,
};
if (values.geometry) {
    const js = readFileSync("packages/wasm/lib/spicy-wasm.js");
    const wasmBytes = readFileSync("packages/wasm/lib/spicy-wasm.wasm");
    const server = createServer((request, response) => {
        if (request.method !== "GET") return response.writeHead(405).end();
        const route = new URL(request.url, "http://localhost").pathname;
        if (route === "/")
            return response
                .writeHead(200, { "Content-Type": "text/html" })
                .end("<!doctype html><title>Detached geometry audit</title>");
        if (route === "/kernel.js")
            return response.writeHead(200, { "Content-Type": "text/javascript" }).end(js);
        if (route === "/kernel.wasm")
            return response.writeHead(200, { "Content-Type": "application/wasm" }).end(wasmBytes);
        response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await firefox.launch();
        const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
        const origin = `http://127.0.0.1:${server.address().port}`;
        await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin && route.request().method() === "GET"
                ? route.continue()
                : route.abort(),
        );
        const page = await context.newPage();
        await page.goto(origin);
        await page.evaluate(async () => {
            const { default: initialize } = await import("/kernel.js");
            globalThis.wasm = await initialize({ locateFile: () => "/kernel.wasm" });
        });
        const probes = {};
        for (const [label, snapshot] of Object.entries({
            baselineCold: baseline.data.before,
            afterCold: evidence.before,
            afterCycles: evidence.after,
        })) {
            probes[label] = await page.evaluate(captureProfileGeometry, snapshot.brep);
        }
        report.independentGeometry = {
            algorithm: "ordered-bfs-v1",
            browserVersion: browser.version(),
            kernelSha256: hash(wasmBytes),
            cold: compareProfileGeometry(probes.baselineCold, probes.afterCold),
            cycles: compareProfileGeometry(probes.baselineCold, probes.afterCycles),
            probes,
        };
        assert.equal(report.independentGeometry.cold.ok, true, "independent cold graph/mass check");
        assert.equal(report.independentGeometry.cycles.ok, true, "independent post-cycle graph/mass check");
    } finally {
        await browser?.close();
        server.close();
    }
}
if (values["reuse-audit"]) {
    assert.ok(!values.geometry, "choose a fresh or reused geometry audit");
    const previous = read(values["reuse-audit"]).data;
    assert.equal(previous.evidenceSha256, input.hash);
    assert.equal(previous.baselineArtifactSha256, baseline.hash);
    report.independentGeometry = previous.independentGeometry;
    const probes = report.independentGeometry?.probes;
    assert.equal(compareProfileGeometry(probes?.baselineCold, probes?.afterCold).ok, true);
    assert.equal(compareProfileGeometry(probes?.baselineCold, probes?.afterCycles).ok, true);
}
if (values.output) {
    assert.ok(existsSync(path.dirname(path.resolve(values.output))), "output parent must exist");
    assert.equal(path.extname(values.output), ".json");
    writeFileSync(values.output, JSON.stringify(report, null, 2), { flag: "wx" });
}
if (values["publish-prefix"]) {
    const prefix = path.resolve(values["publish-prefix"]);
    assert.ok(existsSync(path.dirname(prefix)), "publication parent must exist");
    assert.ok(report.independentGeometry, "publish only after independent geometry audit");
    const compact = JSON.stringify(report, (key, value) => (key === "probes" ? undefined : value), 2);
    const raw = readFileSync(positionals[0]);
    writeFileSync(`${prefix}.json.gz`, positionals[0].endsWith(".gz") ? raw : gzipSync(raw), { flag: "wx" });
    writeFileSync(`${prefix}.geometry.json.gz`, gzipSync(JSON.stringify(report)), { flag: "wx" });
    writeFileSync(`${prefix}.json`, compact, { flag: "wx" });
}
console.log(JSON.stringify(report, (key, value) => (key === "probes" ? "<retained in output>" : value), 2));
