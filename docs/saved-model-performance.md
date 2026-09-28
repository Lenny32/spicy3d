# Saved-model loading and sketch performance

## Final post-review pair

[Final validation after both P1 fixes](performance/final-paired.md) passed on **one unchanged build**:
**42.900 s main / 90.050 s hybrid**, with cold main-loop gaps **4.776 / 1.269 s**. Both modes completed all
five scenarios and all 83 sketches, including ten repeats: 96 unchanged sessions each, zero booleans/misses,
stable tracked IDs, explicit main strict-BREP / hybrid independent-geometry checks, picking verification,
and a real-worker cancelled-but-executed native drain. Source/build/model hashes stayed unchanged.
Timings are shared-machine observations; hybrid remains slower and uses more main-memory capacity.
The sections below preserve earlier observations and their then-current limitations.

## Worker profiling preparation

Latest: [same-build main / opt-in hybrid pair](performance/worker-opt-in-paired.md), **45.709 / 98.816 s**,
82 resident hits and matching complete tracked IDs. The small owner artifact is preserved once. The shared
harness now enables hybrid through its GET `/deployment.json` route, with main explicitly off by default.
Final full validation waits for the fallback P1 and picking P1 fixes; no fresh full benchmark ran for this update.

**The results below remain pre-worker evidence.** The worker owner's integrated run has now been audited;
see [the worker observation and bottleneck review](performance/worker-integrated-observation.md) for its
99.830-second cold load, improved responsiveness, increased main memory and independent geometry validation.
That captured snapshot predates later hardening and is not a fresh final-source benchmark. The harness
requires explicit kernel-mode and cross-realm accounting rather than treating main-thread WASM counts as global. See
[the worker telemetry handoff](performance-worker-telemetry.md) for exact bridge/protocol hooks and
the new fail-closed aggregation contract. Existing evidence artifacts are unchanged.

## Combined AFTER validation (opt-09)

**Passed in real Firefox 155.0**, using the combined working-tree production build (`--allow-dirty`).
Two completed runs each exercised cold-open, the three named sketches, ten additional unchanged plate
cycles, then **all 83 sketches individually**: 96 unchanged entry/exit sessions per run.
Every session recorded **zero downstream booleans, zero feature misses, unchanged complete feature JSON,
unchanged all-sketch data JSON (including refPositions), and unchanged visibility**. No application
exceptions, blocked write attempts, dropped source records or failed benchmark assertions occurred.
The separate immutable-evidence comparison also verified that both AFTER cold/post-cycle payloads and
visibility equal the **pristine BEFORE** payloads and visibility, not only their own post-load snapshots.

### Before / after

Milliseconds; AFTER uses the first combined run, with an independent regression rerun shown where useful.

| Scenario | BEFORE elapsed | AFTER elapsed | Booleans BEFORE → AFTER | Event-loop gap BEFORE → AFTER |
|---|---:|---:|---:|---:|
| Cold-open | 52,707 (other baseline 49,838) | 44,070 (rerun 44,793) | 83 → 83 | 52,610 → 4,820 |
| `Sk_Plate` unchanged | 52,093 | 317 | 83 → 0 | 51,883 → 133 |
| `Sk_RibBox1` unchanged | 34,912 | 748 (rerun 349) | 73 → 0 | 34,675 → 493 |
| Final `Sk_SwBlockSlit_B` unchanged | 930 | 347 | 1 → 0 | 595 → 244 |
| Ten further unchanged plate cycles | 43,649–48,141 each | 276–756 each (rerun 272–720) | 83 each → 0 | 42,751–47,985 → 123–519 |

Median repeated plate cycle: **308.5 ms** (regression rerun **287 ms**).

Cold-open is approximately **16.4% faster than the series baseline / 11.6% faster than the second baseline**;
maximum event-loop gap fell about **90.8%** against the series baseline. These are individual instrumented
observations, not confidence intervals. Machine load and GC account for some variation. AFTER also
captures the source hooks, so its instrumentation workload is greater than BEFORE's runtime-only capture.
The original timer/settling methodology is preserved, but asynchronous UI commands replace the old
fire-and-forget double-click publication: `EnterSketch.execute` awaits `SketchEditor.enterAsync`, then
the harness awaits `document.settled()`; `ExitSketch.execute` and another settled barrier finish restoration.

