// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateProfileRealms } from "./profile-realms.mjs";

const snapshot = (changes = {}) => ({
    schemaVersion: 1,
    epoch: "page-1",
    mode: "hybrid",
    telemetryComplete: true,
    dropped: 0,
    pendingRequests: 0,
    pendingNative: 0,
    booleanCount: 0,
    historyCount: 0,
    meshCount: 0,
    meshBufferCount: 0,
    ...changes,
});
const event = (stage, eventId, durationMs, details = {}) => ({
    stage,
    started: 9000,
    durationMs,
    details: { workerId: "worker-1", requestId: 1, eventId, ...details },
});
const boolean = event("worker.kernel.operation", "boolean-1", 4700, { boolean: true });
const run = (records = [], after = {}) => ({
    records: [],
    sourceTrace: { records, dropped: 0 },
    workerCapture: { before: snapshot(), after: snapshot(after) },
});

test("hybrid native booleans are counted even when the main WASM wrapper sees zero", () => {
    const result = aggregateProfileRealms(run([boolean], { booleanCount: 1 }), { expectedMode: "hybrid" });
    assert.equal(result.complete, true);
    assert.equal(result.main.booleanCount, 0);
    assert.equal(result.worker.booleanCount, 1);
    assert.equal(result.booleanCount, 1);
    assert.equal(result.longestBooleanMs, 4700);
});

test("main source events are validation, not duplicate work; worker RPC is not native duration", () => {
    const main = { stage: "kernel.operation", durationMs: 25, details: { boolean: true } };
    const value = run([main, boolean, event("worker.rpc", "rpc", 5000)], { booleanCount: 1 });
    value.records.push(main);
    const result = aggregateProfileRealms(value);
    assert.equal(result.booleanCount, 2);
    assert.equal(result.booleanMs, 4725);
    assert.equal(result.worker.rpcMs, 5000);
});

test("worker history and mesh remain separate; duplicate forwarding does not double-count", () => {
    const history = event("kernel.historyConversion", "history", 15, { realm: "worker" });
    const mesh = event("worker.mesh.kernel", "mesh", 30);
    const buffers = event("worker.mesh.buffers", "buffers", 4);
    const result = aggregateProfileRealms(
        run([boolean, boolean, history, mesh, buffers], {
            booleanCount: 1,
            historyCount: 1,
            meshCount: 1,
            meshBufferCount: 1,
        }),
    );
    assert.equal(result.complete, true);
    assert.equal(result.worker.booleanCount, 1);
    assert.equal(result.worker.historyConversionMs, 15);
    assert.equal(result.worker.meshMs, 30);
    assert.equal(result.worker.meshBufferMs, 4);
    assert.equal(result.main.historyConversionMs, 0);
});

test("missing worker telemetry reports unknown, never zero", () => {
    for (const options of [
        { expectedMode: "hybrid" },
        { expectedMode: "worker" },
        { workersObserved: 1 },
        {},
    ]) {
        const result = aggregateProfileRealms({ records: [] }, options);
        assert.equal(result.complete, false);
        assert.equal(result.booleanCount, null);
        assert.equal(result.worker.booleanCount, null);
        assert.ok(result.issues.length > 0);
    }
});

test("explicit main-only legacy capture remains usable without worker hooks", () => {
    const result = aggregateProfileRealms({ records: [] }, { expectedMode: "main" });
    assert.equal(result.complete, true);
    assert.equal(result.booleanCount, 0);
});

test("fully drained unchanged worker captures prove zero work", () => {
    const result = aggregateProfileRealms(run());
    assert.equal(result.complete, true);
    assert.equal(result.booleanCount, 0);
    assert.equal(result.worker.meshCount, 0);
});

test("native work completed for a cancelled caller still counts", () => {
    const stale = { ...boolean, details: { ...boolean.details, accepted: false, cancelled: true } };
    const result = aggregateProfileRealms(run([stale], { booleanCount: 1 }));
    assert.equal(result.complete, true);
    assert.equal(result.booleanCount, 1);
});

for (const [label, mutate] of [
    [
        "native call survives cancellation",
        (value) => {
            value.workerCapture.after.pendingNative = 1;
        },
    ],
    [
        "request unresolved",
        (value) => {
            value.workerCapture.after.pendingRequests = 1;
        },
    ],
    [
        "lost worker event",
        (value) => {
            value.workerCapture.after.booleanCount = 1;
        },
    ],
    [
        "epoch reset",
        (value) => {
            value.workerCapture.after.epoch = "new-worker";
        },
    ],
    [
        "worker records dropped",
        (value) => {
            value.workerCapture.after.dropped = 1;
        },
    ],
    [
        "main capture dropped",
        (value) => {
            value.sourceTrace.dropped = 1;
        },
    ],
    [
        "mode changed",
        (value) => {
            value.workerCapture.after.mode = "main";
        },
    ],
    [
        "malformed identity",
        (value) => {
            value.sourceTrace.records.push({ ...boolean, details: { boolean: true } });
        },
    ],
    [
        "main counters disagree",
        (value) => {
            value.records.push({ stage: "kernel.operation", details: { boolean: true }, durationMs: 1 });
        },
    ],
    [
        "conflicting duplicate",
        (value) => {
            value.sourceTrace.records.push(boolean, { ...boolean, durationMs: 1 });
            value.workerCapture.after.booleanCount = 1;
        },
    ],
]) {
    test(`incomplete evidence fails closed: ${label}`, () => {
        const value = run();
        mutate(value);
        const result = aggregateProfileRealms(value);
        assert.equal(result.complete, false);
        assert.equal(result.booleanCount, null);
        assert.ok(result.issues.length > 0);
    });
}
