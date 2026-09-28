# Same-build main / opt-in hybrid pair

The owner's latest artifact is preserved **once, verbatim, as a 28,063-byte JSON**:
[`worker-opt-in-paired.json`](worker-opt-in-paired.json). No repeated full BREP/trace archives were added.
This is review-stage evidence, **not** the final benchmark after the pending fallback P1 and picking P1 fixes.

## Results

Firefox 155.0; one isolated application-plus-probe build, fresh browser contexts, same read-only model.
Main tested the real default with an empty deployment config; hybrid served
`{ "performance": { "geometryWorker": true } }` before startup.

| Measurement | Main scheduler | Opt-in hybrid |
|---|---:|---:|
| Cold open | **45,709 ms** | **98,816 ms** |
| Maximum main event-loop gap | 5,055 ms | **1,305 ms** |
| Native main / worker booleans | 83 / 0 | 0 / 83 |
| Longest native main / worker boolean | 5,013 / 0 ms | 0 / 4,998 ms |
| Main OCCT capacity, cold | 256 MiB | **628.3125 MiB** |
| Main OCCT capacity after 83 sketch sessions | 256 MiB | **725.5 MiB** |
| Resident prefix hits | 0 | **82** |

Hybrid is **2.16× slower** to open, while the largest event-loop gap is about **74% lower**. Memory excludes
the worker heap, JS and GPU; capacity is not live allocation. This supports keeping hybrid opt-in as an
explicit responsiveness/memory tradeoff, not claiming elapsed-time or memory improvement.

All 83 sketches ran in each mode. The probe asserts zero unchanged-session booleans/cache misses and
stable feature/sketch/visibility payloads and tracked IDs. Both report matching ordered topology and
volume within tolerance. The complete ordered face/edge ID hash is identical:
`066b5c62cf70c5ef1a8d39b1c7f30d187991502ee2d66342bacc045e331fca2b`.

Hybrid handled a real click during the first pending operation. Main's `inputDuringFirstOperation: false`
is not an input failure measurement: the runner does not issue that click in main mode. This artifact
retains aggregate stages and session times/capacity, not per-native events or BREP exports; it cannot be
independently replayed as raw cross-realm telemetry.

## Compared with the earlier observation

The earlier [worker observation](worker-integrated-observation.md) measured an always-enabled prototype
at 99,830 ms versus separately captured pre-worker 44,070 ms. The latest comparison uses **one build** and
tests deployment opt-in. Bounded single-use leases reduce new worker input imports/verifications from
166 to **84**, with 82 preceding outputs consumed natively. End-to-end hybrid time remains approximately
99 seconds; its cold main-memory capacity is higher because frozen local inputs now survive the await.

Remaining measured hybrid stages: `replica.capture` **17,335 ms**, `worker.replica.export` **14,315 ms**,
`replica.install` **19,671 ms**, native worker booleans **38,688 ms**. RPC is **54,507 ms inclusive**.
The artifact lists each source stage once. Capture/install are inside feature/batch spans; worker export
and native work are inside RPC. Do not add enclosing spans to their children. Graph verification,
serialization and retained complete prefix replicas remain targets; dropping verification is not acceptable.

## Provenance

- Original temp artifact: `worker-performance-5182df2d-22ce-437e-b1c3-7b831194c1a1.json`.
- Artifact SHA-256: `a8411bf0d2f3b418f643854d9f6a847c3ed601547119bfd84d6390b8bc6266a3`.
- Source SHA-256: `769747e6a3ddf252fe5d417b564cc1ad2b583b1107cf913d49eb89db8936a397`.
- Build SHA-256: `0cb12633ae51961cd06b603c4c6233811f24f184831e2074de0f81924b84ce39`.
- Baseline archive SHA-256: `3fd24c814519217c2df0bb7de08d8ab759d402b163c0254dc786046f732d198f`.
- Original model SHA-256: `9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569`.

The paired runner fingerprints package sources **and its browser probe**, unlike the shared harness's
source/package-manifest fingerprint. It asserts source/model hashes during both modes and compares their
tracked-ID hashes. `publish-worker-pair.mjs` checked the actual artifact, baseline hash, mode counts,
83 unique matching sketch names, topology/payload flags and tracked-ID equality before preserving it.

## Final validation after both P1 fixes

The shared harness now enables hybrid through an in-memory, same-origin GET `/deployment.json` response.
Main explicitly serves `geometryWorker: false`, overriding even a worker-enabled static config. No file
or browser setting is written. Evidence records the served config, request count and observed startup
config/provider mode; a mismatch fails before model load. Same-origin GET-only routing, autosave holds
and persistence/write-back blockers remain active. CLI and regression defaults are **main**.

Once both fixes are ready, build once and run against that same `dist`:

```powershell
npm run build
$env:SPICY3D_BENCHMARK_MODEL = "tickets/optimization/Mouse Bottom.spicy"
$env:SPICY3D_BENCHMARK_MODE = "main"
node --test scripts/profile-saved-model.node-test.mjs
$env:SPICY3D_BENCHMARK_MODE = "hybrid"
node --test scripts/profile-saved-model.node-test.mjs
```

Both cover named scenarios, ten repeats and all 83 sketches. Main retains strict pristine cleaned-BREP
equality; **only explicit hybrid mode** permits independent graph/anchors/bounds/volume validation.
Unchanged-cycle cleaned-BREP equality is still required in both. Rerun the paired tracked-ID/picking probe
after the fixes too. Remaining gaps: final fixed-source measurements, ten-repeat worker series, worker/live
memory accounting, and confirmation of both P1 regressions. No new full benchmark ran for this update.
HTTP configuration, geometry-policy and cross-realm telemetry tests: **32 passed**.
