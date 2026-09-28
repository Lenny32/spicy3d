# Hybrid worker: audited observation, not the final-source benchmark

The worker owner's `worker-integrated-all-sketches.json` was audited without rerunning document loading.
The observed production snapshot is based on revision `7b0b384d990d16755846e094f18bae94235cef9c` plus
uncommitted integration changes; its package-source fingerprint is
`f4fb1f467d7fca0789b2f05d19ca29365f351bcea8baf655760cf4218d62fae6` and remained stable during that run.
The owner subsequently hardened failure/fallback handling, so these timings must not be presented as a
fresh validation of the latest source. Browser: Firefox 155.0; same Windows/i9 machine as pre-worker evidence.

Artifacts:
- [Concise audited summary](worker-integrated-observation.json): measured counters and one source-stage table.
- [Original full measurement](worker-integrated-observation.json.gz): unchanged raw JSON, compressed.
- [Independent geometry audit](worker-integrated-observation.geometry.json.gz): retained graph probes and audit.

Original measurement SHA-256: `1e1b918ae569162e0ce15c5e0455af7300cd12ec6a8562fb86846c98b120325f`.
The original `Mouse Bottom.spicy` hash remains
`9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569`.

## What is established

| Measurement | Pre-worker combined run | Observed hybrid run |
|---|---:|---:|
| Cold-open | 44,070 ms | **99,830 ms** |
| Maximum main-loop gap during cold load | 4,820 ms | **1,298 ms** |
| Native booleans: main / worker | 83 / 0 | **0 / 83** |
| Longest worker boolean | — | **4,749 ms** |
| Plate unchanged entry/exit | 317 ms | **384 ms** |
| RibBox1 unchanged entry/exit | 748 ms | **482 ms** |
| Final sketch unchanged entry/exit | 347 ms | **784 ms** |
| Main OCCT capacity after load | 256 MiB | **531 MiB** |
| Main OCCT capacity after named sessions | 256 MiB | **731.25 MiB** |

This is a **responsiveness improvement with elapsed-time and main-memory regressions**: roughly 2.27×
the pre-worker cold-open time, while the maximum main-loop gap is about 73% lower. Individual observations
on a shared machine are not statistical speedup estimates; a 1.298-second gap is still visible blocking.

There are **86 unchanged sessions** (three named plus all 83 sketches), all with zero main/worker booleans,
zero feature misses, and unchanged feature JSON, sketch payloads/refPositions and visibility. Cross-version
payload/visibility checks against pristine BEFORE also pass. The **ten additional repeated plate cycles
were not run** in this artifact. All-sketch elapsed times range 245–794 ms across the full session set.
The two hidden GeometryNodes have placeholders but no built visual or native mesh after load.

## Telemetry reconciliation and time budget

The current `aggregateProfileRealms` independently reprocessed all **87 captures**, agreeing with the
stored native counts. Both capture boundaries drain requests/native work; counters are monotonic, no
events were dropped, no application errors/write attempts were recorded. Worker events are consumed by
`KernelWorkerClient` before resolving replies, including replies to cancelled callers; FIFO drain barriers
cover native work that outlives its caller. Source/runtime main counters agree. No native event is counted twice.

Cold source timings (inclusive where noted):

| Stage | Count | Total |
|---|---:|---:|
| Worker tracked native booleans (includes native history completion) | 83 | **34,256 ms** |
| Worker JS history-vector conversion | 83 | 272 ms |
| Worker final mesh, native / JS buffers | 1 / 1 | 560 / 19 ms |
| Worker RPC, **inclusive** of native work and transport/replica work | 83 | **62,265 ms** |
| Main scheduler batches, **inclusive** of preparation/continuations | 168 | **35,574 ms** |
| Main meshing, native / JS buffers | 1,473 / 1,473 | 960 / 49 ms |
| Actual profile construction | 83 | 637 ms |
| Whole chain, **inclusive** | 1 | 98,305 ms |

Do not add the native durations to RPC/feature/chain durations. The RPC-minus-instrumented-worker-stages
residual is **27,158 ms** (`62,265 - 34,256 - 272 - 560 - 19`). It includes worker input BREP parsing,
graph validation, output descriptor/BREP work, startup, copying/queueing and scheduling; it is **not a measured
graph-only or network-only duration**. Main batches add substantial synchronous preparation/continuation
work. Separate graph/export/import/history-completion spans are absent, so exact attribution is still missing.

