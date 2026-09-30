# Mouse project implementation checklist

Integration branch: `enhancement-mouse-project`, based on `origin/develop` at
`103a5640b97068b07510dc819995b156119fad8d`. Final target: `develop`; never push to or merge into it.

Source instructions: [mouse-plan.md](../../mouse-plan.md). Original audit remains unchanged in
[mcp-user-report-2026-09-30.json](mcp-user-report-2026-09-30.json).
[Captured GitHub requirements](mouse-issues-2026-09-30.json) were read on 2026-09-30; all 26 are open.
The audit's scan-specific failures remain unconfirmed without the original inputs.

## Execution and validation

First wave: #106 and #100 in separate worktrees. Serialize #99 behind #106 because both own
`parametricProgram.ts`. Next correctness work: #81 then #82, requiring a real WASM rebuild.
Run 2–3 implementation workers at a time. Workers commit but never merge, push, or update issues.
Root reviews and integrates each ticket with a separate merge commit, then tests the integration.
Only pushed and validated tickets receive an issue title prefix and a full-SHA evidence comment;
issues remain open. Exactly one draft PR will be opened after the first meaningful integration.

Initial validation: targeted suites pass (170 tests across 7 files, including #106 regressions); production build passes with existing bundle-size warnings. Non-mutating Biome baseline reports widespread CRLF formatting differences; ticket-level npm run check passes after normalization. Record pre-existing failures
separately. Full-suite checks and compatibility fixtures are required before final delivery.

## Shared schema/version coordination

The task-specific approval in `mouse-plan.md` permits necessary backward-compatible format changes
for #81–#106. Current versions: document **2**, parametric **5**, sketch **2**. No payload changes or
version bumps are scheduled for the first wave.

Potential payload owners: #83/#84 fillet, #85 loft, #88 sweep, #89 projection, #90 groove/rib,
#94/#95 extrude in `featuresJson`; #93 sketch entities in `dataJson`. Root exclusively assigns
version numbers, migration registration and shared merge-rule ownership before these tickets start.
No worker may independently bump versions or alter these overlapping schemas. Concrete payloads
and version increments remain pending design; do not guess them before kernel/API feasibility review.
Existing fields retain defaults and behavior. New features must not require unrelated envelope changes.

Each approved payload change requires a pure module migration, unchanged existing fixtures plus a
new fixture, round-trip/old-document tests, merge-rule updates and cloud history/restore/compare/merge
validation. Preserve unknown-node payloads and `userData`. Older releases need not open new files.

Worker track: follow KERNEL-01 phase 1 with BREP-boundary operations, bounded execution and
`Transaction.executeAsync`; preserve main-thread synchronous feature evaluation initially. Agree on
one request/cancel/recovery protocol before #96/#97/#98/#92 implementation. No save-format changes.

## Tickets

| Ticket | Dependencies | Status | Agent | Task branch | Validation | Integration commit | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #81 Reject invalid fillet and chamfer results |  | Queued | — | — | Pending | — | — |
| #82 Report actionable fillet and chamfer failure diagnostics |  | Queued | — | — | Pending | — | — |
| #83 Support variable-radius fillets |  | Queued | — | — | Pending | — | — |
| #84 Support fillet corner setbacks |  | Queued | — | — | Pending | — | — |
| #85 Support guide and boundary curves in parametric lofts |  | Queued | — | — | Pending | — | — |
| #86 Expose persistent edge references through MCP |  | Queued | — | — | Pending | — | — |
| #87 Add rule-based edge selection through MCP |  | Queued | — | — | Pending | — | — |
| #88 Add a parametric sweep along a 3D path |  | Queued | — | — | Pending | — | — |
| #89 Add associative curve projection onto surfaces |  | Queued | — | — | Pending | — | — |
| #90 Add a parametric groove or rib along a curve on a face |  | Queued | — | — | Pending | — | — |
| #91 Invalidate feature caches only for dependent variables |  | Queued | — | — | Pending | — | — |
| #92 Expose asynchronous rebuild progress through MCP |  | Queued | — | — | Pending | — | — |
| #93 Support control-point and weighted NURBS in parametric sketches |  | Queued | — | — | Pending | — | — |
| #94 Add an associative from-face extrusion start |  | Queued | — | — | Pending | — | — |
| #95 Add automatic up-to-next-face or body extrusion extent |  | Queued | — | — | Pending | — | — |
| #96 Run expensive kernel operations in a bounded worker |  | Queued | — | — | Pending | — | — |
| #97 Cancel an in-flight kernel operation |  | Queued | — | — | Pending | — | — |
| #98 Recover a crashed kernel without reloading the tab |  | Queued | — | — | Pending | — | — |
| #99 Add compact run_parametric responses |  | Queued | — | — | Pending | — | — |
| #100 Do not return subshape references already evicted from the ref store |  | Implementing | mouse_100 | mouse/100-subshape-refs | Pending | — | — |
| #101 Import scan files as lightweight reference MeshNodes |  | Queued | — | — | Pending | — | — |
| #102 Measure CAD-to-reference-mesh deviation |  | Queued | — | — | Pending | — | — |
| #103 Expose STL tessellation tolerance in export |  | Queued | — | — | Pending | — | — |
| #104 Return exported model bytes or a resource through MCP |  | Queued | — | — | Pending | — | — |
| #105 Batch-export separate model files without repeated downloads |  | Queued | — | — | Pending | — | — |
| #106 Honor extrude names when appending to an existing body |  | Implementing | mouse_106 | mouse/106-extrude-names | Pending | — | — |

