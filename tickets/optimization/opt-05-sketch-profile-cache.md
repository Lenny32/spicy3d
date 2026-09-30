# opt-05: Sketch profile cache

## Summary

Cache sketch profile results (faces, wires, entity-id sets) keyed by geometry revision, sharing them between rendering and extrusion to avoid redundant construction.

## Motivation

Sketch profiles are built in two independent paths:

1. **Rendering** — `SketchNode.createMesh()` calls `sketchProfiles()` to build closed-profile faces for display and picking (`packages/parametric/src/sketch/sketchNode.ts:252`).
2. **Extrusion** — `resolveProfiles()` calls `sketchProfiles()` again to get the same faces (`packages/parametric/src/features/profileBuilder.ts:269`).

`sketchProfiles()` is expensive for large sketches:

- `collectEdges()` enumerates the sketch shape's edges.
- `needsKernelSplit()` performs O(n²) pairwise edge-intersection checks (up to 3,240 pairs for an 81-entity sketch).
- `groupConnected()` groups edges by endpoint connectivity.
- `buildWires()` constructs OCCT wires and samples loops as polygons.
- `buildFaces()` constructs OCCT faces with holes.
- `crossingProfiles()` splits edges through the kernel when needed.

Each call rebuilds everything from scratch. For the example model, entering a sketch and then extruding (or just displaying the sketch in the body's feature chain) constructs the same profiles twice.

## Scope

### What changes

1. **Profile cache** (`packages/parametric/src/features/profileBuilder.ts`):
   - Add a cache keyed by the sketch's geometry revision: the shape identity, `dataJson` content hash (or revision number), plane and `showProfileFaces` state.
   - `sketchProfiles(sketch)` checks the cache first; on a hit, returns the stored `SketchProfileSet`.
   - On a miss, builds and stores the result.
   - The cache is per-`SketchNode` instance (not global), disposed with the node.

2. **Cache invalidation**:
   - Invalidate when `dataJson` changes (entity edits, constraint changes, external-ref resolution).
   - Invalidate when the sketch's `shape` changes (plane moves, external-ref geometry moves).
   - Invalidate when `showProfileFaces` toggles (the `SketchProfileSet` content differs).
   - Do NOT invalidate on display-only notifications (opt-03).

3. **Ownership**:
   - Cached faces and wires are OCCT shapes with kernel handles.
   - They must be disposed when invalidated and when the node is disposed.
   - The cache must not return shapes that have been disposed by a chain eviction or timeline reset.
   - Use weak references or a revision check to detect stale shapes.

4. **`SketchNode` integration** (`packages/parametric/src/sketch/sketchNode.ts`):
   - Expose a geometry revision counter or hash that the cache key uses.
   - Bump the revision on `setDataEmitShapeChanged`, plane changes and external-ref resolution.

### What stays the same

- `resolveProfiles()` calls `sketchProfiles()` — the cache is transparent to callers.
- Profile matching (`matchProfileIndexes`) and seed generation (`profileSeeds`) work on the cached result.
- The profile mesh for rendering is built from the cached faces (separate from the profile cache itself).

## Dependencies

- **opt-03** (display invalidation) — ensures the cache is not invalidated by display-only changes.
- **opt-04** (geometry-only bounds) — reduces the cost of `needsKernelSplit` within the cache-miss path.

## Acceptance criteria

- [ ] Displaying a sketch and then evaluating a feature that extrudes it builds profiles once, not twice.
- [ ] Unchanged sketch display reuses cached profiles across multiple evaluations.
- [ ] Editing sketch entities invalidates the cache and rebuilds profiles.
- [ ] Moving the sketch plane invalidates the cache.
- [ ] External-ref resolution invalidates the cache when geometry moves.
- [ ] Toggling `showProfileFaces` invalidates and rebuilds correctly.
- [ ] Cached shapes are disposed on invalidation and node disposal.
- [ ] No disposed shape is returned from the cache.
- [ ] Existing profile and extrude tests pass.

## Test plan

- Add a test: two consecutive `sketchProfiles()` calls on an unchanged sketch return the same `SketchProfileSet` (identity check on faces).
- Add a test: `setDataEmitShapeChanged` invalidates the cache (new faces returned).
- Add a test: node disposal disposes cached shapes.
- Add a test: rendering then extruding builds profiles once (mock `sketchProfiles` to count calls).
- Run existing tests in `packages/parametric/test/profileBuilder.test.ts` and extrude tests.

## Files

- `packages/parametric/src/features/profileBuilder.ts` — cache implementation
- `packages/parametric/src/sketch/sketchNode.ts` — geometry revision counter
- `packages/parametric/test/` — new and updated tests