Cold mesh calls fell **3,356 → 1,474**. Source ownership records identify 248 construction meshes and one
body mesh; 1,225 are unclassified computational/profile meshes. To avoid relying on partial tags, the
regression rerun inspected the two actually hidden GeometryNodes after load: both had visual placeholders,
resolved shapes, **no built Three.js meshes and no kernel meshing**. Their IDs are retained in the summary.

### Geometry-only BREP equivalence resolved

The harness imports the preserved pristine cold BREP and the AFTER cold/post-cycle BREPs into **separate
detached OCCT shapes**, calls the existing `wasm.Shape.clean` (`BRepTools::Clean(shape, true)`) on each,
then exports them and disposes the detached shapes. This runs **after** all measured scenarios; it never
cleans or modifies a shape in the open document. This removes triangulation caches, not analytic geometry.

All three geometry-only exports are **byte-identical**, in both AFTER runs, SHA-256:

`d037f19781e01dfb042d0dc5ec61b5dc2db0ee75ee687deb535205bfe256f19b`

Face/edge/vertex counts remain **1,232 / 3,448 / 2,255**, and the geometry-only bounds match the exact
BEFORE coordinates documented below. AFTER volume is unchanged at **22,330.460970036078 mm³**.
Raw BREP bytes still differ as triangulations accumulate (cold 11,676 polygon-on-triangulation entries,
post-96-sessions 21,857); the raw-byte ticket criterion is not silently claimed. The preserved raw exports
and cleaned exports demonstrate that these runs' underlying geometry is identical.

### Memory, profile cache and remaining responsiveness limit

- OCCT WASM capacity stayed **268,435,456 bytes (256 MiB)** through cold load, ten repeats and all 83
  sketches in both AFTER runs. PlaneGCS stayed at **16,777,216 bytes**. BEFORE's series grew to
  861,339,648 bytes. Capacity stability is encouraging but is **not** a live-allocation leak check:
  retained triangulations still grow, and Firefox offers no JS heap/forced-GC accounting here.
- Cold load records **83 actual profile builds, 166 queries, 83 hits**. The regression verifies that
  completed cache-hit queries have no profile build. Unchanged session exit intentionally invalidates
  display profiles via `showProfileFaces` and normally rebuilds that sketch's display profiles once;
  this remaining work is explicitly visible, with no downstream feature miss or boolean.
- The generator chain is measured through source **`body.rebuild`, `body.batch`, `body.feature`** records.
  Cold: one 42,076 ms inclusive rebuild, 85 batches (max 4,813 ms), 84 feature misses. Legacy runtime
  `featureHits`/`featureMisses` summary fields are zero because that old method no longer exists; use
  `sourceFeatureHits`/`sourceFeatureMisses` for AFTER. Runtime booleans are counted independently and
  agree with the source counters; the two sets are never added together.
- **opt-08 gate confirmed after opt-07:** feature index 1 (`booleanFuseTracked`, SkirtWall) still takes
  **4,777 ms** in a single native call (rerun **4,918 ms**). The largest event-loop gap is 4,820 ms
  (rerun 4,961 ms). Scheduling substantially reduces aggregate blocking but cannot interrupt this call.
  Worker-owned evaluation is justified by the measured remaining single-call block. No worker code is
  implemented or validated by this report.

### Evidence and reproducible regression

- [`after-firefox-combined.json`](performance/after-firefox-combined.json) /
  [`full evidence`](performance/after-firefox-combined.json.gz).
- [`after-firefox-regression.json`](performance/after-firefox-regression.json) /
  [`full evidence`](performance/after-firefox-regression.json.gz): fresh 91.7-second real-browser test,
  including direct hidden-mesh checks and assertions over every source profile-cache query.
