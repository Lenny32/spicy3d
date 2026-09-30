# Final same-build Firefox validation after both P1 fixes

**Both full regressions passed.** One fresh `npm run build` was used for main and opt-in hybrid, in separate
Firefox 155.0 contexts. Each ran cold-open, three named unchanged sketches, **ten additional plate cycles**,
then **all 83 sketches**: 96 unchanged sessions per mode, 192 total. No application source was edited by
the benchmark. An independent full test suite was running concurrently on this shared Windows/i9 machine;
these are instrumented observations, not isolated performance estimates or confidence intervals.

## Measurements

| Scenario / metric | Main scheduler | Opt-in hybrid |
|---|---:|---:|
| Cold-open | **42,900 ms** | **90,050 ms** |
| `Sk_Plate` unchanged | 298 ms | 446 ms |
| `Sk_RibBox1` unchanged | 374 ms | 528 ms |
| Final `Sk_SwBlockSlit_B` unchanged | 359 ms | 966 ms |
| Ten repeated plate cycles: min / median / max | 263 / **302** / 721 ms | 284 / **312.5** / 723 ms |
| Cold native booleans, main / worker | **83 / 0** | **0 / 83** |
| Every unchanged session, booleans / feature misses | **0 / 0** | **0 / 0** |
| Cold maximum main-loop gap | **4,776 ms** | **1,269 ms** |
| Longest cold native boolean | 4,729 ms on main | 4,681 ms in worker |
| Main OCCT capacity, cold | 256 MiB | 628.3125 MiB |
| Main OCCT capacity through repeats / all sketches | 256 MiB | 726.5 MiB |

Hybrid reduces the largest observed main-loop gap by about **73.4%**, but cold-open takes about **2.10×**
as long and main memory capacity is higher. The worker remains an explicit responsiveness/memory tradeoff.
Main's capacity stayed at 268,435,456 bytes throughout. Hybrid rose from 658,833,408 to 761,790,464 bytes
at the final named-sketch session, then stayed there through ten repeats and all 83 sketches. PlaneGCS
stayed at 16,777,216 bytes. **Worker heap, JS/GPU memory and live native allocations are unmeasured**:
the available worker `stats` API exposes handle count, not memory. Capacity stability is not leak freedom.

## Correctness criteria—kept explicit

- **Main:** pristine cleaned BREP byte identity passed; unchanged-cycle cleaned byte identity passed.
- **Hybrid:** pristine BREP byte identity is **false**, as expected for copy/read replicas. The separately
  implemented `ordered-bfs-v1` probe passed exact graph adjacency/types/orientations, ordered topology
  arrays, **exact bounds**, geometry anchors and independent volume. Maximum anchor delta was
  **1.5276668818842154e-13**, against `1e-9 + 32*epsilon*scale`; detached volume delta was **0**, against
  `1e-6 mm³`. Unchanged-cycle cleaned BREP byte identity also passed. This explicitly approved hybrid
  criterion is not presented as pristine byte identity or proof of every analytic surface parameter.
- Both: **1,232 faces / 3,448 edges / 2,255 vertices**. Bounds remain min
  `(-48.390005, -61.970005, 0.3999949999999998)`, max `(48.800005, 62.030005, 16.500005)`.
  Live volumes remain `22330.460970036078` main and `22330.46097003607` hybrid, unchanged through sessions.
- Full feature JSON, all sketch payloads/refPositions and visibility match pristine BEFORE and stay
  unchanged after **each** session. Every session also checks complete ordered face/edge tracked IDs.
  Both modes share hash `066b5c62cf70c5ef1a8d39b1c7f30d187991502ee2d66342bacc045e331fca2b`.
- Both hidden GeometryNodes retain placeholders without visual/native meshes at cold load.
- Same-build browser checks verify all **1,232 face and 3,448 edge pick ranges** against analytic
  subshapes and inverse mesh/topology mapping, cold and after all sessions. These actual model maps happen
  to be identity maps. The separate real-kernel Three.js tests deliberately reorder ranges and omit a face:
  ray-pick → fillet ID, highlight/preselection → press-pull ID, and topology-driven reselection all pass.

## Profiling token and cancellation verification

Every one of the 194 scenario captures reconciles page runtime counters with source/worker-native events.
Both boundaries are drained, every worker capture remains complete, and no events were dropped. Profiling
stays enabled through terminal worker delivery and the final snapshot; counters retain profiled totals
between captures, following the current `PerformanceTrace.captureId` contract. No reset masks late work.

