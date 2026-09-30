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
| #81 Reject invalid fillet and chamfer results | — | Done (pushed) | mouse_81 | mouse/81-valid-corners | Pinned native rebuild; 182 worker/integrated tests; tsc/check | 0b8655a0701c86211723a4fe4dc1980f4ea95922 | — |
| #82 Report actionable fillet and chamfer failure diagnostics | #81 | Done (pushed) | root | mouse/82-corner-diagnostics | Pinned native rebuild; 163 worker/183 integrated tests; tsc/check | c316e7b99e7368f605e1793c7a85dbbbc35cd6b2 | — |
| #83 Support variable-radius fillets | #81, #82; parametric 7 | Done (pushed) | mouse_101 | mouse/83-variable-fillet | 230 worker tests; full9495pass1skip; tsc/check/build/native rebuild | 948b0d5a85576d788e16f6115085817da2c544af | — |
| #84 Support fillet corner setbacks | #81, #82; shared schema | Native feasibility proof | mouse_101 | mouse/84-corner-setbacks | Independent trimmed corner patch proof; no payload change yet | — | Free-form support feasibility |
| #85 Support guide and boundary curves in parametric lofts | Shared schema; kernel feasibility | Native feasibility proof | mouse_86 | mouse/85-guide-loft | Rebuilt auxiliary-guide contact proof rejects incompatible construction; no saved schema yet | — | Exact guide/section contact feasibility |
| #86 Expose persistent edge references through MCP | #100 | Done (pushed) | mouse_86 | mouse/86-persistent-edges | 127 worker tests; 57 integrated tests; tsc/check | 91f48b5e47ac39c510a31a0dd0546874f226b224 | — |
| #87 Add rule-based edge selection through MCP | #86 | Done (pushed) | mouse_86 | mouse/87-edge-selectors | 138 worker tests; 65 integrated tests; tsc/check | ca359de87e2b1b52e6d2132bd679d9fbb6e4b322 | — |
| #88 Add a parametric sweep along a 3D path | Reserved parametric 9 | Feature/UI/MCP implementation | mouse_81 | mouse/88-associative-path-sweep | 43 native/history tests; ordered associative resolver checkpoints | — | Final feature and compatibility validation |
| #89 Add associative curve projection onto surfaces | Reserved parametric 10 after #88 | Feature/UI/MCP implementation | mouse_86 | mouse/89-associative-projection | 34 geometry/reference tests plus two real rebuild tests; tsc | — | #88 version registration before migration |
| #90 Add a parametric groove or rib along a curve on a face | #88, #89 | Assigned after sweep | mouse_81 | — | Pending | — | Upstream sweep/projection integration |
| #91 Invalidate feature caches only for dependent variables | — | Done (pushed) | mouse_91 | mouse/91-dependent-cache | 154 worker regressions; 131 integrated cache/kernel tests; typecheck/check | 9c18b315741371a09d9b5a0d5679a056b2bced57 | — |
| #92 Expose asynchronous rebuild progress through MCP | #96, #97 | Done (pushed) | root | mouse/92-async-progress | 462 worker regressions; full9423pass1skip; tsc/check/build | 55abf61354b2c0e6750655a35de7dfafac71932a | — |
| #93 Support control-point and weighted NURBS in parametric sketches | Approved sketch 3 schema | Done (pushed) | mouse_86 | mouse/93-control-nurbs | 1186 worker/182 focused integrated tests; full suite/tsc/check/build | 9d2acd98b606c739832e6fbd87e018a803202f06 | — |
| #94 Add an associative from-face extrusion start | Parametric 6 | Done (pushed) | mouse_86 | mouse/94-from-face | 490 worker tests; 128+41 focused integration; full9495pass1skip; native/tsc/check/build | 3c5cf59763791d8f3a4314cf9460569b7776bbad | — |
| #95 Add automatic up-to-next-face or body extrusion extent | #94; parametric 8 | Done (pushed) | mouse_86 | mouse/95-to-next | 234 worker tests; full9560pass1skip; native/tsc/check/build | d3c3715ffce28f8eeb0410b17b808049a17e0cc7 | — |
| #96 Run expensive kernel operations in a bounded worker | KERNEL-01 architecture | Done (pushed) | mouse_81 | mouse/96-bounded-worker | Real browser worker; 9356 integrated tests, 1 skip; tsc/check/build | dadd98ce831e8ef831c3e415c3596979bb0531a8 | — |
| #97 Cancel an in-flight kernel operation | #96 | Done (pushed) | mouse_81 | mouse/97-cancel-worker | 1159 worker tests; 37 integrated tests; real Chromium/Firefox cancellation; tsc/check/build | 5c6728d30a1995f787a75f030b32c57973add2a1 | — |
| #98 Recover a crashed kernel without reloading the tab | #96, #97 | Done (pushed) | mouse_81 + root UI | mouse/98-main-kernel-recovery | 212+150 worker tests; full9560pass1skip; actual Chromium/Firefox app recovery; tsc/check/build | 9f3b108a36f3b889197f286d47cfafa7b617b317 | — |
| #99 Add compact run_parametric responses | #106 (shared program file) | Done (pushed) | mouse_99 | mouse/99-compact-responses | 54 integrated MCP/program tests; typecheck/check | ba9a096c5e8ccb49262c874cfaef9d3074ac67d2 | — |
| #100 Do not return subshape references already evicted from the ref store | — | Done (pushed) | mouse_100 | mouse/100-subshape-refs | 95 integrated capability/skill tests; check | 2df0ca446ccaae926f630881ef2c2a3373324ab8 | — |
| #101 Import scan files as lightweight reference MeshNodes | — | Done (pushed) | mouse_101 | mouse/101-reference-mesh | 109 worker and integrated tests; tsc/check | 73abad86b68290bf386951c62a0df85d82684ffa | — |
| #102 Measure CAD-to-reference-mesh deviation | #101 | Done (pushed) | mouse_101 | mouse/102-scan-deviation | 170 worker tests; 49 integrated tests; tsc/check | 9305b007de052d3463c44993185c44dfaceffb0a | — |
| #103 Expose STL linear and angular tessellation tolerances | #104/#105 export surface | Done (pushed) | mouse_101 | mouse/103-stl-tolerance | 247 worker/111 integrated tests; rebuilt kernel; tsc/check | 16a7b3796fb0a46b5f1130993409302bdb932639 | — |
| #104 Return exported model bytes or a resource through MCP | Serialize export API | Done (pushed) | root | mouse/104-export-bytes | 34 worker/integrated tests; isolated/root tsc; check | 93c7fc625535192ee3d4f9b2a5cb15113e4258d2 | — |
| #105 Batch-export separate model files without repeated downloads | #104 | Done (pushed) | root | mouse/105-batch-export | 43 worker/integrated tests; isolated/root tsc; check | 82189d89ae8f62f39c2bdf06a6055c47cb3ff8d4 | — |
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