- Both used the exact same built distribution SHA-256:
  `286dbede7356a74f2cd50aae107fe45c4eca81b54cdd2e499b36845c944b1245`.
  The harness fingerprints package sources (including untracked new modules), the built distribution,
  and itself. Package sources remained unchanged during each run. Source manifests differ between runs
  (generated capability metadata was refreshed between them); the executable distribution did not.
- Original model hash is unchanged in both AFTER runs, matching the BEFORE hash below. Persistence,
  downloads and file writes remained blocked. Neither the benchmark nor regression test saves the model.
- `npm run build` passed (bundle-size warnings only); targeted Biome checks passed. Full application
  tests and synthetic-edit/undo coverage are tracked separately by the synthetic-regression owner.

```powershell
# Use the existing verified temp parent. Requires a current npm run build and Playwright Firefox.
# The .node-test.mjs entry is opt-in and stays outside normal Rstest discovery.
$env:SPICY3D_BENCHMARK_MODEL = "tickets/optimization/Mouse Bottom.spicy"
node --test scripts/profile-saved-model.node-test.mjs
# Recheck cross-version payload/geometry evidence without rerunning the browser:
node scripts/compare-saved-model-profile.mjs docs/performance/before-firefox-final.json.gz docs/performance/after-firefox-regression.json.gz
```

This is an opt-in integration test; it skips when `SPICY3D_BENCHMARK_MODEL` is absent, reads that file
directly without duplicating it into fixtures, creates only a new temp evidence file, and retains it on
failure. Assertions cover all 83 sketches, cold boolean count 83, unchanged-session booleans/misses zero,
hidden meshes, profile hits, topology, exact bounds, cleaned BREP identity, source stability and file hashes.
It deliberately has no hardware-sensitive wall-clock threshold or capacity-equals-live-bytes assertion.

## BEFORE evidence (opt-01 / opt-09)

Measured on 2026-09-28 in **Firefox 155.0, headless**, Windows 10.0.26200,
Intel Core i9-10900K (20 logical CPUs), 68,412,256,256 bytes system RAM, Node 24.12.0.
These are instrumented wall-clock observations on a shared development machine, not statistically
controlled speedup estimates. Other agents were working concurrently, but **the benchmark source was
version-isolated** and never included their optimizations.

### Provenance and read-only controls

- Detached worktree: `C:\Users\lcormi\AppData\Local\Temp\opencode\spicy3d-opt-before`.
- Revision: `bf111c777bb2aa4d266146a51372a6d6081f7b4e`.
- Independent `npm ci --ignore-scripts` and `npm run build`; no source patches. The build passed with
  bundle-size warnings. Runtime wrappers instrument the pristine browser build without changing its source.
- Original model SHA-256, verified before/after **both completed runs**:
  `9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569`.
- No document persistence or file write-back: autosave held, failing memory repository, local repository
  saves blocked, IndexedDB writes blocked, downloads/file writers blocked, fresh browser context,
  same-origin GET requests only. Both completed runs recorded **zero write attempts and zero page errors**.
- Source diff was empty before/after. Application startup and HTTP transfer of input bytes are outside
  cold-open timing; gzip/JSON decoding, migration, document creation, evaluation, display and settling
  are inside. Each scenario includes a 50 ms settling delay and two animation frames; sketch cycles also
  settle between entry and exit. Raw records preserve narrower stage durations.

Full evidence (records, BREP strings, feature/sketch JSON, visibility) and readable summaries:

- [`performance/before-firefox-series.json`](performance/before-firefox-series.json)
  and [`before-firefox-series.json.gz`](performance/before-firefox-series.json.gz).
- [`performance/before-firefox-final.json`](performance/before-firefox-final.json)
  and [`before-firefox-final.json.gz`](performance/before-firefox-final.json.gz).

An initial 120-second shell run timed out after cold-open and `Sk_Plate`; its partial console timings
are not used below. The completed series initially selected the last sketch in **tree order**,
`Sk_RibBox3` (71 booleans), rather than the last feature's sketch. The final-only run corrects that
coverage using **`Sk_SwBlockSlit_B`, feature index 83**, and the harness now selects by feature order.

### All five benchmark scenarios

