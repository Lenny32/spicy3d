Mouse modeling project: guided geometry, corner controls and reliable MCP workflows

The mouse modeling workflow now has associative 3D path sweeps, directional surface projection,
support-normal grooves/ribs, guided lofts and independently editable fillet corner setbacks. UI and
MCP workflows retain referenced inputs across compatible upstream edits, validate geometry before
committing, and support cancellation and undo. Weighted sketch NURBS, variable fillets, curved-face
extrusion starts and next-face extents extend the modeling tools.

Persistent edge references/selectors, dependency-aware caches and compact MCP responses improve
repeatable agent modeling. Expensive worker operations have bounded execution, cancellation,
transactional rollback and committed metadata reads. Reference STL meshes support sampled
deviation measurements; exports support tessellation controls, bounded bytes and separate files
in one archive. Main-kernel recovery preserves committed state for supported synchronous replays.

All 26 issues #81–#106 are implemented, reviewed, tested and pushed on this branch. This is the
single integration PR; it is ready for the boss's review and must remain unmerged. Issues retain
their open state and original labels. The [durable checklist](https://github.com/Lenny32/spicy3d/blob/enhancement-mouse-project/docs/reports/mouse-project-checklist.md)
records dependencies, full integration SHAs and validation.

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
| #90 | Support-normal groove/rib with tracked join/cut and editable UI/MCP | 76245a90b2935df7ea0d207a82ebbcb67e585103 |
| #85 | Associative spine/boundary guided loft with editable UI/MCP and proven references | b3237da250b0477afd0ab25cf561dac3801beba7 |
| #84 | Independent corner setbacks with worker preview, atomic edits and background MCP jobs | c6b23b528404c1a303fbcff8630f5fe82db64592 |

Validation: **9,836 passing tests across 605 files, one skip, no failures**. TypeScript and Biome
checks across all changed source files pass. The production app and all three plugins build.
Actual Chromium 153/Firefox 155 worker and recovery checks pass; the built app's offline kernel,
local save/open, deployment banners and external-URL checks pass. Recovery tests inject a fatal
generation; the original scan-specific failure is not claimed as reproduced. Existing lint,
bundle-size and Windows libuv worker-exit diagnostics remain; the test process exits successfully.

Approved backward-compatible migrations end at document **2**, parametric **13**, sketch **3**.
Existing compatibility fixtures remain untouched; new immutable fixtures, atomic payload rules,
device/cloud round-trips and merge validation cover the additions. Unknown payloads and userData
remain preserved. Older releases need not open newly saved files.

Initial corner scope is one eligible three-edge junction with a constant radius and three separate
distance expressions. Accepted fits take about 60–64 seconds and use a strict 90-second worker
deadline; unsupported or over-budget fits fail explicitly. **Current synchronous kernel recovery
refuses corner-setback documents atomically**, preserving committed payload, IDs and history;
these documents require reopening saved content in a fresh page. Loading and headless merge
validation rebuild corners asynchronously. See [corner implementation](https://github.com/Lenny32/spicy3d/blob/enhancement-mouse-project/docs/reports/mouse-84-implementation.md).

Initial guided mode supports C2, 2–16 planar hole-free sections, one open spine and controlling
boundary, at most 128 pieces per path and 512 side faces. All unguided continuity/ruled/solid options
remain unchanged. Ambiguous topology is explicitly untracked; incompatible full-curve coverage
fails rather than moving or dropping sections. See [guided loft implementation](https://github.com/Lenny32/spicy3d/blob/enhancement-mouse-project/docs/reports/mouse-85-runtime-implementation.md).

Refs #81, #82, #83, #84, #85, #86, #87, #88, #89, #90, #91, #92, #93, #94, #95, #96, #97, #98, #99, #100, #101, #102, #103, #104, #105, #106.
Keep issues open and never merge this PR automatically.
