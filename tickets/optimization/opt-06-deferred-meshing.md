# opt-06: Deferred meshing for hidden geometry

## Summary

Create lightweight visual objects for effectively hidden geometry during document loading, deferring mesh generation until the geometry becomes visible or an explicit operation requires it.

## Motivation

The visual layer constructs meshes eagerly for all geometry nodes:

```ts
// packages/three/src/threeVisualContext.ts:499
addNode(nodes: INode[]) {
    nodes.forEach((node) => {
        if (!this._NodeVisualMap.has(node)) {
            this.displayNode(node);
        }
    });
}
```

`displayNode()` creates a `ThreeGeometry` for every `GeometryNode`:

```ts
// packages/three/src/threeVisualContext.ts:512
} else if (node instanceof GeometryNode) {
    visualObject = new ThreeGeometry(node, this);
}
```

`ThreeGeometry`'s constructor immediately calls `generateShape()`, which reads `geometryNode.mesh` and creates Three.js buffer geometries:

```ts
// packages/three/src/threeGeometry.ts:62
constructor(...) {
    super(geometryNode);
    this._faceMaterial = context.getMaterial(geometryNode.materialId);
    this.generateShape();  // ← meshes immediately
    geometryNode.onPropertyChanged(this.handleGeometryPropertyChanged);
}
```

`geometryNode.mesh` triggers OCCT meshing on `OccShape`:

```ts
// packages/wasm/src/shape.ts:107
get mesh(): IShapeMeshData {
    this._mesh ??= new Mesher(this);
    return this._mesh;
}
```

The `Mouse Bottom.spicy` model contains 250 stored shape nodes, most of which are construction intermediates (beziers, lofts, wires, faces, the `SkirtWall` sewing). Meshing all of them at load time is unnecessary when only the final body is displayed.

## Scope

### What changes

1. **`ThreeGeometry`** (`packages/three/src/threeGeometry.ts`):
   - Add a "deferred" mode that creates the Three.js `Object3D` hierarchy without generating meshes.
   - When deferred, `generateShape()` is a no-op; meshes are created on first demand.
   - Add a `buildMeshes()` method that performs the actual meshing when called.

2. **`ThreeVisualContext`** (`packages/three/src/threeVisualContext.ts`):
   - Determine effective visibility when creating a visual object: a node is effectively hidden if it itself is invisible, or any ancestor is invisible.
   - Create deferred `ThreeGeometry` objects for effectively hidden nodes.
   - Create immediate `ThreeGeometry` objects for visible nodes (current behavior).
   - When a node or ancestor becomes visible, call `buildMeshes()` on its deferred visual.

3. **Visibility change handling**:
   - Listen for `"visible"` property changes on nodes and their ancestors.
   - When a hidden node becomes visible, build its meshes.
   - When a visible node becomes hidden, optionally dispose its meshes to free memory (evaluate trade-off).

4. **Export and selection**:
   - Operations that need meshes (export, selection, bounding-box queries for viewport fitting) explicitly call `buildMeshes()` on deferred visuals.
   - This is a rare path compared to loading.

### What stays the same

- Visible geometry is meshed immediately (no regression for the common case).
- The scene graph structure is unchanged.
- Node-tree visibility toggling works correctly.
- The final body's mesh is created on load (it is visible).

### Consumed tools

Consumed boolean tools are moved under the body node (`syncConsumedTools`). They may be visible in the tree but hidden in the scene (`_children` render flag returns false). Check the body's child-list render flag, not just the node's own `visible` property.

## Dependencies

None. Can be implemented in parallel with other tickets.

## Acceptance criteria

- [ ] Hidden construction geometry is not meshed during loading.
- [ ] The final visible body is meshed and displayed correctly.
- [ ] Toggling a hidden node's visibility builds its meshes on demand.
- [ ] Toggling an ancestor's visibility builds descendant meshes on demand.
- [ ] Export and viewport-fit operations work correctly with deferred visuals.
- [ ] Selection and picking work correctly after deferred meshes are built.
- [ ] The model's existing visibility settings are preserved.
- [ ] Memory is lower at load time compared to baseline.

## Test plan

- Add a test: loading a document with hidden geometry nodes does not create meshes for them (verify `Mesher` is not constructed).
- Add a test: making a hidden node visible builds its meshes.
- Add a test: making an ancestor visible builds descendant meshes.
- Add a test: export with deferred visuals produces correct output.
- Add a test: viewport `fitContent` works with deferred visuals.
- Run existing tests in `packages/three/test/`.

## Files

- `packages/three/src/threeGeometry.ts` — deferred mode and `buildMeshes()`
- `packages/three/src/threeVisualContext.ts` — visibility-aware creation, deferred-mesh triggers
- `packages/three/src/threeView.ts` — `fitContent` handling for deferred visuals
- `packages/three/src/meshExporter.ts` — ensure meshes before export
- `packages/three/test/` — new and updated tests