Times in milliseconds. Boolean counts refer to actual raw OCCT fuse/cut/common invocations, including
tracked calls. Event-loop gap is the largest interval between 10 ms timer callbacks; it is a measured
responsiveness proxy, **not** a browser Long Tasks duration.

| Scenario | Elapsed | Booleans | Boolean total | Longest boolean | Maximum event-loop gap | Mesh calls |
|---|---:|---:|---:|---:|---:|---:|
| Cold-open, series run | 52,707 | 83 | 42,760 | 5,719 | 52,610 | 3,356 |
| `Sk_Plate` unchanged entry/exit | 52,093 | 83 | 44,392 | 5,487 | 51,883 | 2,118 |
| `Sk_RibBox1` unchanged entry/exit | 34,912 | 73 | 29,087 | 979 | 34,675 | 1,347 |
| Final sketch `Sk_SwBlockSlit_B`, fresh final-only run | 930 | 1 | 337 | 337 | 595 | 16 |
| Ten further unchanged `Sk_Plate` cycles | 43,649–48,141 per cycle | 83 each | 36,656–41,255 | 4,514–5,756 | 42,751–47,985 | 2,118 each |

The final-only run independently measured cold-open at 49,838 ms, 83 booleans, longest boolean 4,898 ms,
event-loop gap 47,098 ms. Both cold loads produced the same initial BREP hash and topology.

### Stage evidence and its interpretation

Final-only cold load: decode 81 ms, migration 2 ms, 336 node constructions 235 ms;
84 feature misses / zero hits, chain 44,742 ms; boolean calls 38,722 ms;
336 visual creations 46,367 ms **inclusive of the lazy chain evaluation they trigger**.
The series `Sk_Plate` cycle recorded four chain passes, 84 hits and 84 misses; the final sketch
recorded four passes, 333 hits and one miss. Stage totals overlap and must not be summed.

The final-only harness additionally times OCCT Mesher construction (3,356 calls, 1,467 ms) separately
from `Mesher.mesh()` (3,356 calls, 183 ms). The first series did not time construction, so its
`mesh.kernel` duration alone is **not** total meshing time. The source hook measures both together.
Baseline `profile.kernelRegions` measures only `facesFromEdges` (six calls, 43 ms in final-only cold
load), not all JS profile construction. Pristine decode is aggregate gzip + JSON; the new source hooks
separate those stages.

Runtime mesh classification in the raw baseline is **calling visual context**, not exact shape ownership:
1,362 calls while constructing visible construction visuals, two while constructing hidden ones,
1,992 while constructing the body visual (which includes intermediate computational bounds meshes).
Entry/exit calls outside visual creation are unclassified. Do not interpret 1,992 as final-body mesh
count or use this classification to assert “no hidden meshing.” Exact per-shape ownership needs the
ThreeGeometry owner hook described below.

### Memory trend

OCCT WASM memory **capacity**, bytes (the larger exported WebAssembly memory):

| Checkpoint | Capacity |
|---|---:|
| Post-load | 268,435,456 |
| First `Sk_Plate` | 322,174,976 |
| `Sk_RibBox1` | 322,174,976 |
| Additional `Sk_RibBox3` | 386,662,400 |
| Repeat cycles 1–2 | 463,994,880 |
| Repeat cycles 3–4 | 556,793,856 |
| Repeat cycles 5–7 | 658,374,656 |
| Repeat cycles 8–9 | 759,103,488 |
| Repeat cycle 10 | 861,339,648 |

PlaneGCS's separate WASM memory stayed at 16,777,216 bytes. Firefox exposes neither
`performance.memory` nor Long Tasks in this environment; those are recorded as unavailable, not zero.
WASM memory does not shrink after frees, and no forced GC/live-allocation accounting was available.
Capacity growth is a real trend requiring investigation, **not proof of a live allocation leak**.

### Geometry/reference baseline for opt-09

- Final body: **1,232 faces, 3,448 edges, 2,255 vertices**, using `findSubShapes` counts.
- Geometry-only OCCT bounds (`useTriangulation=false`):
  min `(-48.390005, -61.970005, 0.3999949999999998)`,
  max `(48.800005, 62.030005, 16.500005)`.
