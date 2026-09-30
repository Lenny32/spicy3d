Mouse modeling project: correctness fixes and MCP efficiency

Appended join/cut extrusion operations now retain the caller's feature name, and large subshape
queries keep every returned reference usable. The integration also adds compact parametric
responses and reuses feature geometry when unrelated document variables change.
Persistent MCP edge references also survive upstream topology reordering across separate calls.

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

Validation: 9,181 passing tests across 542 files, one skip; production build, TypeScript and required
repository check pass. Windows validation requires Git's POSIX shell on PATH and bounded Rstest
concurrency. Existing lint and bundle-size warnings remain. All four opening integrations are validated and pushed; their issues are marked [done] and remain open. Scan-specific historical failures remain unconfirmed without original data.

No save payloads, schema versions, migrations or merge rules change in this opening implementation.
The shared schema plan reserves root ownership of versions/migrations before overlapping modeling
features start. Backward-compatible format changes for the project's remaining tickets were
approved in mouse-plan.md and require the compatibility evidence described there.

Additional #86 validation: 127 worker tests, 57 integrated tests, TypeScript and required check pass.

Remaining project work: #81–#85, #87–#90, #92–#98, #101–#105 (21 tickets). Next correctness work is #81/#82;
C++ changes require setting up/rebuilding WASM because no local emsdk/OCCT build tree is present.
Worker work follows KERNEL-01, with one shared cancellation/recovery protocol before splitting it.

Refs #106, #100, #99, #91, #86. Keep issues open and never merge this PR automatically.
