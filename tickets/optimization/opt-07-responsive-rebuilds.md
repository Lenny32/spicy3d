# opt-07: Responsive rebuild scheduling

## Summary

Introduce an explicit rebuild scheduler that yields to the browser between feature evaluations, providing progress and cancellation, so that necessary geometry work does not freeze the tab.

## Motivation

The feature chain runs in a synchronous loop:

```ts
// packages/parametric/src/parametricBodyNode.ts:623
for (let index = 0; index < features.length && index < stop; index++) {
    timeline.push({ shape: input, faceIds, edgeIds });
    const feature = features[index];
    if (feature.suppressed) continue;
    const step = withConstructionFeaturePosition(..., () => {
        this.followReferencedSketches(feature, followedSketches);
        this.refreshConsumedTools(feature);
        return this.evaluateFeatureStep(feature, scope, input, faceIds, edgeIds, nextCache);
    });
    ...
}
```

Each `evaluateFeatureStep` calls into OCCT via WebAssembly synchronously (`packages/wasm/src/factory.ts:114`). For 84 features, the entire loop blocks the main thread. Firefox detects the long-running task and offers to stop the tab.

The `async` in `Document.load()` and `ModelManager.deserialize()` does not help: the actual geometry evaluation happens lazily when the visual layer requests a mesh, which triggers `ParametricBodyNode.shape` → `generateShape()` → `evaluateChain()` — all synchronous.

## Scope

### What changes

1. **Rebuild job abstraction** (`packages/parametric/src/`):
   - Define a `RebuildJob` that evaluates the feature chain in batches, yielding to the event loop between batches.
   - Track the document revision at job start; abort if the revision changes (a newer edit superseded this rebuild).
   - Keep the last valid shape visible during the rebuild (progressive display).
   - Report progress (feature index / total) to the status bar or a progress indicator.
   - Support cancellation at safe boundaries (between features, not mid-OCCT-call).

2. **`ParametricBodyNode.evaluateChain`** (`packages/parametric/src/parametricBodyNode.ts`):
   - Refactor the evaluation loop to support batching: evaluate N features, yield, resume.
   - The synchronous path remains for small chains (below a threshold); the async path is used for large chains.
   - `generateShape()` returns the last valid result immediately if a rebuild is in progress.
   - On completion, install the new shape and notify dependents.

3. **Re-entrancy and consistency**:
   - Prevent edits, saves and undo transactions from observing a partially rebuilt state.
   - A shape read mid-rebuild returns the previous valid result (same as the current `_evaluating` guard).
   - If a new edit arrives during a rebuild, cancel the current job and start a new one.
   - Watched-node notifications during a rebuild are queued, not processed immediately.

4. **Loading integration** (`packages/app/src/document.ts`, `packages/three/src/threeGeometry.ts`):
   - During document load, the visual layer requests the body mesh.
   - The body starts an async rebuild job and shows a loading indicator.
   - The mesh is installed when the rebuild completes.

5. **Sketch rollback and restore** (`packages/parametric/src/sketch/editor/sketchEditor.ts`):
   - `setRollbackIndex()` for a large chain uses the async path.
   - The sketch session waits for the rollback to complete before activating the solver.
   - On exit, restoration uses the async path if the chain is large.

### What stays the same

- Small chains (few features) evaluate synchronously — no latency for simple documents.
- The cache-hit path is fast and synchronous (validating cached entries is cheap).
- The evaluation logic per feature is unchanged.
- Shape identity, tracking and reference resolution are unchanged.

### Limitation

Yielding between features helps responsiveness **between** OCCT calls. A single long boolean (e.g. fusing `SkirtWall` into the body) can still block for seconds. **opt-08** addresses this if needed.

## Dependencies

- **opt-02** (preserve rollback cache) — reduces the work needed on restoration, making the async path worthwhile.
- **opt-01** (performance baseline) — provides the longest-single-call measurement to determine whether yielding alone is sufficient.

## Acceptance criteria

- [ ] Firefox remains responsive (processes input, repaints) during a full-chain rebuild of the example model.
- [ ] Progress is reported during the rebuild.
- [ ] The last valid shape stays visible during the rebuild.
- [ ] An edit arriving mid-rebuild cancels the stale job and starts a new one.
- [ ] A cancelled job does not install a partial result.
- [ ] Small chains (under threshold) evaluate synchronously with no regression.
- [ ] The cache-hit path is synchronous and fast.
- [ ] Undo/redo works correctly across async rebuilds.
- [ ] Sketch rollback and restoration work correctly with the async path.
- [ ] Existing chain and rollback tests pass.

## Test plan

- Add a test: a large-chain rebuild yields to the event loop (verify with fake timers or `await` checkpoints).
- Add a test: an edit arriving mid-rebuild cancels the stale job.
- Add a test: a cancelled job does not call `setShape`.
- Add a test: the cache-hit path returns synchronously.
- Add a test: small chains evaluate synchronously (no unnecessary yielding).
- Run existing tests in `packages/parametric/test/`.

## Files

- `packages/parametric/src/parametricBodyNode.ts` — batched evaluation, async path
- `packages/parametric/src/features/bodyTimeline.ts` — batched commit/discard
- `packages/parametric/src/sketch/editor/sketchEditor.ts` — async rollback/restore
- `packages/app/src/document.ts` — async load integration
- `packages/three/src/threeGeometry.ts` — deferred mesh on async rebuild
- `packages/parametric/test/` — new and updated tests
