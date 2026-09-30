// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Pure, fail-closed aggregation. Native worker timings are never inferred from main-realm RPC spans. */
export function aggregateProfileRealms(run, { expectedMode = "auto", workersObserved = 0 } = {}) {
    const source = run.sourceTrace?.records ?? [];
    const runtime = run.records ?? [];
    const issues = [];
    const before = run.workerCapture?.before;
    const after = run.workerCapture?.after;
    const modes = ["main", "hybrid", "worker"];
    const declaredMode = after?.mode ?? before?.mode;
    const mode = modes.includes(declaredMode)
        ? declaredMode
        : expectedMode === "auto"
          ? "unknown"
          : expectedMode;
    if (mode === "unknown")
        issues.push("kernel mode is undeclared; main-realm wrappers cannot establish worker absence");
    if (declaredMode && expectedMode !== "auto" && declaredMode !== expectedMode)
        issues.push("kernel mode differs from requested mode");
    if (before?.mode !== after?.mode) issues.push("kernel mode changed within capture");
    if (run.sourceTrace?.dropped) issues.push("source trace dropped records");
    const sum = (records) => records.reduce((total, record) => total + record.durationMs, 0);
    const max = (records) => records.reduce((value, record) => Math.max(value, record.durationMs), 0);
    const mainSource = source.filter(
        (record) => !record.stage.startsWith("worker.") && record.details?.realm !== "worker",
    );
    const native = runtime.filter(
        (record) => record.stage === "kernel.operation" && record.details?.boolean === true,
    );
    const sourceBooleans = mainSource.filter(
        (record) => record.stage === "kernel.operation" && record.details?.boolean === true,
    );
    if (run.sourceTrace && sourceBooleans.length !== native.length)
        issues.push("main source/runtime boolean counters disagree");
    const mainMesh = mainSource.filter((record) => record.stage === "mesh.kernel");
    const main = {
        booleanCount: native.length,
        booleanMs: sum(native),
        longestBooleanMs: max(native),
        sourceBooleanCount: run.sourceTrace ? sourceBooleans.length : null,
        meshCount: runtime.filter((record) => record.stage === "mesh.kernel").length,
        meshMs: run.sourceTrace
            ? sum(mainMesh)
            : sum(runtime.filter((record) => ["mesh.construct", "mesh.kernel"].includes(record.stage))),
        historyConversionMs: run.sourceTrace
            ? sum(mainSource.filter((record) => record.stage === "kernel.historyConversion"))
            : null,
        meshBufferMs: run.sourceTrace
            ? sum(mainSource.filter((record) => record.stage === "mesh.buffers"))
            : null,
    };
    const stages = new Set(["kernel.operation", "kernel.historyConversion", "mesh.kernel", "mesh.buffers"]);
    const events = new Map();
    for (const record of source) {
        const stage = record.stage.startsWith("worker.") ? record.stage.slice(7) : record.stage;
        if (!stages.has(stage) || (!record.stage.startsWith("worker.") && record.details?.realm !== "worker"))
            continue;
        const details = record.details ?? {};
        if (
            typeof details.workerId !== "string" ||
            !["string", "number"].includes(typeof details.eventId) ||
            !["string", "number"].includes(typeof details.requestId) ||
            !Number.isFinite(record.durationMs) ||
            record.durationMs < 0 ||
            (stage === "kernel.operation" && typeof details.boolean !== "boolean")
        ) {
            issues.push("malformed worker native event (identity, duration or boolean marker missing)");
            continue;
        }
        const key = JSON.stringify([details.workerId, details.eventId]);
        const value = { stage, durationMs: record.durationMs, details };
        const previous = events.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(value))
            issues.push(`conflicting worker event ${key}`);
        else events.set(key, value);
    }
    const workerEvents = [...events.values()];
    const workerBooleans = workerEvents.filter(
        (record) => record.stage === "kernel.operation" && record.details.boolean,
    );
    const histories = workerEvents.filter((record) => record.stage === "kernel.historyConversion");
    const meshes = workerEvents.filter((record) => record.stage === "mesh.kernel");
    const buffers = workerEvents.filter((record) => record.stage === "mesh.buffers");
    const workerRequired =
        mode !== "main" || workerEvents.length > 0 || workersObserved > 0 || before || after;
    let workerComplete = !workerRequired;
    if (workerRequired) {
        const startIssues = issues.length;
        if (!run.sourceTrace) issues.push("worker capture has no source trace");
        for (const [label, snapshot] of [
            ["before", before],
            ["after", after],
        ]) {
            if (
                !snapshot ||
                snapshot.schemaVersion !== 1 ||
                typeof snapshot.epoch !== "string" ||
                !modes.includes(snapshot.mode) ||
                snapshot.telemetryComplete !== true ||
                !Number.isSafeInteger(snapshot.dropped) ||
                snapshot.dropped < 0
            ) {
                issues.push(`${label}: missing/incomplete worker capture snapshot`);
                continue;
            }
            for (const field of ["pendingRequests", "pendingNative"]) {
                if (snapshot[field] !== 0) issues.push(`${label}: ${field} is not drained`);
            }
            for (const field of ["booleanCount", "historyCount", "meshCount", "meshBufferCount"]) {
                if (!Number.isSafeInteger(snapshot[field]) || snapshot[field] < 0)
                    issues.push(`${label}: invalid ${field}`);
            }
        }
        if (before && after) {
            if (before.epoch !== after.epoch)
                issues.push("worker counter epoch changed; cancelled/restarted work may be lost");
            if (after.dropped !== before.dropped) issues.push("worker native telemetry dropped records");
            for (const [field, count] of [
                ["booleanCount", workerBooleans.length],
                ["historyCount", histories.length],
                ["meshCount", meshes.length],
                ["meshBufferCount", buffers.length],
            ]) {
                if (after[field] - before[field] !== count)
                    issues.push(`worker ${field} delta disagrees with native events`);
            }
        }
        workerComplete = issues.length === startIssues;
    }
    if (mode === "main" && workerEvents.length)
        issues.push("main-only mode nevertheless executed worker native work");
    const complete = issues.length === 0;
    const worker = {
        complete: workerComplete && complete,
        observedBooleanCount: workerBooleans.length,
        booleanCount: complete ? workerBooleans.length : null,
        booleanMs: complete ? sum(workerBooleans) : null,
        longestBooleanMs: complete ? max(workerBooleans) : null,
        historyCount: complete ? histories.length : null,
        historyConversionMs: complete ? sum(histories) : null,
        meshCount: complete ? meshes.length : null,
        meshMs: complete ? sum(meshes) : null,
        meshBufferMs: complete ? sum(buffers) : null,
        // Transport latency includes queueing/copying/native work. Never add it to native totals.
        rpcCount: source.filter((record) => record.stage === "worker.rpc").length,
        rpcMs: sum(source.filter((record) => record.stage === "worker.rpc")),
        pendingBefore: before ? { requests: before.pendingRequests, native: before.pendingNative } : null,
        pendingAfter: after ? { requests: after.pendingRequests, native: after.pendingNative } : null,
    };
    return {
        schemaVersion: 1,
        mode,
        complete,
        issues,
        workersObserved,
        main,
        worker,
        booleanCount: complete ? main.booleanCount + workerBooleans.length : null,
        booleanMs: complete ? main.booleanMs + sum(workerBooleans) : null,
        meshCount: complete ? main.meshCount + meshes.length : null,
        // Worker durations use another realm's clock. Maxima are valid; cross-realm start-time sorting is not.
        longestBooleanMs: complete ? Math.max(main.longestBooleanMs, max(workerBooleans)) : null,
    };
}
