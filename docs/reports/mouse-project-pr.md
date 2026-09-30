Mouse modeling project: correctness fixes and MCP efficiency

Appended join/cut extrusion operations now retain the caller's feature name, and large subshape
queries keep every returned reference usable. The integration also adds compact parametric
responses and reuses feature geometry when unrelated document variables change.
Persistent MCP edge references also survive upstream topology reordering across separate calls.
STL scans can be imported directly as lightweight ghost reference meshes through the ribbon or MCP.

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

Validation: 9,181 passing tests across 542 files, one skip; production build, TypeScript and required
repository check pass. Windows validation requires Git's POSIX shell on PATH and bounded Rstest
concurrency. Existing lint and bundle-size warnings remain. All four opening integrations are validated and pushed; their issues are marked [done] and remain open. Scan-specific historical failures remain unconfirmed without original data.

No save payloads, schema versions, migrations or merge rules change in this opening implementation.
The shared schema plan reserves root ownership of versions/migrations before overlapping modeling
features start. Backward-compatible format changes for the project's remaining tickets were
approved in mouse-plan.md and require the compatibility evidence described there.

Additional #86 validation: 127 worker tests, 57 integrated tests, TypeScript and required check pass.
Additional #101 validation: 109 worker and integrated tests, TypeScript and required check pass.
Additional #87 validation: 138 worker tests, 65 integrated tests, TypeScript and required check pass.
The production app and all three plugins also build after #86/#101.
Additional #104 validation: 34 worker/integrated tests, isolated/root TypeScript and scoped check pass.
Additional #81 validation: rebuilt Emscripten 5.0.7 / OCCT V8_0_1 artifacts, 182 worker/integrated kernel
tests, TypeScript and required check pass.

Remaining project work: #82–#85, #88–#90, #92–#98, #102/#103/#105 (17 tickets). Next correctness work is #82;
C++ changes require setting up/rebuilding WASM because no local emsdk/OCCT build tree is present.
Worker work follows KERNEL-01, with one shared cancellation/recovery protocol before splitting it.

Refs #106, #100, #99, #91, #86, #101, #87, #104, #81. Keep issues open and never merge this PR automatically.
