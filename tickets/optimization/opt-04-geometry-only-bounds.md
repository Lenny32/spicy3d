# opt-04: Geometry-only bounding-box queries

## Summary

Add an explicit bounding-box query that reads topology without generating a render mesh, so computational geometry code does not trigger meshing.

## Motivation

`OccShape.boundingBox()` reads mesh data first:

```ts
// packages/wasm/src/shape.ts:177
boundingBox(): BoundingBox {
    if (!this._boundingBox) {
        const points =
            this.mesh.faces?.position ?? this.mesh.edges?.position ?? this.mesh.vertexs?.position ?? [];
        if (points.length > 0) {
            this._boundingBox = BoundingBox.fromNumbers(points);
        } else {
            this._boundingBox = wasm.Shape.boundingBox(this.shape, this._mesh !== undefined);
        }
    }
    return this._boundingBox;
}
```

When no mesh exists, `this.mesh` is accessed, which lazily creates a `Mesher` and triggers full OCCT meshing (`packages/wasm/src/shape.ts:985`). The resulting mesh data is copied into JavaScript Float32Arrays — rendering work that computational queries do not need.

Bounding boxes are requested by:

- **Profile intersection detection** — `needsKernelSplit()` calls `edge.boundingBox()` in an O(n²) loop (`packages/parametric/src/features/profileGeometry.ts:138`).
- **Face fingerprints** — `captureRegionFingerprint()` calls `face.boundingBox()` for history completion (`packages/parametric/src/features/profileRef.ts:134`).
- **History completion** — `completeFaceHistory` captures fingerprints for every unmapped output face (`packages/parametric/src/features/historyCompletion.ts:190`).

For the `Mouse Bottom.spicy` model, this means profile detection on an 81-entity sketch performs up to 3,240 bounding-box checks, each potentially triggering mesh creation on intermediate OCCT edges.

## Scope

### What changes

1. **C++ side** (`cpp/src/shape.cpp`):
   - Verify the existing `wasm.Shape.boundingBox(shape, useTriangulation)` with `useTriangulation=false` computes bounds from geometry, not mesh.
   - If needed, add an explicit `boundingBoxGeometry()` that uses `BRepBndLib` without triangulation.

2. **`OccShape`** (`packages/wasm/src/shape.ts`):
   - Add a `geometryBoundingBox()` method that calls `wasm.Shape.boundingBox(shape, false)` without touching `this.mesh`.
   - Cache the result separately from the mesh-based bounding box.
   - Do not change the existing `boundingBox()` behavior — the visual layer may benefit from the mesh-based bounds.

3. **Computational callers**:
   - `IEdge.boundingBox()` and `IFace.boundingBox()` in profile detection and fingerprinting use the geometry-only variant.
   - This may require an interface change or a new method on `IEdge`/`IFace`.

### Fingerprint compatibility

`captureRegionFingerprint()` uses `BoundingBox.center()` as part of the `ProfileRef` stored identity. Changing the bounding-box computation could shift the center and invalidate stored references.

**Mitigation:**
- Compare geometry-only vs mesh-based bounds on the example model to quantify the difference.
- If centers match within `MATCH_TOLERANCE`, use geometry-only bounds directly.
- If they differ, keep mesh-based bounds for fingerprinting and use geometry-only bounds only for the `needsKernelSplit` broad-phase check.
- Do not change stored `ProfileRef` data — the model is read-only.

### What stays the same

- `boundingBox()` (the existing method) keeps its mesh-based behavior for rendering.
- Stored references are not recomputed or rewritten.

## Implementation decision

- `geometryBoundingBox()` uses the existing `Shape::boundingBox(shape, false)` binding:
  `cpp/src/shape.cpp` passes the flag directly to `BRepBndLib::Add` and handles void boxes.
  This path does not invoke a mesher; no C++ change or rebuild is needed.
- Profile broad-phase bounds are collected once per edge, outside the pair loop.
- Fingerprints deliberately retain `face.boundingBox()`: the bbox center participates in
  stored profile identity and history matching. Geometry bounds can differ from sampled
  Float32 mesh bounds. No real-model measurement has established that all center changes
  satisfy `MATCH_TOLERANCE`, so switching fingerprints is not justified. This also leaves
  their existing meshing cost in place.

### Validation evidence and limits

- Real-kernel tests on the existing WASM binary verify no mesh getter access or `_mesh`
  creation, independent rendering/geometry caches, parent-mesh avoidance for sub-faces,
  and invalidation after location replacement, tolerance changes and edge updates.
- An 81-edge synthetic loop completes the broad phase with exactly 81 geometry-bound
  calls and zero mesh accesses. Previously its 3,240 pairs requested two rendering
  bounds each (6,480 method calls, with per-shape caching). Pair comparisons remain
  quadratic; only the bound queries are linear.
- Split decisions are covered for disjoint lines, shared vertices, crossings,
  T-junctions, collinear overlap and crossing circles. Existing profile, edge-reference,
  history-completion and external-reference suites pass. A fingerprint regression test
  deliberately provides different geometry bounds and confirms the stored center still
  comes from rendering bounds.
- These are synthetic/kernel regression results, not a saved-model timing comparison.
  `Mouse Bottom.spicy` was not loaded or rewritten for this change; full-model profile
  equivalence, center deltas and end-to-end timings remain for opt-01/opt-09 validation.

## Dependencies

None. Can be implemented in parallel with opt-02 and opt-03.

## Acceptance criteria

- [ ] `geometryBoundingBox()` does not create a `Mesher` or access `this.mesh`.
- [ ] `needsKernelSplit` uses geometry-only bounds and performs no meshing.
- [ ] If fingerprint bounds change, the difference is measured and within tolerance, or the fingerprint path keeps mesh-based bounds.
- [ ] Profile detection results are identical to the baseline on the example model.
- [ ] History-completion results are identical to the baseline.
- [ ] Existing profile, edge-ref and history-completion tests pass.

## Test plan

- Add a test: calling `geometryBoundingBox()` on an unmeshed shape does not create a mesh (verify `_mesh` stays undefined).
- Add a test: `needsKernelSplit` on a large sketch does not trigger meshing.
- Run existing tests in `packages/parametric/test/` covering profiles, edge refs and history.
- Compare profile-detection output on the example model before and after.

## Files

- `cpp/src/shape.cpp` — verify or add geometry-only bounds
- `packages/wasm/src/shape.ts` — `geometryBoundingBox()` method
- `packages/parametric/src/features/profileGeometry.ts` — use geometry-only bounds
- `packages/parametric/src/features/profileRef.ts` — evaluate fingerprint compatibility
- `packages/parametric/src/features/historyCompletion.ts` — use geometry-only bounds if compatible
- `packages/wasm/test/` and `packages/parametric/test/` — new and updated tests
