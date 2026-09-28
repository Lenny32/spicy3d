# opt-03: Separate display invalidation from geometry changes

## Summary

Introduce a mesh/display invalidation notification distinct from `"shape"` so that display-only changes (toggling sketch profile-face visibility) do not trigger dependent-body re-evaluation.

## Motivation

`SketchNode.setShowProfileFaces()` emits `"shape"` when the actual shape is untouched:

```ts
// packages/parametric/src/sketch/sketchNode.ts:237
setShowProfileFaces(value: boolean): void {
    if (this._showProfileFaces === value) return;
    this._showProfileFaces = value;
    this._mesh = undefined;
    this.emitPropertyChanged("shape", this._shape);  // ← misleading
}
```

`ParametricBodyNode` watches for `"shape"` changes on referenced sketches:

```ts
// packages/parametric/src/parametricBodyNode.ts:1031
private readonly handleWatchedNodeChanged = (property: string) => {
    if (property !== "shape" && property !== "transform" && property !== "geometry") return;
    this.rebuildFromUpstream();
};
```

So entering sketch mode (which calls `setShowProfileFaces(false)`) triggers a body rebuild even though the geometry is unchanged. The rebuild may reuse cached results, but the invalidation check itself is unnecessary work — and on a body with 84 features, even the cache-validation pass walks every entry comparing shape identity and serialized feature data.

## Scope

### What changes

1. **Core notification contract** (`packages/core/src/`):
   - Define a new property name (e.g. `"mesh"` or `"display"`) for visual-only invalidation.
   - The visual layer listens to both `"shape"` and `"mesh"` to rebuild Three.js geometry.
   - Dependent bodies listen only to `"shape"`, `"transform"` and `"geometry"` — not `"mesh"`.

2. **`SketchNode`** (`packages/parametric/src/sketch/sketchNode.ts`):
   - `setShowProfileFaces()` emits the display-only notification instead of `"shape"`.
   - The actual shape and its cache are not touched.

3. **`ThreeGeometry`** (`packages/three/src/threeGeometry.ts`):
   - `handleGeometryPropertyChanged` rebuilds meshes on both `"shape"` and the new display notification.

4. **Sketch commit audit** (`packages/parametric/src/sketch/editor/sketchEditor.ts`):
   - Inspect `commit()` for cases where `setDataEmitShapeChanged` writes data that differs only in serialization order or display metadata.
   - Avoid treating serialization-only differences as geometry changes where possible.

### What stays the same

- Genuine geometry changes (entity moves, constraint additions, profile edits) still emit `"shape"` and propagate.
- The visual layer still rebuilds meshes when profile-face visibility changes.
- Profile picking and selection work correctly in both modes.

## Dependencies

None. Can be implemented in parallel with opt-02.

## Acceptance criteria

- [ ] Toggling `showProfileFaces` does not emit `"shape"`.
- [ ] Dependent bodies do not evaluate when profile-face visibility changes.
- [ ] The sketch visual updates correctly when profile faces are shown/hidden.
- [ ] Profile picking in sketch mode still works.
- [ ] Genuine geometry changes still propagate to dependent bodies.
- [ ] The visual layer rebuilds meshes on the new display notification.
- [ ] Existing sketch and body tests pass.

## Test plan

- Add a test: `setShowProfileFaces(false)` on a sketch referenced by a body does not call `rebuildFromUpstream` (verify via mock).
- Add a test: the visual layer rebuilds the sketch mesh on the display notification.
- Add a test: a real `setDataEmitShapeChanged` still triggers body re-evaluation.
- Run existing tests in `packages/parametric/test/sketch/` and `packages/three/`.

## Files

- `packages/parametric/src/sketch/sketchNode.ts` — emit display notification
- `packages/core/src/` — notification contract (if needed)
- `packages/three/src/threeGeometry.ts` — listen to display notification
- `packages/parametric/src/parametricBodyNode.ts` — no change (already ignores non-shape)
- `packages/parametric/test/` — new and updated tests
