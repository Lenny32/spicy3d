Mouse modeling project: correctness fixes and MCP efficiency

Appended join/cut extrusion operations now retain the caller's feature name, and large subshape
queries keep every returned reference usable. The next integrated changes add compact parametric
responses and reuse feature geometry when unrelated document variables change.

This is the single draft integration PR for the 26-ticket mouse project. Keep it draft while the
remaining work is queued. Follow [the durable checklist](docs/reports/mouse-project-checklist.md)
for dependencies, ticket status, full integration SHAs and validation.

| Ticket | Behavior | Integration commit |
| --- | --- | --- |
| #106 | Preserve appended feature names and existing body names | e9b6d1b078f74c90deac96b7620dcb9f4808cf20 |
| #100 | Bound reference descriptors and retain entire list-query families | 2df0ca446ccaae926f630881ef2c2a3373324ab8 |
| #99 | Explicit compact response mode; default full response remains | Pending review/integration |
| #91 | Cache keys depend on actual variable reads, including transitive values | Pending review/integration |

Validation so far: 9,154 passing tests across 541 files, one skip; production build and required
repository check pass. Windows validation requires Git's POSIX shell on PATH and bounded Rstest
concurrency. Existing lint and bundle-size warnings remain. Final integrated counts follow once
#99 and #91 are merged. Scan-specific historical failures remain unconfirmed without original data.

No save payloads, schema versions, migrations or merge rules change in this opening implementation.
The shared schema plan reserves root ownership of versions/migrations before overlapping modeling
features start. Backward-compatible format changes for the project's remaining tickets were
approved in mouse-plan.md and require the compatibility evidence described there.

Remaining project work: #81–#90, #92–#98, #101–#105 (22 tickets). Next correctness work is #81/#82;
C++ changes require setting up/rebuilding WASM because no local emsdk/OCCT build tree is present.
Worker work follows KERNEL-01, with one shared cancellation/recovery protocol before splitting it.

Refs #106, #100, #99, #91. Keep issues open and never merge this PR automatically.