After the hybrid model scenarios and geometry checks, a **separate synthetic real-worker fuse** is cancelled
20 ms after dispatch. The caller settles with `pendingRequests=0`, **`pendingNative=1`**, and the result is
not consumable. The drain then receives the actual **857 ms native boolean** and its history event, ending
with **both pending counts zero**, complete telemetry and no loss. This probe takes 1,023 ms overall and
is excluded from the model's 83 cold booleans and unchanged-session timings. Its early RPC span is 21 ms;
this demonstrates why cancelled RPC duration is not native duration. It never edits the benchmark document.

## Remaining elapsed-time cost

Hybrid recorded **82 resident prefix hits**. Detailed cold stages now locate the costs:

| Stage | Count | Total ms |
|---|---:|---:|
| Native worker booleans (includes native history completion) | 83 | 35,557 |
| Main replica copy | 166 | 1,788 |
| Main copied-input verification | 166 | **8,159** |
| Main output verification | 83 | **8,171** |
| Main output import | 83 | 4,155 |
| Main retained-result BREP export | 82 | **5,420** |
| Main resident-version BREP export | 82 | **5,362** |
| Worker replica export | 83 | **13,021** |
| Worker new-input import / verification | 84 / 84 | 112 / 161 |
| Worker final native mesh / JS buffer conversion | 1 / 1 | 558 / 11 |

Inclusive parents: `replica.capture` 15,545 ms, `replica.install` 17,780 ms, worker RPC 49,971 ms,
main scheduler batches 38,065 ms, whole chain 88,518 ms. **Do not add parents to their children or source
timings to runtime wrappers.** Resident reuse eliminates most worker input conversion, but repeated local
verification, version/retention writes and complete-prefix output materialization still dominate overhead.

## Build provenance and artifacts

- [Compact paired summary](final-paired.json).
- Original raw captures preserved **once each**: [main](final-paired-main.json.gz),
  [hybrid](final-paired-hybrid.json.gz). These retain timing records, snapshots, geometry proofs, capture
  boundaries and the synthetic cancellation record; no duplicate full summary archives were produced.
- Base HEAD `7b0b384d990d16755846e094f18bae94235cef9c` plus the reviewed working-tree changes.
- Package-source SHA before build, after build and after both runs:
  `31570b914ba7231be5baa443dbd11b76758ebb58092e40d0787ce79a876c040c`.
- Root build-input/native-artifact digest before/after:
  `211a16580b3afba65ae635229e04c05e76ae29f85006a447dff83a273dc49c0f`.
- **Same distribution SHA for both modes**, rechecked after each:
  `50dbc88e36bddfdd1eabf9981e9af414c5da73c3ff293d80a4df91b7e3aa7fe0`.
- Original model SHA before/after build/run:
  `9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569`.

The server served `performance.geometryWorker=false` for main, `true` for hybrid before startup; both
observed configurations matched. Original-file write-back, downloads, document persistence and unsafe or
foreign-origin requests remained blocked. Both runs recorded **zero page errors and zero write attempts**.

## Checks and reproducibility

- `npm run build`: passed (application and plugins; bundle-size warnings only).
- Both full Firefox opt-in regressions: passed, plus same-build/source/hash/ID cross-mode assertions.
- **32 targeted Rstest tests passed**: picking (3), hybrid factory (10), worker profiling (6),
  hybrid rebuild (13). The latter includes persistent rejection/trap quarantine after unrelated edits,
  rollback retries and synchronous demands—the fallback P1—and healthy-prefix synchronous takeover.
- Full-suite results are maintained by the other agent; this report does not claim that suite's outcome.

```powershell
Test-Path -LiteralPath "C:\Users\lcormi\AppData\Local\Temp\opencode"
node scripts/run-final-profile-pair.mjs "tickets/optimization/Mouse Bottom.spicy" "C:\Users\lcormi\AppData\Local\Temp\opencode"
```

The driver builds once, checks fingerprints, runs main then hybrid, and retains new temp evidence even on
failure. The elapsed sample size remains one pair; no hardware-sensitive threshold or live-leak assertion
is hidden in the tests. A 1.269-second main-loop gap still exists; worker-only ownership/all-kernel offload,
worker/live-memory accounting, and representative repeated latency distributions remain outside this validation.
