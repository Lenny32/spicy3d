# Worker profiling handoff (hybrid replicas)

**Final token-contract verification:** [the post-review pair](performance/final-paired.md) passed with the
current per-request `PerformanceTrace.captureId`. Counters are cumulative **profiled-work** totals, not all
uninstrumented lifetime work. The harness drains before capture and before disabling it; a real cancelled
request settled its caller while native work remained pending, then forwarded the executed call into the
same capture and drained to zero. Disabled-clock/event tests also pass. No reset is used to hide loss.

**Deployment enablement:** the provider is now opt-in. The harness's `--kernel-mode hybrid` serves
`{ "performance": { "geometryWorker": true } }` over its same-origin GET `/deployment.json` route
before startup. Main is the CLI/regression default and explicitly serves `false`, regardless of the static
deployment file. The override is in memory only and startup observation is retained in evidence. Auto/worker
remain diagnostic modes and do not silently opt in. See [the paired review](performance/worker-opt-in-paired.md).

**The bridge and native-event forwarding are now implemented.** All 87 captures in the worker owner's
observed all-sketch run reconcile with this contract; see the
[audited worker observation](performance/worker-integrated-observation.md). Existing BEFORE/pre-worker
AFTER artifacts are unchanged. No new full application benchmark was run for the audit.

The inspected protocol (`workerProtocol.ts`) sends `request` / `cancel` / `accept`, then `result` or
`fatal`; `stats` exposes only handle count. `WorkerKernel` invokes its own WASM instance. Main-page
`wasm.ShapeFactory` monkeypatches therefore cannot observe worker booleans, history conversion or meshes.
`KernelWorkerClient` can settle an aborted caller before the host finishes native execution. Neither an
empty client-pending map nor `document.settled()` alone proves all worker telemetry has arrived.

## Harness contract implemented by the worker integration

Expose an optional **page-realm** bridge before a benchmark starts (installing it must not start a kernel):

```ts
globalThis.Spicy3DWorkerProfile = {
    // Resolves after queued/running requests AND late/cancelled native work/telemetry are drained.
    settled(): Promise<void>,
    // Returns a fresh plain snapshot; counters cover all kernel workers, not only the latest worker.
    snapshot(): {
        schemaVersion: 1,
        mode: "main" | "hybrid" | "worker",
        epoch: string,
        telemetryComplete: boolean,
        dropped: number,
        pendingRequests: number,
        pendingNative: number,
        booleanCount: number,
        historyCount: number,
        meshCount: number,
        meshBufferCount: number,
        // Optional additional memory metadata, retained verbatim (capacity, NOT live allocations):
        workerHeapCapacityBytes?: number,
    },
};
```

Counter semantics:

- Integers, monotonically increasing **profiled-work** totals over one `epoch`, including failed and cancelled-but-executed
  traced native operations. Register the bridge even when a worker is lazily created later, so its first snapshot
  can establish zero counters. Never reset on `PerformanceTrace.enable()`; the harness takes deltas.
- `epoch` identifies counter continuity. Prefer a page-level epoch with accumulation across worker restarts.
  A reset must change epoch; a changed epoch within one scenario makes its evidence incomplete.
- `pendingRequests` is outstanding caller/RPC work. `pendingNative` also covers queued, running or
  cancelled work whose terminal native accounting/telemetry has not yet been received. Both must be zero
  before and after a measured scenario. A queued cancellation needs a terminal acknowledgement or
  equivalent accounting, not just removing the caller's promise.
- `telemetryComplete=true` means every started native operation is accounted for and its profiling
  records have been delivered. A fatal termination that loses native results/timings must mark it false;
  do not turn a dropped cancelled reply into zero work. `dropped` must not increase during a capture.
- The four counters count actual invocations of the respective native/JS conversion stages below.
  They are **not** RPC counts, successful-result counts, feature counts or installed-result counts.

The harness calls bridge `settled()` before starting capture, enables the existing page `PerformanceTrace`,
takes the before snapshot, runs the operation, awaits document/node/bridge barriers, and takes the after
snapshot **before disabling the trace**. No sleeps substitute for this drain contract.

## Native records to forward into the page's PerformanceTrace

For each actual worker stage, send numeric duration and scalar metadata over the worker protocol, then
forward once into the active page capture with `PerformanceTrace.record(stage, started, durationMs, details)`.
Do this before resolving the RPC/drain barrier, **even if the original caller has been cancelled**.
Do not import the core/UI barrel into `WorkerKernel`; transport plain timing data to the page.

