// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
function brepFirstDifference(before, after) {
    if (!after || before === after) return undefined;
    const left = before.split("\n");
    const right = after.split("\n");
    const index = left.findIndex((line, i) => line !== right[i]);
    return {
        line: index + 1,
        before: left[index]?.slice(0, 200),
        after: right[index]?.slice(0, 200),
        beforeLines: left.length,
        afterLines: right.length,
    };
}
const stages = (records) =>
    Object.fromEntries(
        [...new Set(records.map((r) => r.stage))].map((stage) => {
            const rows = records.filter((r) => r.stage === stage);
            return [
                stage,
                {
                    count: rows.length,
                    totalMs: rows.reduce((sum, r) => sum + r.durationMs, 0),
                    maxMs: Math.max(...rows.map((r) => r.durationMs)),
                },
            ];
        }),
    );
const summary = {
    revision: evidence.revision,
    environment: evidence.environment,
    browserVersion: evidence.browserVersion,
    hashes: [evidence.modelSha256Before, evidence.modelSha256After],
    capabilities: evidence.capabilities,
    sourceClean: !evidence.sourceDirty && evidence.sourceDiffSha256 === evidence.sourceDiffSha256After,
    sourceFilesSha256: evidence.sourceFilesSha256,
    sourceFilesUnchanged: evidence.sourceFilesSha256 === evidence.sourceFilesSha256After,
    distSha256: evidence.distSha256,
    harnessSha256: evidence.harnessSha256,
    realmTelemetryVersion: evidence.realmTelemetryVersion,
    expectedKernelMode: evidence.expectedKernelMode,
    deploymentOverride: evidence.deploymentOverride,
    deploymentConfigRequests: evidence.deploymentConfigRequests,
    startupConfig: evidence.startupConfig,
    allSketchCount: evidence.allSketchCount,
    regressions: evidence.regressions,
    geometryComparison:
        evidence.geometryComparison &&
        Object.fromEntries(
            Object.entries(evidence.geometryComparison).map(([key, value]) => [
                key,
                value?.cleanBrep ? { ...value, cleanBrep: undefined, geometryProbe: undefined } : value,
            ]),
        ),
    errors: evidence.errors,
    writeAttempts: evidence.writeAttempts,
    failure: evidence.failure,
    geometry: evidence.before && {
        faces: evidence.before.faces,
        edges: evidence.before.edges,
        vertices: evidence.before.vertices,
        bounds: evidence.before.bounds,
        brepSha256: evidence.before.brepSha256,
        brepUnchanged: evidence.before.brepSha256 === evidence.after?.brepSha256,
        brepFirstDifference: brepFirstDifference(evidence.before.brep, evidence.after?.brep),
        featuresUnchanged: evidence.before.featuresJson === evidence.after?.featuresJson,
        sketchesUnchanged:
            JSON.stringify(evidence.before.sketches) === JSON.stringify(evidence.after?.sketches),
        visibilityUnchanged:
            JSON.stringify(evidence.before.visibility) === JSON.stringify(evidence.after?.visibility),
        after: evidence.after && {
            faces: evidence.after.faces,
            edges: evidence.after.edges,
            vertices: evidence.after.vertices,
            bounds: evidence.after.bounds,
            brepSha256: evidence.after.brepSha256,
        },
        featureErrors: evidence.before.featureErrors,
        volume: evidence.before.volume,
        hiddenGeometry: evidence.before.hiddenGeometry,
    },
    scenarios: evidence.scenarios.map(({ records, sourceTrace, ...run }) => ({
        ...run,
        runtimeMainStages: stages(records),
        // Each source event belongs to ONE bucket. RPC is page wall time, not worker native time.
        sourceStagesByRealm: sourceTrace && {
            main: stages(
                sourceTrace.records.filter(
                    (record) => !record.stage.startsWith("worker.") && record.details?.realm !== "worker",
                ),
            ),
            worker: stages(
                sourceTrace.records.filter(
                    (record) =>
                        record.stage !== "worker.rpc" &&
                        (record.stage.startsWith("worker.") || record.details?.realm === "worker"),
                ),
            ),
            rpc: stages(sourceTrace.records.filter((record) => record.stage === "worker.rpc")),
        },
        sourceDropped: sourceTrace?.dropped,
        sourceMeshes: sourceTrace?.records
            .filter((r) => r.stage === "mesh.kernel" && r.details?.realm !== "worker")
            .reduce((counts, r) => {
                const key = `${r.details?.meshKind}:${r.details?.visible}`;
                counts[key] = (counts[key] ?? 0) + 1;
                return counts;
            }, {}),
        profileHits: sourceTrace?.records.filter((r) => r.stage === "profile.query" && r.details?.cacheHit)
            .length,
        profileMisses: sourceTrace?.records.filter((r) => r.stage === "profile.query" && !r.details?.cacheHit)
            .length,
        meshes: records
            .filter((r) => r.stage === "mesh.kernel")
            .reduce((counts, r) => {
                const key = `${r.details.meshKind}:${r.details.visible}`;
                counts[key] = (counts[key] ?? 0) + 1;
                return counts;
            }, {}),
        longestMainNativeBoolean: records
            .filter((r) => r.stage === "kernel.operation" && r.details.boolean)
            .sort((a, b) => b.durationMs - a.durationMs)[0],
        longestWorkerNativeBoolean: sourceTrace?.records
            .filter(
                (record) =>
                    record.details?.boolean &&
                    (record.stage === "worker.kernel.operation" ||
                        (record.stage === "kernel.operation" && record.details.realm === "worker")),
            )
            .sort((a, b) => b.durationMs - a.durationMs)[0],
        runtimeFeatureHits: records.some((r) => r.stage === "feature.step")
            ? records.filter((r) => r.stage === "feature.step" && r.details.cacheHit).length
            : null,
        runtimeFeatureMisses: records.some((r) => r.stage === "feature.step")
            ? records.filter((r) => r.stage === "feature.step" && !r.details.cacheHit).length
            : null,
    })),
};
if (process.argv[3]) {
    const prefix = path.resolve(process.argv[3]);
    if (!existsSync(path.dirname(prefix))) throw new Error("Evidence parent must already exist");
    // New derived evidence only. Never overwrites an input or earlier measurement.
    const raw = readFileSync(process.argv[2]);
    summary.rawSha256 = createHash("sha256").update(raw).digest("hex");
    writeFileSync(`${prefix}.json.gz`, gzipSync(raw), { flag: "wx" });
    writeFileSync(`${prefix}.json`, JSON.stringify(summary, null, 2), { flag: "wx" });
    console.log(`Published ${prefix}.{json,json.gz}`);
} else {
    console.log(JSON.stringify(summary, null, 2));
}
