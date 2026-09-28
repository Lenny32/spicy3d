# Optimization: saved-model loading and sketch closing

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
