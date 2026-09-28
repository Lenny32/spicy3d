# opt-02: Preserve full feature cache during sketch rollback

## Summary

Keep the full feature-chain cache while a sketch session displays a rolled-back preview, so closing an unchanged sketch reuses cached geometry instead of rebuilding every downstream feature.

## Motivation

Entering a sketch rolls dependent bodies back to the sketch's timeline position. The current implementation **replaces** the full cache with the truncated one and disposes the excluded intermediate shapes:

- `BodyTimeline.commit()` swaps `_cache` to the truncated run (`packages/parametric/src/features/bodyTimeline.ts:93`).
- Evicted shapes are disposed (`bodyTimeline.ts:96`).
- `setRollbackIndex()` calls `generateShape()` → `evaluateChain()` → `commit()` (`packages/parametric/src/parametricBodyNode.ts:199`).

Closing the sketch calls `setRollbackIndex(undefined)`, which must re-evaluate the full chain. For `Mouse Bottom.spicy`:

| Sketch opened and closed | Features needing rebuild |
|---|---:|
| `Sk_Plate` (feature 0) | All 84 |
| `Sk_ThumbWing` (feature 2) | 82 |
| `Sk_RibBox1` (feature 11) | 73 |
| Final sketch (feature 83) | 1 |

This is the **single largest avoidable cost** when closing an unchanged sketch.

## Scope

### What changes

1. **`BodyTimeline`** (`packages/parametric/src/features/bodyTimeline.ts`):
   - Separate the **displayed rollback timeline** from the **retained full-chain cache**.
   - During rollback, keep `_cache` and `_committed` intact; expose the truncated state for display and timeline queries without overwriting the full cache.
   - On restoration, validate retained entries and reuse them.

2. **`ParametricBodyNode`** (`packages/parametric/src/parametricBodyNode.ts`):
   - `setRollbackIndex()` evaluates the truncated chain for display but does not discard the full cache.
   - On restoration (`setRollbackIndex(undefined)`), validate each cached entry against its feature data, input shape identity, referenced node snapshots and variable scope.
   - Reuse valid entries; rebuild only from the first invalid feature.
   - Keep `timelineStateAt` consistent with the active rollback position for reference resolution.

3. **`SketchEditor`** (`packages/parametric/src/sketch/editor/sketchEditor.ts`):
   - No API change needed — `restoreRolledBackBodies()` still calls `setRollbackIndex(undefined)`.
   - The improvement is transparent: the body skips rebuilding when the cache is valid.

### What stays the same

- Rollback display behavior (hidden features stay hidden during the session).
- Timeline query semantics for external-reference resolution.
- Undo/redo history (rollback is runtime-only, never transacted).
- The feature panel shows the correct truncated state during the session.

### Shape ownership and disposal

- Retained downstream shapes must stay alive while the rollback is displayed.
- The rollback preview shape is temporary and disposed on restoration.
- A failed rebuild during restoration keeps the last good shape (same policy as today).
- Document disposal must release both the retained cache and the preview shape.
- `BodyTimeline.dispose()` must handle the split state.

### Validation on restoration

Each retained cache entry is valid when ALL of:
- `entry.json` matches the current feature's serialized form (feature data unchanged).
- `entry.input` is the same shape object as the chain input at that position.
- Each referenced node snapshot matches: shape identity, transform and datum.
- The variable scope has not changed since the entry was cached.

If any check fails, rebuild from that feature onward (same as today's behavior).

## Dependencies

- **opt-01** (performance baseline) — needed to measure the improvement.

## Acceptance criteria

- [ ] Opening and closing `Sk_Plate` unchanged performs **zero downstream boolean operations**.
- [ ] Opening and closing the final sketch unchanged performs zero boolean operations.
- [ ] Opening and closing any unchanged sketch reuses all valid downstream cache entries.
- [ ] Editing a sketch invalidates only the affected suffix; the valid prefix is reused.
- [ ] Variable changes invalidate dependent features correctly.
- [ ] Undo/redo across a sketch session works correctly.
- [ ] A failed rebuild during restoration keeps the last good shape.
- [ ] Consumed-body dependencies (`refreshConsumedTools`) work correctly across rollback.
- [ ] Repeated unchanged open/close cycles do not accumulate memory or retained chains.
- [ ] Document disposal during a sketch session releases all shapes correctly.
- [ ] Timeline queries during rollback return the correct truncated state.
- [ ] Existing rollback tests pass (`sketchRollbackBystander.kernel.test.ts`, `sketchEditor.session.test.ts`, `parametricBodyNode.test.ts`).

## Test plan

- Reuse existing rollback tests in `packages/parametric/test/`.
- Add a test: unchanged entry/exit with a multi-feature body verifies no `booleanFuse`/`booleanCut` calls (mock the shape factory).
- Add a test: entry/exit after a sketch edit verifies only the suffix features are re-evaluated.
- Add a test: repeated entry/exit cycles do not grow memory (shape count stable).
- Add a test: consumed-body dependency across rollback restores correctly.

## Files

- `packages/parametric/src/features/bodyTimeline.ts` — split cache/timeline state
- `packages/parametric/src/parametricBodyNode.ts` — rollback without cache destruction, validation on restore
- `packages/parametric/src/sketch/editor/sketchEditor.ts` — no change (transparent)
- `packages/parametric/test/` — new and updated tests