- Cold BREP SHA-256 in both runs:
  `b805d49baffe59a613641c31d75afeefcfcb2feba7fe635dfd0f26b46941562c`.
- Topology counts, bounds, complete feature JSON, all 83 sketch data JSON records (including
  `refPositions`), and all visibility flags matched after each completed run's selected cycles.
  No cold-load feature errors. This is not coverage of opening all 83 sketches or synthetic edits.
- **Raw BREP byte identity already fails on pristine unchanged cycles.** Final-only after hash:
  `a5ba923fff810aafe1c18749c73a18b291d147bc0ad2a4199155912f5b1ba397`.
  First changed line is 13,542: `PolygonOnTriangulations 11676` → `PolygonOnTriangulations 11730`.
  Raw exports include triangulation state, which deferred meshing also changes. Both complete exports
  are retained. Opt-09 must investigate/use a geometry-only canonical comparison in addition to raw
  bytes; do not claim byte equivalence or silently weaken its acceptance gate.

### opt-08 gate

The longest call is **`booleanFuseTracked` at feature index 1** (SkirtWall fuse): 4,898–5,719 ms on
the two completed cold loads; repeated unchanged plate cycles still spend 4,514–5,756 ms in that one
call. This is one synchronous native call including native history completion. Yielding **between**
features cannot interrupt it. The opt-01 measurement prerequisite for investigating worker ownership
is satisfied. Confirm post-opt-07 responsiveness and the remaining longest-call duration before
implementing opt-08; these BEFORE numbers do not constitute post-scheduler validation.

## Opt-in source instrumentation API

Exported by `@spicy3d/core` and available as `Spicy3DCore.PerformanceTrace` in the browser:

```ts
PerformanceTrace.enable(); // fresh capture, default bounded to 100,000 records
// Run the operation.
PerformanceTrace.disable();
const { records, dropped } = PerformanceTrace.snapshot();
```

Records are `{ stage, started, durationMs, details? }`, times from `performance.now()` in milliseconds.
Metadata contains scalar IDs, categories and counters only; never put model payloads or names in it.
No initialization clock reads, automatic timers, observers, storage, or console logging. Disabled
call sites use a boolean gate before clocks **and metadata allocation**:

```ts
const span = PerformanceTrace.enabled
    ? PerformanceTrace.begin("feature.step", { nodeId: this.id, featureIndex, featureType })
    : undefined;
try {
    // Existing operation; no profiling callback closure.
} finally {
    if (PerformanceTrace.enabled) PerformanceTrace.end(span, { cacheHit });
}
```

Explicit tokens tolerate async interleaving and ignore completions from earlier capture generations.
`record(stage, started, durationMs, details?)` accepts externally observed events, for example memory
samples or event-loop gaps; guard before collecting them. `dropped > 0` means incomplete evidence.
This is minimal boolean overhead when disabled, not a claim that added branches cost literally zero CPU.

### Hooks implemented by opt-01

| Location | Stages |
|---|---|
| `core/src/documentFile.ts` | `document.decode`, `document.decompress`, `document.parse` |
| `app/src/document.ts` (minimal additions alongside scheduler work) | `document.migrate`, `document.load` |
| `core/src/model/node.ts`, `modelManager.ts` | `node.deserialize` (node id/type), `model.deserialize` (count; excludes visual notification) |
| `wasm/src/factory.ts` | `kernel.operation` (`operation`, `boolean`, `tracked`), `kernel.historyConversion` |
| `wasm/src/shape.ts`, Mesher section | `mesh.kernel` (constructor + kernel mesh), `mesh.buffers` |

Native history completion is inside the tracked OCCT call; only JS history-array conversion is
separately measurable without changing the C++ API. Factory hooks cover common single-shape helpers
and tracked operations, including every feature-chain boolean, rather than claiming all kernel APIs.

### Source-hook owner integration (now completed)

These hooks were integrated by the assigned owners and exercised by the combined AFTER run:

1. **ParametricBodyNode / rebuildJob owner:** `body.rebuild` with node/trigger/outcome metadata,
   `body.batch` for uninterrupted scheduler batches and `body.feature` with `{ nodeId, index, type, cacheHit }`
   on both hits and misses. The harness wraps only synchronous `evaluateAndCache` for raw kernel attribution;
   it does not time generator construction or introduce a global async context stack.
2. **profileBuilder owner:** `profile.build` around actual construction on misses; `profile.query`
   on every cache lookup, with `{ nodeId, cacheHit }`. Count builds separately from hits and keep
   profiling out of cache keys and persisted data.
3. **ThreeVisualContext owner:** `visual.create` around `displayNode`, with
   `{ nodeId, nodeType, visible }`. This is inclusive of lazy evaluation; document that in consumers.
4. **ThreeGeometry owner:** immediately before mesh access, tag the already-resolved shape, without
   forcing an extra shape evaluation:

   ```ts
   if (PerformanceTrace.enabled) {
       PerformanceTrace.tagShape(shape, {
           nodeId: node.id,
           meshKind: "body", // or "construction"; determine from the owning node
           visible: effectivelyVisible,
       });
   }
   ```

   Mesher merges `shapeDetails(shape)` into `mesh.kernel` records, defaulting to `unclassified`.
   Tags are weak and capture-local; re-tag shapes for each visual access. Shared shapes require the
   caller's current ownership context. Intermediate computational meshes should stay unclassified
   or explicitly tagged `computational`, never guessed to be final-body meshes.

All seven source-hook stages now produce structured data; baseline runtime records remain separately
labelled, including the historical limitations described above.

## Reproduction and AFTER validation

```powershell
# Parent must exist before worktree creation. Use a NEW path if this worktree already exists.
Test-Path -LiteralPath "C:\Users\lcormi\AppData\Local\Temp\opencode"
git worktree add --detach "C:\Users\lcormi\AppData\Local\Temp\opencode\spicy3d-opt-before" bf111c777bb2aa4d266146a51372a6d6081f7b4e
# In that worktree, run npm ci --ignore-scripts, then npm run build.
npx playwright install firefox
node scripts/profile-saved-model.mjs --source "C:\Users\lcormi\AppData\Local\Temp\opencode\spicy3d-opt-before" --model "tickets/optimization/Mouse Bottom.spicy" --output "C:\Users\lcormi\AppData\Local\Temp\opencode\new-before.json"
node scripts/summarize-saved-model-profile.mjs "C:\Users\lcormi\AppData\Local\Temp\opencode\new-before.json"
```

Allow roughly 12 minutes and a tool timeout of at least 1,200,000 ms for the full BEFORE series.
`--sketch Sk_SwBlockSlit_B --cycles 0` runs a fresh cold load plus only the final sketch.
`--browser chromium` is available but changes the comparison environment. `--headed` changes rendering
conditions. Output must be a new `.json`; the summarizer optionally takes a **new output prefix** to
publish `.json` summaries and gzip-compressed full evidence.

For AFTER, build a stable review snapshot and use that checkout as `--source`; `--allow-dirty` is an
explicit option for an uncommitted snapshot and records its diff digest. The harness awaits
`document.settled()` so scheduled rebuilds are included. The source `PerformanceTrace` is captured
separately from the unchanged runtime wrappers; never add both sets' counters together.

Remaining validation outside this report: synthetic edits/undo/redo and full application tests (separate
owner), and live-allocation leak analysis. Raw triangulation-bearing BREP byte identity does not hold,
while the detached geometry-only exports match exactly. No benchmark run here edits the saved model.

## Targeted validation

- Core/app: `performanceTrace`, `documentFile`, `modelManager`, `document`: **118 tests passed**.
- WASM: `performanceTrace`, `factory`: **123 tests passed**. New real-kernel tests check one boolean
  yields one operation record plus history conversion, mesh ownership/counts, and zero disabled clock reads.
- TypeScript `tsc --noEmit` passed after fixing the new tests' index-signature accesses.
- Targeted Biome checks applied formatting; existing informational/style warnings were not rewritten.
