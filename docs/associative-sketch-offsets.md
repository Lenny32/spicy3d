# Associative sketch offsets

The sketch ribbon's Offset command has an **Associative** checkbox in its command
options, remembered for the page session and initially off. The distance field
accepts positive lengths and length expressions; clicking selects the side, and
an expression on the negative side is stored as `-(expression)`. Creation is one
undo step, using the same target and Offset relation as the sketch program.

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
the last good targets and appear in solver diagnostics and runtime node warnings
naming the constraint. Live updates, reopening, and headless rebuilds (including
merge validation) build this last good geometry, so downstream features keep
working. Warnings are recomputed when regeneration is attempted and clear on
recovery; they are never stored. Unresolved expressions on other constraint kinds
retain their existing best-effort build behavior.

Targets are pinned in the native solver and owned by the relation. Offset chains
are refused. A target's **open-curve endpoint** can participate in Coincident with
a **movable line or arc endpoint**. This is option (a): the target parameters stay
frozen, so only the connecting geometry solves to the regenerated point. Use the
Coincident command (which exposes target endpoints), or draw/snap a line or arc to
an endpoint. The connector's other dimensions and constraints remain ordinary.
No new relation kind or stored payload is needed.

This intentionally supports only endpoint-to-endpoint Coincident: target centers,
B-spline interior points, periodic curves, curve incidence, collinearity, tangency
and dimensions on the target remain refused. A connector cannot itself be an
offset source or target, be Blocked, or have Fix on the joined endpoint. These
cases give the relation id and an actionable message to adjust the connector or
detach the relation. Removing the relation permits ordinary target editing. Source
deletion removes the relation and retains a plain target with its last good
geometry. Deleting the target removes the relation.
Trim/split/extend replace a source entity and therefore detach its relations too.
Move and rotate in place retain relations and regenerate their targets, whether
the source alone or both source and target are selected. Mirror detaches relations
touching the selection. Targets can be selected for deletion and construction
toggling, but remain non-draggable and otherwise non-editable. Copy and paste
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
When targets change, one additional fine solve updates connectors against the new
frozen endpoints. Offset source parameters are temporarily frozen during this
solve, so arc caps and dimensioned connectors adapt without nudging an
underconstrained source. Sources are then released for ordinary editing and
DOF/constraint diagnostics. Frozen offset arcs retain their intrinsic arc constraint in the
snapshot, but omit its redundant native equation; detaching restores it.
Fitted B-spline end refs are remapped if the fit point count
changes. A pass that fails, or whose connectors would move an offset source,
restores the previous target/connector geometry and reports the runtime warning;
it never iterates regeneration to chase a feedback loop. Source expressions and
connector dimensions merge independently and rebuild through validateMerge. If
both saved sides also changed the same connector's geometry, its existing atomic
`params` rule raises the normal geometry conflict. Choose either side's connector
geometry; the combined constraints still regenerate the endpoint during validation.
This preserves the existing geometry merge policy and stored format.
Closed-profile extraction and downstream extrusions use the joined geometry.

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

## Known limitations / follow-ups

- Only Coincident between open target endpoints and movable line/arc endpoints;
  other target constraints and connectors that cannot adapt with the source held
  in place are refused.
- No cross-sketch links.
- No offset chains.
- No extrusion draft angle.
