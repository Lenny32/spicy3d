# #89 associative curve projection

Implementation branch: `mouse/89-associative-projection`, based on completed #95 and root
`68cabb17`. The concrete saved shape and version reservation are approved in
`docs/reports/mouse-schema-plan.md` (#89, parametric 10 after sweep's parametric 9).

## Source/UI checkpoint

The geometry, reference resolver, semantic output IDs, feature handler, command, editor and
program/MCP operation are implemented. Creation and editing preview exact forward projection,
support numeric world direction components and reversal, and refuse invalid previews.
Repicking preserves feature identity. Confirmation records one undo step; cancellation does
not change committed features. Source and target remain available for upstream editing.

The shared path resolver comes from #88 checkpoints. Source logical seeds combine every actual
piece ancestor, and untracked/authored-only geometry is rejected for persistent projection
output identity. The target resolver requires exactly one trimmed face, honors placement and
pre-consumption timeline states, and reanchors actual matched source/target references. Cache
dependencies read entering timeline state instead of a consuming body's final geometry.

Existing native projection is intersected with exact positive swept sheets. Source and output
are projected onto a transverse plane; common-curve lengths establish complete coverage and
reject behind, disjoint, partial, folded or multiple forward branches. Tests include a target
hole whose endpoints are valid while its interior removes coverage. Assembly copies cannot be
matched by ordinary circle fingerprints when a seam splits one circle into arcs: exact full
curve overlap transfers their unique source ancestry. Bounds prune comparisons; limits are
256 logical source references, 512 output pieces and 8192 ancestry comparisons.

No native source or artifact change is needed. Outputs are curve/wire bodies, with semantic
edge IDs suitable for later face-sweep consumers. IDs combine feature/node provenance and
actual source/target ancestor leaves. Split pieces honestly share logical identity.

Validation: 126/126 tests across eight kernel files, including 45 projection/shared-reference
tests; local-worktree aliases used to avoid root workspace symlink mixing. Local-alias TypeScript
check and scoped `npm run check` passed. Actual MCP calls query persistent source references,
round-trip them through JSON, edit upstream geometry and create the projection in a later call.
UI tests prove create, reverse, invalid direction, cancel, repick and undo behavior.

## Remaining integration

The source/UI checkpoint intentionally awaits #88's committed parametric 9 foundation before
registering parametric 10. Add the pure 9→10 identity migration, atomic source/target merge rule,
NEW immutable document fixture, old-document compatibility and manifest/cloud roundtrip proof.
Do not publish the feature checkpoint before those owning-version changes are integrated.
Further regression verification follows that foundation. Existing fixtures remain immutable.