| Stage | Counter | Timed boundary |
|---|---|---|
| `worker.kernel.operation` | `booleanCount` when `details.boolean === true` | Actual `methods[operation](a, b)` native call in `WorkerKernel.execute`; a queued-cancelled call never enters it and is not counted |
| `worker.kernel.historyConversion` | `historyCount` | Conversion of the six returned tracking vectors into typed arrays |
| `worker.mesh.kernel` | `meshCount` | OCCT Mesher constructor plus native `mesh()` |
| `worker.mesh.buffers` | `meshBufferCount` | Native arrays → transferable JS mesh buffers |

Every record requires:

```ts
{
    workerId: "opaque-instance-id",  // unique across restarts
    requestId: 17,                   // request identity in that worker
    eventId: 42,                     // unique per measured stage event in that worker
    boolean: true,                   // REQUIRED boolean for kernel.operation, false for other native ops
    operation: "booleanFuseTracked", // optional descriptive operation
    nodeId, featureIndex,            // optional explicit attribution, no global async stack
    accepted: false, cancelled: true // optional; NEVER excludes executed work from counters
}
```

`eventId` is shared by duplicate forwards of the *same* event, but different for boolean/history/mesh
stages even in one request. The aggregator deduplicates matching `(workerId,eventId)` records; conflicting
duplicates invalidate evidence. `started` uses the worker's clock; duration must be measured entirely in
that realm. Do not subtract a worker timestamp from a page timestamp or interpret a long worker call as a
main-thread block. `kernel.operation`, `kernel.historyConversion`, `mesh.kernel`, `mesh.buffers` with
`details.realm="worker"` are also accepted, as an alternative to the prefixed stage names.

The tracked native call already includes **native history completion**. The history-conversion stage
measures JS/embind conversion only. A separate native-history duration is unavailable without a native API
change; do not label RPC time or vector conversion as native history completion.

Optional `worker.rpc` page spans measure request/response latency, including queueing, transfers and
native work. They are reported separately and **never added** to native time. Optional BREP export/import
or replica-install stages may use distinct names for main-thread overhead. Heap metadata must identify
worker capacity separately: the page's WebAssembly-instantiation hook observes only the main realm.

## Failure-resistant aggregation

`scripts/profile-realms.mjs` is pure and tested without a browser:

- Main native booleans come from page runtime wrappers. Page source counts validate them, rather than
  being added a second time. Worker native records supply separate counts/durations/history/mesh metrics.
- Worker event counts must match all four snapshot deltas. Missing telemetry, dropped records, conflicting
  duplicate events, incomplete drains, epoch resets and main/source discrepancies yield `complete=false`.
- Incomplete totals are **`null` (unknown), never zero**. Observed main/worker counts remain available for
  diagnosis, but cannot satisfy regression assertions.
- `--kernel-mode hybrid` / `worker` requires a verified worker boolean on cold load, and still requires
  total native booleans = 83 for this benchmark. An accidental all-main fallback cannot pass as offload.
- `--kernel-mode auto` requires a bridge mode declaration. `--kernel-mode main` explicitly supports the
  old pre-worker build; observed workers require bridge accounting even in that mode. Merely creating a
  Worker is not evidence that kernel work was offloaded.
- New summaries give every source event exactly one main/worker/RPC bucket under `sourceStagesByRealm`;
  historical summaries retain their old schema. Never add source and runtime totals. Worker longest-call
  time and main longest-call time are separate.

## Reproduction commands

```powershell
# Build the ready snapshot first. Do not reuse a pre-worker dist as worker evidence.
node scripts/profile-saved-model.mjs --source . --allow-dirty --kernel-mode hybrid --model "tickets/optimization/Mouse Bottom.spicy" --output "C:\Users\lcormi\AppData\Local\Temp\opencode\new-worker-after.json" --all-sketches --compare-before docs/performance/before-firefox-final.json.gz --assert-optimized

$env:SPICY3D_BENCHMARK_MODEL = "tickets/optimization/Mouse Bottom.spicy"
$env:SPICY3D_BENCHMARK_MODE = "hybrid" # explicit opt-in; omitted/default is main
node --test scripts/profile-saved-model.node-test.mjs
```

Pure telemetry tests (no browser benchmark):

```powershell
node --test scripts/profile-realms.node-test.mjs
```

No worker or application source files were changed by the harness audit. The final run now verifies the
request-scoped capture flag, disabled-clock/event guards, detailed replica phase timings and real native
cancellation drain. Worker heap capacity and live-allocation accounting remain unmeasured.
