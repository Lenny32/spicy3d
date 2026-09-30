# opt-09: Regression validation

## Summary

Validate that all optimization tickets preserve correctness: geometry, references, visibility, undo/redo and memory behavior are identical to the baseline on the unchanged example model and across synthetic edit fixtures.

## Motivation

The optimizations touch cache lifecycle, notification contracts, geometry queries and the evaluation loop. Each must be validated individually and in combination to ensure no regression.

## Constraints

- **The model is a read-only benchmark.** Verify its hash before and after.
- No saved-file changes or format migrations.
- Runtime-only caches.
- Synthetic fixtures for edit tests.

## Scope

### Per-ticket validation

| Ticket | Key validation |
|---|---|
| opt-01 | Instrumentation is opt-in; disabled path has zero overhead |
| opt-02 | Unchanged sketch closure: zero downstream booleans; edit: only suffix rebuilds |
| opt-03 | Profile visibility toggle: no body evaluation; geometry change: propagates |
| opt-04 | Geometry-only bounds: no meshing; profile detection and refs unchanged |
| opt-05 | Profile cache: one build per revision; invalidation on edits |
| opt-06 | Hidden geometry: no mesh at load; visible on demand |
| opt-07 | Rebuild yields; stale jobs cancelled; small chains synchronous |
| opt-08 (if implemented) | Worker results match main-thread baseline; responsive during long calls |

### Combined validation

After all tickets are implemented:

1. **Geometry equivalence** on `Mouse Bottom.spicy`:
   - Load the model, evaluate the body, export BREP.
   - Compare with the baseline BREP (captured before optimizations).
   - Verify face count, edge count, vertex count and bounding box match.

2. **Reference stability**:
   - Open each sketch referenced by the body, close it unchanged.
   - Verify no `ProfileRef` or `EdgeRef` data changes (feature JSON is identical).
   - Verify `refPositions` are unchanged.

3. **Visibility preservation**:
   - The model's visibility settings are unchanged after load.
   - Hidden construction geometry remains hidden.
   - The final body is visible.

4. **Undo/redo**:
   - Load the model, perform an undo, then redo.
   - Verify the state is restored correctly.
   - Open a sketch, edit a dimension, undo, close the sketch.
   - Verify the body shape is correct at each step.

5. **Memory**:
   - Load the model, record WASM heap size.
   - Open/close sketches 10 times unchanged.
   - Verify heap size returns to the post-load baseline (no leak).

6. **Firefox benchmarks**:
   - Repeat all five scenarios from opt-01.
   - Compare timings, boolean counts and longest blocking interval with the baseline.

### Synthetic edit fixtures

Create separate test documents (not the example model) covering:

- Sketch entity edit (move a line endpoint).
- Constraint addition and removal.
- Dimension edit with a variable expression.
- Feature parameter change (extrude depth).
- Feature suppression and unsuppression.
- Feature reordering.
- Boolean tool deletion.
- Sketch plane move.
- External-reference source edit.
- Undo/redo across each of the above.

### Performance regression test

- Add a test that loads the example model and verifies:
  - Boolean call count is zero for unchanged sketch entry/exit.
  - Boolean call count for cold load is stable (does not regress).
  - No meshing of hidden geometry at load.
  - No profile rebuild on cache hit.

## Dependencies

All other tickets.

## Acceptance criteria

- [ ] The example model's BREP output is identical to the baseline.
- [ ] Face, edge and vertex counts match the baseline.
- [ ] No `ProfileRef` or `EdgeRef` data changes on unchanged sketch entry/exit.
- [ ] The model's visibility settings are preserved.
- [ ] Undo/redo works correctly across sketch sessions and feature edits.
- [ ] WASM heap size is stable across repeated unchanged open/close cycles.
- [ ] Firefox benchmarks show improvement over baseline for all five scenarios.
- [ ] The example model file is verified unchanged (hash check).
- [ ] All existing tests pass.
- [ ] All synthetic edit fixtures pass.

## Files

- `packages/parametric/test/` — regression tests
- `packages/builder/test/` — integration tests
- `packages/wasm/test/` — kernel-level tests
- `packages/three/test/` — rendering tests
- Test fixtures (synthetic documents, not the example model)