#86 is integrated: the `edges` query returns body-scoped persistent references, and fillet/chamfer
accept `edgeRefs` across calls. Real-kernel regressions prove references survive actual index drift
after an extrusion edit and boolean cut; malformed, wrong-body, unresolved and ambiguous refs fail
before feature append. Five tickets are delivered; 21 remain. #87 is now active after #86.

The initial OCCT compilation on `/mnt/d` was too slow. The pinned toolchain and final #81 sources
are being copied to a unique WSL `/tmp/spicy3d-mouse-native.*` build directory; release artifacts
will be copied back to #81's worktree before native regression validation and integration.

#101 is integrated: a separate STL reference-mesh import skips OCCT and creates an existing MeshNode
with ghost opacity, placement and visibility. Binary/ASCII parsing, malformed input, millimetre/unit
conversion, saved-class roundtrip and undo/redo pass. MCP imports raw base64 up to 32 MiB; the ribbon
entry assumes mm. Six tickets are delivered; 20 remain. #102 now adds sampled mesh deviation metrics.

#96 architecture is approved: extend the existing worker protocol with a whitelisted BREP factory
operation boundary, finite 90-second deadlines and worker generation teardown/recreation. Program
mutations remain serialized and use asynchronous transactions with exact reference rollback;
safe metadata reads expose committed state while geometry is pending. Runtime editing locks block
interactive mutations during the transaction. Existing hybrid parametric opt-in stays unchanged.
Worker cancellation, full main-kernel recovery and async progress remain separate #97/#98/#92 tasks.