Code inspection explains likely major costs: each of 83 operations captures a growing input graph,
deep-copies/cleans/exports it, imports and validates operands in the worker, captures/exports the result,
then imports/verifies that result and re-imports input replicas on main for tracking. Keeping whole-prefix
replicas loses much of the native topology sharing of an in-realm chain. This is a hypothesis supported by
the boundaries and residuals, not an invented stage measurement.

## Independent geometry check and explicit regression policy

Raw and cleaned cold BREP bytes **do not match pristine BEFORE**. Copy/read can change representation and
last-bit analytic reconstruction. Within this worker run, cold/post-cycle raw and cleaned BREPs match.

The audit loaded only the retained baseline/worker BREPs into a bare Firefox OCCT module—**no application,
model load, sketch editing or original-file writes**. Its new `ordered-bfs-v1` checker does not call/import
the application's `replicaTopology` or `sameReplicaTopology`. It uses breadth-first direct-child traversal,
exact canonical graph adjacency/types/orientations and ordered face/edge/vertex identity arrays; independent
world vertices, five curve samples per edge, face bounds and whole-body volume anchor that graph.

- Both cold and post-cycle probes match the baseline ordered graph and **exact bounds**.
- Maximum numeric anchor delta: **1.8118839761882555e-13** (limit `1e-9 + 32*epsilon*scale`).
- Independently recomputed detached volumes match with delta **0** (absolute limit `1e-6 mm³`).
- Counts: **1,232 faces / 3,448 edges / 2,255 vertices**. Recorded live worker volume is
  `22330.46097003607 mm³`, versus the original live baseline `22330.460970036078 mm³`.

The opt-in regression now permits this graph/anchor/bounds/mass criterion **only with explicit
`--kernel-mode hybrid`**. It requires actual retained independent probes, not a claimed boolean or counts
alone. Main/auto/worker modes retain strict pristine cleaned-BREP equality, and all modes still require
unchanged-cycle cleaned-BREP equality. This documents the approved hybrid alternative; it does **not**
claim the literal byte-identity ticket criterion or an exhaustive proof of every analytic surface parameter.

## Missing gates and targeted next step

1. **Final-source full run plus ten repeated plate cycles:** this observation predates later hardening and
   lacks the ten-cycle scenario. Run the updated opt-in test once the final snapshot is ready.
2. **Worker and live memory:** main capacity rises 531 → 627.4375 → 731.25 MiB over the named sessions and
   then stays at 731.25 MiB across all 83 sketches. Worker heap is **not exposed** in the profile bridge;
   JS heap/GC and live native allocation accounting are unavailable. No total-memory or leak-freedom claim.
3. **Opt-in overhead contract:** inspected `WorkerKernel.measure()` unconditionally calls `performance.now`
   and allocates events, even with page profiling disabled. Native timing/event emission needs a propagated
   capture flag; lifecycle/native accounting should remain correct. No app code was changed by this audit.
4. **Input proof:** the owner's separate browser smoke records a real click and frames during the first
   operation; this artifact records timer gaps, not click/paint latency. Keep those evidence types distinct.

First add narrowly scoped `replica.captureGraph`, `replica.copyCleanExport`, worker import/validate/export,
main import/validate/input-replica, and tracking-completion spans. Then **reuse the previously verified,
immutable worker result as the next left operand**, instead of re-exporting/re-importing the complete
growing body. Cache its descriptor by geometry revision; retain/release its handle explicitly across
cancellation and synchronous takeover. Preserve validation at actual realm boundaries rather than skipping
it. This targets repeated growing-input work and duplicate topology; verify whether it reduces the 27.158 s
RPC residual, the 35.574 s main batches and retained-prefix memory before attempting broader offload.

## Replay without a new full benchmark

```powershell
node scripts/compare-saved-model-profile.mjs docs/performance/before-firefox-final.json.gz docs/performance/worker-integrated-observation.json.gz --kernel-mode hybrid --repeat-cycles 0 --geometry-audit docs/performance/worker-integrated-observation.geometry.json.gz
node --test scripts/profile-realms.node-test.mjs scripts/profile-geometry.node-test.mjs
```

Both replay commands passed; **26 pure tests passed**. Strict pre-worker evidence comparison still passes.
The full opt-in application regression was adapted but deliberately not rerun during this audit.
