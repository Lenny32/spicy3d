# Optimization: saved-model loading and sketch closing

## Current delivery status

Delivered for review in [PR #62](https://github.com/Lenny32/spicy3d/pull/62) (**open**): opt-01–07 and
opt-09 are shipped in the review build; opt-08 is integrated as the approved **opt-in hybrid deviation**.
This is delivery status, not blanket signoff on the original acceptance checklists.

| Ticket | Status | Delivered outcome / evidence |
|---|---|---|
| [opt-01](opt-01-performance-baseline.md) | Shipped; in review | Pristine baseline and opt-in profiling; all 194 final scenario captures reconcile runtime/source/worker counters without dropped events. |
| [opt-02](opt-02-preserve-rollback-cache.md) | Shipped; in review | Full rollback cache retained; every unchanged session across all 83 sketches has zero downstream booleans and zero feature misses. |
| [opt-03](opt-03-display-invalidation.md) | Shipped; in review | Display invalidation separated from geometry changes; unchanged sessions preserve feature/sketch payloads and visibility. |
| [opt-04](opt-04-geometry-only-bounds.md) | Shipped; in review | Geometry-only bounds avoid render meshing; final bounds match pristine exactly in both modes. |
| [opt-05](opt-05-sketch-profile-cache.md) | Shipped; in review | Shared profile cache; combined main run recorded 83 builds / 166 queries / 83 hits, with no build on completed cache hits. |
| [opt-06](opt-06-deferred-meshing.md) | Shipped; in review | Both actually hidden GeometryNodes retain placeholders without visual/native meshes at cold load. |
| [opt-07](opt-07-responsive-rebuilds.md) | Shipped; in review; default | Between-feature scheduling; latest main cold-open 42.900 s, maximum main-loop gap 4.776 s. A native call still blocks. |
| [opt-08](opt-08-worker-evaluation.md) | Approved hybrid deviation integrated; opt-in | All 83 cold booleans offloaded on this model; 90.050 s cold-open, 1.269 s maximum main-loop gap, higher memory capacity. Original worker-only scope remains incomplete. |
| [opt-09](opt-09-regression-validation.md) | Shipped; in review | Both final Firefox regressions passed: 96 unchanged sessions per mode, tracked IDs, picking, geometry/payload checks and separate real-worker cancellation verification. Acceptance limits below still apply. |

### Measured outcomes and acceptance limits

- **Default main:** 42.900 s cold-open versus the pristine series baseline's 52.707 s (~18.6% faster).
  **Opt-in hybrid:** 90.050 s (~2.10× slower than current main), but maximum main-loop gap drops from
  **4.776 s to 1.269 s** (~73.4%). This is a responsiveness tradeoff, not an elapsed-time win or a
  guarantee of uninterrupted input/repaint. These are instrumented shared-machine observations; the
  final pair ran alongside a full test suite, not as an isolated latency distribution.
- Both modes exercised three named sketches, ten additional plate cycles and **all 83 sketches**:
  **96 unchanged sessions each, every one with zero downstream booleans and zero feature misses**.
  Feature JSON, sketch payloads/refPositions, visibility and complete ordered tracked IDs stay unchanged.
- **BREP criterion:** main passes exact **triangulation-cleaned** pristine BREP byte equality. Hybrid
  does **not** match pristine BREP bytes; the approved criterion is independently checked ordered
  topology/geometry correspondence (exact graph/types/orientations and bounds, geometry anchors within
  tolerance, independent volume). It is not proof of every analytic surface parameter. Both modes pass
  cleaned BREP equality across their own unchanged cycles; raw pristine byte equality is not claimed.
- **Memory:** main OCCT capacity stays at **256 MiB**; hybrid grows from **628.3125 MiB cold to
  726.5 MiB**, then plateaus through repeats/all sketches. **Worker heap, JS/GPU memory and live native
  allocations are unmeasured.** Capacity stability is not leak freedom or fulfillment of the original
  return-to-baseline memory criterion.
- Original worker-only ownership/all-kernel offload remains incomplete. The final report records a
  passing build and 32 targeted tests, but explicitly does not claim the concurrently run full-suite
  result; it does not establish every original acceptance item.

### Enable opt-08 and understand its scope

In the existing **`deployment.json`**, set this before application startup, then reload:

```json
{ "performance": { "geometryWorker": true } }
```

Only literal boolean `true` enables it, and browser `Worker` support is required. The default remains the
opt-07 main-thread scheduler, even when `Worker` exists. The setting is not stored in models or localStorage;
the worker starts lazily. SDK callers can override deployment selection with
`new OccShapeProvider({ geometryWorker: true })` (or `false`).

Hybrid offloads supported tracked fuse/cut/common operations in scheduled large chains (12+ features),
including the final combine for sketch extrude/press-pull, and the final supported render mesh. Local
OCCT replicas, profile/sweep construction, queries, selection, serialization, small/synchronous chains,
revolve, fillet/chamfer and other unsupported operations remain on main. Compatibility failures can fall
back locally; known native failures persistently quarantine booleans rather than retrying on main.
Cancellation discards stale results but cannot interrupt a native call.

References:

- [Final paired validation](../../docs/performance/final-paired.md) — latest outcomes after both P1 fixes,
  correctness criteria, limitations and reproducibility; supersedes earlier timings/review snapshots.
- [Compact paired data](../../docs/performance/final-paired.json) and raw captures:
  [main](../../docs/performance/final-paired-main.json.gz) / [hybrid](../../docs/performance/final-paired-hybrid.json.gz).
- [Baseline and combined opt-01–07/09 report](../../docs/saved-model-performance.md#combined-after-validation-opt-09)
  and [evidence index](../../docs/performance/README.md).
- [Worker enablement](../../packages/wasm/WORKER.md#enablement-recommendation),
  [supported paths](../../packages/wasm/WORKER.md#architecture-and-supported-paths) and
  [ownership/cancellation/failure limits](../../packages/wasm/WORKER.md#meshes-ownership-and-failures).

## Problem

Opening a saved model and closing a sketch can make the browser tab slow enough that Firefox offers to stop it. The example case is `Mouse Bottom.spicy`, which contains:

- 336 model nodes (250 stored shapes, 83 sketches, 1 parametric body)
- An 84-feature parametric body (1 initial extrude, 51 fuses, 32 cuts)
- A complex `SkirtWall` shape (181 faces, 420 edges) fused as the **second** feature, so almost every subsequent operation works on top of it
- 747 sketch entities and 550 constraints across 83 sketches

Both reported operations — opening the saved model and closing a sketch — run substantial geometry work synchronously on the browser's main thread, blocking input and repaint.

## Constraints

- **The model is a read-only benchmark.** Do not modify or overwrite `Mouse Bottom.spicy`.
- Preserve its geometry, sketches, constraints, parameters, feature order and visibility.
- All improvements are in application code, with runtime-only caches.
- No model simplification, saved-file changes or format migrations.
- Use synthetic fixtures for tests involving edits.
- The profiling harness disables persistence and file write-back.

## Root causes

1. **Sketch rollback discards the full feature cache.** Entering a sketch rolls the body back and replaces the cache with a truncated one. Closing it rebuilds downstream features even when nothing changed.
2. **Display-only changes trigger model rebuilds.** Toggling profile-face visibility emits a `"shape"` notification that dependent bodies interpret as a geometry change.
3. **Computational bounding-box queries trigger meshing.** `OccShape.boundingBox()` reads mesh data first, so geometry-matching code can cause rendering work on intermediate shapes.
4. **Profiles are rebuilt separately for display and extrusion.** No shared cache exists.
5. **Hidden geometry is meshed eagerly during loading.** The visual layer constructs meshes for all geometry nodes, including hidden construction intermediates.
6. **The feature chain blocks the main thread.** Each OCCT boolean runs synchronously; 84 features produce one long blocking interval.

## Delivery order

| Ticket | Title | Priority | Depends on |
|---|---|---|---|
| opt-01 | Performance baseline instrumentation | high | — |
| opt-02 | Preserve full feature cache during sketch rollback | high | opt-01 |
| opt-03 | Separate display invalidation from geometry changes | high | — |
| opt-04 | Geometry-only bounding-box queries | high | — |
| opt-05 | Sketch profile cache | medium | opt-03 |
| opt-06 | Deferred meshing for hidden geometry | medium | — |
| opt-07 | Responsive rebuild scheduling | high | opt-02 |
| opt-08 | Worker-owned kernel evaluation | medium | opt-07, opt-01 |
| opt-09 | Regression validation | high | all |

## Success criteria

- Unchanged sketch entry/exit performs **zero downstream boolean operations**.
- Real edits rebuild only the necessary suffix.
- Computational bounds and repeated profile queries avoid unnecessary meshing.
- Opening the example model shows a measured improvement over baseline.
- Long rebuilds provide progress and preserve browser responsiveness.
- The original model's geometry, references and visibility remain correct.