#87 is integrated: selectors intersect feature origin, adjoining face sets, outer-wire/curve
membership, radius and full-edge elevation. They return persistent refs with empty/ambiguous
diagnostics and report unselectable degenerate edges. Real-kernel tests exclude holes from outer
outlines and distinguish cylinder rims from sphere/torus edges. Seven tickets delivered; 19 remain.
The app and all three plugins build after #86/#101. #104 is active in root's isolated worktree;
#93's concrete sketch-3 schema is approved in [mouse-schema-plan.md](mouse-schema-plan.md), with
sketch-only migration/rule/fixture ownership assigned to mouse_86 before implementation.

#104 is integrated: `export_nodes` optionally returns exact base64 file bytes with filename, MIME
and decoded-size metadata. Default browser download remains. The decoded-byte budget defaults to
1 MiB (caller cap 8 MiB); the escaped relay response is checked too. Paths are rejected explicitly.
34 integration tests cover byte equality, UTF-8/binary/blob parts, metadata, limits and downloads;
isolated/root typechecking and scoped check pass. Eight tickets delivered; 18 remain.

Pinned #81 native build completed and all three generated artifacts were copied into its worktree.
All 182 native integration tests pass. The four tracked/untracked fillet/chamfer paths reject null
or invalid B-reps before exposing shape/history; four additional Bezier-perimeter-throughcut cases
remain valid. Nine tickets delivered; 17 remain. Native JS/declarations were staged with the binary
but are semantically unchanged because this fix adds no bindings.

The automatic approval reviewer initially rejected #93 because file-based approval was insufficient.
The user directly answered **"Approve the plan’s backward-compatible format changes"** to the
explicit question covering necessary #81–106 changes, including concrete sketch-3 control data.
That direct user-turn authorization resolves the rejection; implementation proceeds under the
coordinated schema plan and old-document compatibility requirements.

#105 is integrated: separate model files are delivered in one ZIP through browser download or
bounded base64. Deterministic filenames avoid paths/case collisions; per-output failures preserve
successful files and an all-failed batch creates no empty download. 43 integration tests pass.

#102 is integrated: deterministic area-weighted model samples use exact nearest-triangle BVH
queries against the reference mesh. UI and MCP report mean/RMS/maxSampledDeviation in mm, with
transient worst-gap visualization. It is unsigned, one-way and tessellation/sample dependent,
not a certified exact CAD-surface distance or continuous maximum. 49 focused integration tests
include actual OCCT/STL placement, cancellation, stale results and a 100,000-triangle reference.
Eleven tickets delivered; 15 remain. #82 diagnostics, #93 NURBS, #96 workers and #103 tolerance
are active. Recreated native caches use WSL /var/tmp plus a workspace archive backup after the
earlier /tmp build directory disappeared; the completed #81 binary is unaffected.

#82, #93 and #96 are integrated and published. The combined #93/#96 suite passes 9,356 tests
with one skip; TypeScript, scoped required checks and production app/plugins pass. #82 adds 12
real-kernel diagnostics tests; 183 combined native/worker regressions pass on its rebuilt kernel.
Fourteen tickets delivered; 12 remain. #94 uses the approved parametric-6 schema; #97 cancellation
and #103 STL tolerance remain active. Existing document version 2 stays; sketch is now version 3.

#97 is integrated and pushed: strict native cancellation terminates the worker generation,
rolls back exact document/reference/history state and releases the queue for subsequent work.
Integrated real-browser native-entry tests settle in 0.4 ms (Chromium) / 0 ms (Firefox), reject old
handles and prove fresh native geometry. 37 focused tests, tsc and scoped check pass. Fifteen
tickets delivered; 11 remain. Main-kernel recovery is being designed separately under #98.

