# Associative sketch offsets

The sketch program's `offset` action accepts `associative: true` (default `false`).
It creates an ordinary curve and an `Offset` constraint (`kind: 34`) with two refs,
source then target, both at point index zero, and a signed `datum` (millimetres or
a length expression). `sketchInfo.constraints` reports the ids, refs and expression.
The sketch constraint panel shows Associative offset, Edit and Remove.

Supported sources are lines, arcs, circles, and open/periodic fit or control
B-splines. B-spline targets remain approximate interpolating curves, checked by
the existing offset fitter to 0.001 mm with at most 512 fit points. Collapsed,
inverted, self-intersecting or over-budget fits fail with the constraint id.
Regeneration stages all targets before publishing any geometry; failures preserve
the last good targets and appear in solver diagnostics. Off-session rebuilds
return a Result error, including during merge validation, rather than consuming
stale target geometry as a successful feature input.

Targets are pinned in the native solver and owned by the relation. Offset chains
and extra constraints on a target are refused. Remove the relation before editing
or constraining its target. Source deletion removes the relation and retains a
plain target with its last good geometry. Deleting the target removes the relation.
Trim/split/extend replace a source entity and therefore detach its relations too.
Move, rotate and mirror detach relations touching the selection. Copy and paste
create plain geometry; the originals keep their relations. Even copying a whole
source/target pair detaches the copies. Mirror-copy may still create the existing
symmetry constraints, but copies of generated targets are fixed snapshots and do
not inherit offset relations.

For a loft section, keep the pasted source as construction geometry and offset it
associatively; the generated target's construction flag is independent. Paste is
a snapshot: this relation follows its source in the same sketch, not the original
entity in another sketch. Cross-sketch source links and extrusion draft are outside
this change.

Regeneration runs after the source's fine solve (pointer release, explicit edits,
commit, variable update, or rebuild). Coarse pointer-move solves retain the previous
target as a cheap preview. A per-session signature skips unchanged source/distance
inputs; fitting never runs in the pointer-move path. Each regeneration uses the
existing bounded fitter; the native target pinning adds no new WASM bindings.

Sketch module version 6 adds Offset and optional entity `derivation: "offset"`.
This marker identifies cached generated geometry to the merge rules; it is removed
when a link is detached. Target geometry merges as derived state, so concurrent
source and distance edits merge independently and regenerate during validation.
Detachment versus a concurrent target/relation edit is a conflict. Keeping a relation
whose source was deleted raises a dangling-reference conflict; restore the source
or choose the detached side before finishing. Refs use ids,
never names. Invalid merged ownership or missing entities fail rebuild validation.
Undo/redo and autosave use the normal sketch snapshot and document persistence.
The sketch 5→6 migration is identity: old geometry gains no links and userData is
untouched. The document envelope and parametric module versions are unchanged;
older applications refuse sketch 6 through the existing newer-module guard.
