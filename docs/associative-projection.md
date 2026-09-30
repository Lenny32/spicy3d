# Associative curve projection

Project curve creates a curve body from an ordered chain of whole source edges and one
trimmed target face. Both inputs remain references: sketch or body edits rebuild the curve.
Source edges and the target face must have tracked identities. Untracked imported geometry
reports an unsupported association instead of assigning topology indexes as persistent IDs.

Set the three world direction components, then confirm the live preview. Reverse direction
negates all components. Rays travel only forward: targets behind the source, incomplete
coverage, folded curves and multiple forward branches produce an error. A cylinder viewed
from outside can have two forward intersections; select a suitable trimmed face rather than
expecting the command to choose a branch. Holes in the target must not remove any portion of
the projected source curve.

Edit the feature to change direction or select source and target again. Confirmation is one
undo step; cancellation changes no committed feature. Source and target remain visible and
editable. The result's logical edge IDs combine actual source and target ancestry with their
node and projection-feature identities. A seam can divide one logical curve into pieces that
share an ID, using the existing edge-span reference handling.

For `run_parametric`, use:

```json
{
  "ops": [{
    "op": "projection", "id": "onWall",
    "source": "sourceSketch", "edgeIndexes": [0],
    "target": "cylinderBody", "faceIndex": 0,
    "direction": { "x": 1, "y": 0, "z": 0 }
  }]
}
```

The target face index is captured as an associative reference. Use the actual curved wall's
current index. For a parametric source body, `edgeRefs` from an `edges` query can replace
`edgeIndexes`; references remain body-scoped and may round-trip through JSON between calls.
Source edge indexes must be in connected traversal order. All indexes are validated before
creation. Edit direction components with `editFeature` / `setParameter` keys `directionX`,
`directionY`, `directionZ`, using finite numbers; direction expressions are not supported.

Native projection is filtered by exact forward swept sheets. Completeness is checked by
transverse projection and exact curve intersection lengths, including interior trimmed gaps.
Assembly copies are assigned ancestry only after exact full-edge overlap identifies their
unique source piece; ordinary circular fingerprints cannot distinguish seam-split arcs.