#103 is integrated and pushed: custom linear-mm/angular-degree STL tolerances remesh an
independent native copy. Cylinder/sphere fidelity, repeatable coarsening, physical mm/cm units
and exact CAD/BREP/display-cache/default-STL preservation pass. 247 worker and 111 integrated
tests, TypeScript and required check pass. Sixteen tickets delivered; 10 remain. #83 is reserved
for parametric7 after #94; root implements92 while98recovery prepares independent infrastructure.

#92 is integrated and pushed: append-only background program jobs return live operation counts
and retained completion results; status/cancel bypass the shared mutation FIFO by private
built-in identity. Caller/document binding, copied input, session-end cancellation, native rollback,
deadlines and bounded retention are tested. Existing parametric background rebuild status exposes
pending jobs/known feature indexes; run_parametric itself remains synchronous. 462 worker
regressions and the combined 9,423-test suite pass (one skip), plus tsc/check/app+plugin build.
Seventeen tickets delivered; nine remain.

#94 and #83 are integrated and pushed. Extrusions can begin on an associative curved face with
exact caps; native planar-profile validation also covers oblique directions. Fillets accept an
editable expression-based normalized arc-length radius law with explicit OCCT interpolation and
direction limitations. Parametric versions 6 and 7 have pure migrations, atomic merge rules and
new immutable fixtures. Combined validation: **9,495 tests pass, one skip**; TypeScript, capability
generation, scoped check and production app plus all three plugins pass. Nineteen tickets delivered;
seven remain. #95, #84 and #98 are delegated concurrently, with root reviewing integration and UI.

#95 and #98 are integrated and pushed. Automatic next-face extrusions recompute the uniformly
nearest complete trimmed face, including curved thin walls; ambiguous or partial caps fail.
Main-kernel recovery prepares every open document before publication, preserves committed edits,
IDs, references and dirty state, and clears undo/redo only after successful reconstruction as
directly approved. Failed preparation leaves the original state. Retired native handles remain
unusable. UI and MCP recovery plus post-recovery variable edits/undo/redo are validated.

Combined validation: **9,560 tests pass across 573 files, one skip**; TypeScript, capability
generation, scoped check and production app plus all three plugins pass. The actual app's Recover
button replaces the native module in Chromium 153 and Firefox 155, preserving two documents,
unsaved names, dirty state, view/camera and valid volumes. These tests inject a fatal-generation
state; they do not claim a reproduced scan-specific native crash.

**21 of 26 tickets delivered.** Remaining: #84, #85, #88, #89, #90. All three delegated agents
reported "Your workspace is out of credits" and stopped. Their worktrees and partial changes
are preserved. #89 has committed geometry/reference checkpoints `c0317e540bea11bf46d2ca8f5c55698b35138ec6`
and `b1b966bc1089f29d22c201ff68c74d7e90bce580`; these are not a completed projection feature.
#84 experiments have not produced an accepted valid solid; see
[native research](mouse-84-native-research.md). #85's auxiliary-guide proof source is uncompiled.
Do not mark these remaining tickets done. Resume delegated work after workspace credits are restored.

The user resumed work and explicitly requested delegation and completion while away. All three
implementation agents are running again in isolated worktrees. The interruption above is historical.
#88 now has a rebuilt tracked sweep with straight, nonplanar, rounded and closed-path proofs;
feature identity, editing and compatibility work continues. #89 has exact directional coverage and
source/target ancestry checks plus actual upstream-edit rebuild tests; its version-10 registration
waits for #88's version 9. #85 is delegated to mouse_86 alongside projection: the first rebuilt
auxiliary-contact construction fails explicitly, so it is not an accepted loft implementation.
#84's corrected equal-setback experiment produces one valid solid but is too slow for delivery;
the agent is testing a constrained multi-patch construction without relaxing geometric tolerances.
#90 is assigned to mouse_81 after sweep. Root coordinates native builds, reviews, integration and
publication. These five tickets remain unfinished, and PR #107 remains draft.
