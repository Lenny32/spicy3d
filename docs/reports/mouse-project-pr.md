Mouse modeling project: parametric geometry, kernel recovery and MCP workflows

This integration adds associative 3D path sweeps and directional surface projection, with editable
profiles, paths and targets. It also adds weighted sketch NURBS, variable-radius fillets, exact curved-face
extrusion starts and automatic next-face extents. Corner operations reject invalid geometry with
actionable diagnostics. Persistent edge references and selectors survive compatible upstream edits;
feature caches track actual variable dependencies, and appended extrusions retain caller names.

Expensive program operations run in bounded cancellable workers with transactional rollback and
live background status. A fresh main kernel can reconstruct open documents without reloading,
preserving committed edits and identities. Reference STL meshes bypass CAD conversion and support
sampled deviation measurement. Exports offer tessellation controls, bounded bytes and separate files
in one archive; compact MCP responses reduce repeated feature-list output.

This is the single draft integration PR for the 26-ticket mouse project. Keep it draft while the
remaining work is queued. Follow [the durable checklist](https://github.com/Lenny32/spicy3d/blob/enhancement-mouse-project/docs/reports/mouse-project-checklist.md)
for dependencies, ticket status, full integration SHAs and validation.

| Ticket | Behavior | Integration commit |
| --- | --- | --- |
| #106 | Preserve appended feature names and existing body names | e9b6d1b078f74c90deac96b7620dcb9f4808cf20 |
| #100 | Bound reference descriptors and retain entire list-query families | 2df0ca446ccaae926f630881ef2c2a3373324ab8 |
| #99 | Explicit compact response mode; default full response remains | ba9a096c5e8ccb49262c874cfaef9d3074ac67d2 |
| #91 | Cache keys depend on actual variable reads, including transitive values | 9c18b315741371a09d9b5a0d5679a056b2bced57 |
| #86 | Body-scoped persistent edge query and fillet/chamfer selections | 91f48b5e47ac39c510a31a0dd0546874f226b224 |
| #101 | Binary/ASCII STL reference mesh import without kernel conversion | 73abad86b68290bf386951c62a0df85d82684ffa |
| #87 | Stable edge selectors by topology, feature origin and analytic geometry | ca359de87e2b1b52e6d2132bd679d9fbb6e4b322 |
| #104 | Optional bounded base64 export bytes with filename/MIME metadata | 93c7fc625535192ee3d4f9b2a5cb15113e4258d2 |
| #81 | Reject invalid tracked/untracked native fillet/chamfer results | 0b8655a0701c86211723a4fe4dc1980f4ea95922 |
| #105 | One ZIP with separate model files and per-output errors | 82189d89ae8f62f39c2bdf06a6055c47cb3ff8d4 |
| #102 | Sampled model-to-reference mesh deviation in UI and MCP | 9305b007de052d3463c44993185c44dfaceffb0a |
| #93 | Editable control-pole and weighted sketch NURBS | 9d2acd98b606c739832e6fbd87e018a803202f06 |
| #96 | Bounded worker operations with transactional rollback and responsive metadata | dadd98ce831e8ef831c3e415c3596979bb0531a8 |
| #82 | Native corner preflight and actionable OCCT construction diagnostics | c316e7b99e7368f605e1793c7a85dbbbc35cd6b2 |
| #97 | Terminate in-flight native workers and roll back cancelled programs | 5c6728d30a1995f787a75f030b32c57973add2a1 |
| #103 | Isolated STL linear/angular tessellation controls in UI and MCP | 16a7b3796fb0a46b5f1130993409302bdb932639 |
| #92 | Runtime background programs, live status/cancellation and retained results | 55abf61354b2c0e6750655a35de7dfafac71932a |
| #94 | Associative curved-face extrusion starts with exact caps | 3c5cf59763791d8f3a4314cf9460569b7776bbad |
| #83 | Editable expression-based variable-radius fillets | 948b0d5a85576d788e16f6115085817da2c544af |
| #95 | Automatic exact next-face extrusion with bounded search | d3c3715ffce28f8eeb0410b17b808049a17e0cc7 |
| #98 | Reconstruct open documents in a fresh kernel without reloading | 9f3b108a36f3b889197f286d47cfafa7b617b317 |
| #88 | Associative path sweep with real section/path history and editable UI/MCP | c6963df7eab1e0ceeb29c1a2b8756a28a461f630 |
| #89 | Associative directional projection with complete trimmed-face coverage | 279b538db3f00c5b26b55ce37f45c791b3afb54b |

Validation: 9,650 passing tests across 583 files on the latest combined integration, one skip; production build, TypeScript and required
repository check pass. Windows validation requires Git's POSIX shell on PATH and bounded Rstest
concurrency. Existing lint and bundle-size warnings remain. All 23 listed integrations are validated
and pushed; their issues are marked [done] and remain open. Scan-specific historical failures remain
unconfirmed without original data.

Control-pole NURBS adds the directly approved optional sketch control layout at sketch version 3,
with a pure identity migration, atomic merge rule and new fixture. Existing documents remain
readable. The document envelope stays at version 2. Further payload changes follow the shared
schema plan and the user-approved backward-compatibility requirements.

Additional #86 validation: 127 worker tests, 57 integrated tests, TypeScript and required check pass.
Additional #101 validation: 109 worker and integrated tests, TypeScript and required check pass.
Additional #87 validation: 138 worker tests, 65 integrated tests, TypeScript and required check pass.
The production app and all three plugins also build after #86/#101.
Additional #104 validation: 34 worker/integrated tests, isolated/root TypeScript and scoped check pass.
Additional #81 validation: rebuilt Emscripten 5.0.7 / OCCT V8_0_1 artifacts, 182 worker/integrated kernel
tests, TypeScript and required check pass.
Additional #105 validation: 43 worker/integrated tests, isolated/root TypeScript and required check.
Additional #102 validation: 170 worker tests, 49 integrated tests, TypeScript and required check.

Additional #93 validation: 1,186 worker tests and 182 focused integration tests, including old fits,
weighted native parity, UI undo, migrations, merge and cloud history/document paths.
Additional #96 validation: actual Chromium/Firefox workers, exact program rollback and committed
metadata reads; combined full suite, TypeScript, lint and production app/plugins pass.
Additional #82 validation: pinned native rebuild, 163 worker and 183 integrated native/worker tests.

Additional #97 validation: 1159 worker tests, 37 integrated checks, TypeScript and required lint;
actual native-entry cancellation in Chromium/Firefox, old-handle rejection and fresh geometry.

Additional #103 validation: 247 worker and 111 integration tests, rebuilt native artifacts,
TypeScript and required lint. Actual curved fidelity/coarsening, physical units and CAD/cache
immutability checks pass. Custom tessellation remains synchronous and is approximation control.

Additional #92 validation: 462 worker regressions and the full9423-test suite pass (one skip),
TypeScript, required lint and production app/plugins. Existing parametric background rebuild
status is observable; run_parametric remains synchronous. Runtime job state is bounded and
caller/document-scoped, with queue ordering and rollback unchanged.

Additional #94 validation: 490 worker tests, 128+41 focused integration tests, exact curved caps,
timeline/reference continuity and native oblique-profile coverage. Approved parametric6 migration,
merge rules and cloud fixture roundtrip pass.
Additional #83 validation: 230 worker tests, native radius/direction/periodic/tangent-contour proof,
editable UI undo, expressions, migrations and cloud merge/roundtrip. Approved parametric7 migration
and atomic radius law; natural parameter direction may change after upstream reparameterization.

Additional #95 validation: 234 worker tests; exact curved/thin-wall caps, timeline retargeting,
UI/MCP editing, native budgets, atomic merge and all historical fixtures. Approved parametric8
migration and new fixture. Initial scope requires one uniformly nearest full face per profile.
Additional #98 validation: 212 recovery and 150 existing modeling regressions, plus actual app
startup/UI recovery in Chromium153 and Firefox155. Committed edits, stable IDs, references and
dirty/view/camera state survive. User explicitly approved clearing undo/redo after successful
reconstruction. Failed preparation is atomic; old native handles never revive. Browser tests
inject a fatal-generation state rather than claiming a reproduced scan-specific crash.

Additional #88 validation: 293 worker tests, 144 focused integration tests and 314 native/fixture
checks, pinned native rebuild, TypeScript and required lint. Actual upstream edits, tracked
cap/seam identity, UI undo and distinct MCP JSON-reference calls pass.
Additional #89 validation: 171 worker tests and 103 combined sweep/projection integration tests;
TypeScript, required lint, exact curved coverage, ancestry, UI undo and MCP reference roundtrips.
Approved parametric versions 9 and 10 add pure migrations, atomic merge rules and immutable
fixtures. Existing fixtures remain unchanged; document envelope 2 and sketch 3 remain.

Remaining project work: #84, #85 and #90 (3 tickets). Three implementation agents are continuing
concurrently. Strict asymmetric setback geometry and two/three-section guided-loft proofs pass;
product integration and compatibility work continues. Face sweep is implementing actual support
normal framing and tracked join/cut. 23 tickets are delivered. Keep this PR draft until all 26
are complete and reviewed.

Refs #88, #89, #106, #100, #99, #91, #86, #101, #87, #104, #81, #105, #102, #82, #93, #96, #97, #103, #92, #94, #83, #95, #98.
Keep issues open and never merge this PR automatically.
