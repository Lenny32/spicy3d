# #93 Control-pole sketch NURBS

Implemented on `mouse/93-control-nurbs`, based on `9aa95d5f`.

The boss directly approved “Approve the plan’s backward-compatible format changes”; concrete
schema approval is recorded in `mouse-schema-plan.md`. Sketch format is 3, document envelope
remains 2 and parametric remains 5. Existing fixtures are unchanged. The optional entity `control`
definition contains degree, distinct knots, multiplicities and optional weights; `params` then holds
UV poles. Absent control remains the existing fit-point curve. Sketch2→3 is a pure identity migration.

The ribbon's Control B-spline command authors poles. Existing fit B-spline authoring remains
unchanged. Sketch mode displays the control polygon; normal point picking/dragging manipulates
poles. Select a control curve and press Enter to edit degree, knots, multiplicities and weights.
Settings validate the whole layout before applying and confirm creates one undo step; Cancel and
invalid input leave the sketch unchanged. Pole-index constraints and entity identity persist.

MCP `sketch` entities accept `poles` plus optional `degree`, `knots`, `multiplicities`, `weights`,
`periodic`, mutually exclusive with fit `points`/`params`/`parametrization`. `editSketch` action
`setBSpline` edits these settings; `movePoint` addresses poles. A degree edit generates default knots
if no explicit layout is supplied and preserves weights. `sketchInfo` includes control metadata.
Open controls are initially clamped, periodic controls use uniform knots with multiplicity one.
Weighted controls require the existing native B-spline binding; older kernels report a clear error.
Unweighted controls retain exact Bezier fallback. No native binding or binary change is required.

Direct poles are ordinary PlaneGCS parameters, without fit interpolation equations. Weights and
knots are constant solver parameters. Curve incidence and endpoint tangency use the rational curve.
Periodic seam helper coordinates are constrained to the curve and introduce no extra freedom.

Merge: params are atomic as before; control layout is atomic as a unit. Independent pole-position
and weight edits can merge. Concurrent layout edits conflict at `node/<sketch>/entity/<id>/control`.
Invalid combined geometry remains subject to the existing headless merge validation.

Persistence evidence: `SketchNode.dataJson` is the existing serialized payload. Core
`splitManifest`/`assembleManifest` carry it unchanged to/from cloud manifests and blobs; cloud
`CloudDocumentRepository` load/version preview uses that assembly, then Document migrations.
`VersionHistory.restore` calls repository `restoreVersion`, reusing version manifest/blob references.
Compare uses the registered SketchNode payload merge rule, now including control. Existing
`decodeDocumentFile` handles both device gzip and server `spicy3d.cloudVersion` export unchanged.
New fixture `v2/sketch3-control-nurbs.json` proves rational open and weighted periodic curves rebuild,
extrude, and serialize their models exactly. Tests round-trip cloud manifests, device `.spicy`, and
server export, and verify semantic comparison and stable atomic conflict paths.

Validation includes OCCT parity for weighted open/periodic curves, free-pole DOFs and incidence,
invalid settings rollback, separate JSON-round-tripped program calls, real viewport picking/pole
dragging, settings cancel/confirm and undo/redo, all old fit tests, migrations, document/kernel merge
fixtures, registered merge rules, TypeScript and scoped `npm run check`.

Final combined run: 1,186 tests passed across 64 files. Scoped npm check and checkout-aliased
TypeScript passed. Rstest printed two Windows libuv worker-shutdown assertions but returned exit
code 0 with no test failures. The temporary checkout alias configurations were not committed.
