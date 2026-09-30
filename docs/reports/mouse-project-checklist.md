# Mouse project implementation checklist

Integration branch: `enhancement-mouse-project`, based on `origin/develop` at
`103a5640b97068b07510dc819995b156119fad8d`. Final target: `develop`; never push to or merge into it.

Source instructions: [mouse-plan.md](../../mouse-plan.md). Original audit evidence is preserved in
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

Opening integration validation: **9,181 tests pass across 542 files; one skipped**. Production build,
repository lint/check and TypeScript checking pass. Existing bundle-size/lint warnings remain.
The initial targeted baseline had 170 tests across 7 files, including #106 regressions.
Windows validation uses Git's POSIX shell on PATH and four Rstest workers. The initial full run
found shell/line-ending problems and transient cloud failures; the corrected final full run passes.
Occasional Windows libuv worker-exit assertions are printed even on successful exit.
Record pre-existing failures
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
| #81 Reject invalid fillet and chamfer results | — | Implementing; native rebuild | mouse_81 | mouse/81-valid-corners | Pending | — | Pinned toolchain setup in progress |
| #82 Report actionable fillet and chamfer failure diagnostics | #81 | Queued | — | — | Pending | — | — |
| #83 Support variable-radius fillets | #81, #82; shared schema | Queued | — | — | Pending | — | — |
| #84 Support fillet corner setbacks | #81, #82; shared schema | Queued | — | — | Pending | — | — |
| #85 Support guide and boundary curves in parametric lofts | Shared schema; kernel feasibility | Queued | — | — | Pending | — | — |
| #86 Expose persistent edge references through MCP | #100 | Implementing | mouse_86 | mouse/86-persistent-edges | Pending | — | — |
| #87 Add rule-based edge selection through MCP | #86 | Queued | — | — | Pending | — | — |
| #88 Add a parametric sweep along a 3D path | Shared schema | Queued | — | — | Pending | — | — |
| #89 Add associative curve projection onto surfaces | Shared schema | Queued | — | — | Pending | — | — |
| #90 Add a parametric groove or rib along a curve on a face | #88, #89 | Queued | — | — | Pending | — | — |
| #91 Invalidate feature caches only for dependent variables | — | Done (pushed) | mouse_91 | mouse/91-dependent-cache | 154 worker regressions; 131 integrated cache/kernel tests; typecheck/check | 9c18b315741371a09d9b5a0d5679a056b2bced57 | — |
| #92 Expose asynchronous rebuild progress through MCP | #96; worker architecture | Queued | — | — | Pending | — | — |
| #93 Support control-point and weighted NURBS in parametric sketches | Shared sketch schema | Queued | — | — | Pending | — | — |
| #94 Add an associative from-face extrusion start | Shared schema | Queued | — | — | Pending | — | — |
| #95 Add automatic up-to-next-face or body extrusion extent | #94; shared schema | Queued | — | — | Pending | — | — |
| #96 Run expensive kernel operations in a bounded worker | KERNEL-01 architecture | Queued | — | — | Pending | — | — |
| #97 Cancel an in-flight kernel operation | #96 | Queued | — | — | Pending | — | — |
| #98 Recover a crashed kernel without reloading the tab | #96, #97 | Queued | — | — | Pending | — | — |
| #99 Add compact run_parametric responses | #106 (shared program file) | Done (pushed) | mouse_99 | mouse/99-compact-responses | 54 integrated MCP/program tests; typecheck/check | ba9a096c5e8ccb49262c874cfaef9d3074ac67d2 | — |
| #100 Do not return subshape references already evicted from the ref store | — | Done (pushed) | mouse_100 | mouse/100-subshape-refs | 95 integrated capability/skill tests; check | 2df0ca446ccaae926f630881ef2c2a3373324ab8 | — |
| #101 Import scan files as lightweight reference MeshNodes | — | Implementing | mouse_101 | mouse/101-reference-mesh | Pending | — | — |
| #102 Measure CAD-to-reference-mesh deviation | #101 | Queued | — | — | Pending | — | — |
| #103 Expose STL tessellation tolerance in export | Serialize converter/export API | Queued | — | — | Pending | — | — |
| #104 Return exported model bytes or a resource through MCP | Serialize export API | Queued | — | — | Pending | — | — |
| #105 Batch-export separate model files without repeated downloads | #104 | Queued | — | — | Pending | — | — |
| #106 Honor extrude names when appending to an existing body | — | Done (pushed) | mouse_106 | mouse/106-extrude-names | 38 real-kernel program tests; npm run check | e9b6d1b078f74c90deac96b7620dcb9f4808cf20 | — |

## Opening delivery status

Four tickets are reviewed, integrated, validated and pushed; their issues carry the [done] prefix and full-SHA validation comments, with labels preserved and issues left open. The other 22 remain queued; this is
an opening implementation, not completion of the project. Saved document version 2, parametric
version 5 and sketch version 2 are unchanged; no migrations or merge rules needed changes.

The user explicitly approved publication and commits to this branch on 2026-09-30, resolving the
initial automatic-approval rejection. The branch and reports are published, and the single
[draft PR #107](https://github.com/Lenny32/spicy3d/pull/107) targets develop. It stays draft while
22 tickets remain queued. [The PR description](mouse-project-pr.md) lists all four integration SHAs.
No pushes to develop/main and no PR merge have been performed.

Next correctness work: #81 then #82. Windows lacks CMake on PATH and no local emsdk/OCCT build tree
was found; WSL Ubuntu has CMake/Ninja, but the WASM prerequisites must be set up before C++ changes
can be considered validated. Do not integrate source-only kernel changes with stale binaries.

Final checks performed on the root integration checkout:

- `npx rstest --pool.maxWorkers 4` with `C:/Program Files/Git/usr/bin` prepended to PATH:
  9,181 passed, 1 skipped, 542 files, exit 0.
- `npm run build`: app and all three plugins build, exit 0; existing size warnings.
- `npx tsc --noEmit`: exit 0.
- `npm run check`: whole repository, exit 0; existing warnings and CRLF normalization only.
  After the final two merges, `npm run check -- <11 changed paths>` also passed.
- #106: all program kernel tests; #100: all four capability/skill suites; #99: MCP handler and
  program kernel suites; #91: tracked-scope/body/scheduling/rollback/multi-body/hybrid kernel suites.

Worktrees live under `.claude/worktrees/` and are excluded by the existing repository config.
All merges use separate ticket commits. The integration branch never writes to develop or main.
## Resumed implementation

After publishing the first four tickets, the user directed continued work on the full plan.
The active wave is #81, #86 and #101, each in its own worktree from 77e4ac65.
Root is setting up Emscripten 5.0.7 and OCCT V8_0_1 under #81's cpp/build through WSL;
CMake is installed locally in that build folder. No system packages or save schemas are changed.

The latest develop baseline already includes opt-in hybrid worker booleans (workerClient,
workerKernel, hybridShapeFactory). The older kernel docs and audit predate that implementation.
#96–#98/#92 must extend this infrastructure rather than introduce a duplicate kernel protocol.
Current gaps remain: no bounded timeout, cancellation does not interrupt executing native work,
worker native failure is latched, and MCP run_program still uses synchronous native execution.

#86 reuses the existing saved EdgeRef shape through a runtime query/selection API; #101 reuses
existing MeshNode and Material payloads via a distinct STL mesh import. Neither needs migrations.