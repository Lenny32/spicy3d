# Mouse project implementation plan

Implement and orchestrate GitHub issues **#81–#106** in `Lenny32/spicy3d` using sub-agents in small waves of **2–3 concurrent workers**.

- Repository: `D:\git\Personal\spicy3d`
- Integration branch: `enhancement-mouse-project`
- Final PR target: `develop`
- Audit report: `docs/reports/mcp-user-report-2026-09-30.json`

Read `AGENTS.md`, the actual GitHub issues, and the audit report before implementing changes. Preserve this plan and the audit report if untracked, and include them in the integration branch. Recheck current code and issue status: some reported capabilities already exist.

## 1. Non-negotiable restrictions

**Never push to `develop` or `main`. Never push while checked out on either. Never merge the final PR.** Only the boss may put this work into `develop`. Use explicit push destinations; never use `--all` or `--mirror`.

Do not discard existing user changes, rewrite unrelated commits, or overwrite an existing integration branch. Inspect existing work first.

### Explicit boss approval for save-format changes

The boss has explicitly authorized format changes necessary for issues #81–#106, provided **backward compatibility** is preserved. This task-specific approval supersedes the earlier frozen-format prohibition for these changes.

The updated app must open all previously supported documents and cloud versions without losing data. **Older application releases do not need to open newly saved files.** This approval does not authorize unrelated format redesign.

- Implement pure, versioned migrations as required by `AGENTS.md`; bump the owning module version when its payload changes, and the document version only when the envelope changes require it.
- Preserve unknown-node payloads and `userData`.
- Keep existing compatibility fixtures unchanged; add new fixtures and meaningful migration/round-trip tests.
- Update affected merge rules and verify cloud history, restore, compare and merge paths as appropriate.
- Ensure existing features retain their intended behavior after migration.
- Treat changes inside `featuresJson` and `dataJson` as saved-payload changes, even though the outer fields remain strings.

The orchestrator must coordinate one shared schema/version plan before sub-agents implement overlapping changes. Record the approved scope, affected payloads, migrations and compatibility validation. No additional boss approval is needed for necessary changes covered by this authorization.

Likely affected tickets: #83–#85, #88–#90 and #93–#95. Confirm the actual requirements through design; preserve the existing format wherever a task does not need changes.

## 2. Branch setup and visibility

Fetch `origin` and create `enhancement-mouse-project` from `origin/develop`. If the branch already exists, inspect it and resume compatible work.

Use this branch as the integration base for every ticket. After the first meaningful integration, push it and open exactly **one draft PR**:

`enhancement-mouse-project` → `develop`

Update the same PR throughout the project. Create no per-ticket PRs. Leave the PR unmerged for the boss.

## 3. Planning and delegation

Maintain a durable checklist containing all 26 tickets, dependencies, status, assigned agent, task branch, validation, integration commit and blockers.

Establish baseline checks. Read `docs/kernel.md` and `tickets/kernel-01-worker-kernel.md` before designing worker changes.

Give each sub-agent a separate worktree and ticket branch based on the current integration branch. Never let agents edit the same checkout. Assign explicit scope, acceptance criteria and ownership of shared files.

Run only 2–3 implementation sub-agents concurrently. Parallelize independent code areas. Serialize work that changes shared feature schemas, kernel interfaces or overlapping MCP APIs.

Sub-agents implement, test and commit their ticket. They do not merge into the integration branch or change GitHub issue status. Their report must identify changes, tests, commit SHA and remaining concerns.

The orchestrator reviews each result, updates stale branches, resolves conflicts, merges ticket by ticket and validates the integrated result. Prefer a separate merge commit per ticket for traceability.

## 4. Proposed execution order

Start with concrete correctness fixes and inexpensive improvements:

- #106: Honor appended extrude feature names.
- #100: Prevent immediately unusable subshape references.
- #81, then #82: Validate fillet/chamfer results and improve diagnostics.
- #99: Compact `run_parametric` responses.
- #91: Dependency-aware feature-cache invalidation.

Schedule independent follow-on tracks in small waves.

### Stable topology

- #86: Persistent MCP edge references.
- #87: Rule-based selection, following #86.
- Coordinate reference semantics with #100.

### Kernel execution

- #96: Bounded worker execution first.
- Then #97: In-flight cancellation; #98: Crash recovery; #92: Live progress.
- Agree on one architecture and stable interfaces before splitting work.
- Preserve tool ordering, document consistency and reference lifetimes.

### Reference scans

- #101: Lightweight mesh import.
- #102: Deviation measurement, following #101.

### Export

- #103: STL tessellation tolerance.
- #104: Bytes/resource output.
- #105: Separate-file batch export, following #104.
- Serialize overlapping export API edits.

### Parametric modeling

- #83: Variable-radius fillets, and #84: Setbacks, following #81/#82.
- #85: Loft guide/boundary curves.
- #88: Parametric sweep, and #89: Associative projection, before #90: Groove/rib along a face curve.
- #93: Control-point/weighted NURBS sketches.
- #94: From-face extrusion start, and #95: Automatic next/body extent.
- Coordinate persistent references and serialize shared payload changes under the common schema/version plan.

This is an initial schedule. Refine dependencies using source inspection and design reviews, and record the reasons for changes.

Request the original scan and failing operation lists if reproduction requires them. Historical scan-specific crashes were not reproduced by the audit; do not present them as confirmed current failures.

## 5. Completion criteria and GitHub updates

A ticket is complete only when:

1. Its acceptance criteria are satisfied.
2. Relevant tests pass.
3. The orchestrator has reviewed the implementation.
4. It is merged and validated on `enhancement-mouse-project`.
5. Its integration commit is pushed to `origin/enhancement-mouse-project`.

Then the orchestrator must:

- Rename the issue to `[done] {original title}`, without duplicating an existing `[done]` prefix.
- Add a comment containing the **full integration commit SHA**, its GitHub commit link, a concise description and validation results.
- Preserve the `user-report` and `bug`/`enhancement` labels.
- Leave the issue open; closing issues was not requested.

Only the orchestrator makes these updates. Never mark partial or blocked work `[done]`. Track dependencies and blockers explicitly.

## 6. Validation

Follow `AGENTS.md` testing, formatting and commit conventions. Use meaningful targeted regression tests per ticket. After merging, test affected integrations rather than relying solely on a sub-agent's isolated test results.

For C++ changes, rebuild WASM and include required generated artifacts. Verify existing document fixtures and compatibility. Before commits, run required repository checks. Before finishing, run the appropriate complete test suites, production build and other required checks.

Report pre-existing failures separately from regressions introduced by this work. Do not silently weaken tests or acceptance criteria.

The prior audit passed 83 targeted tests covering expressions, loft/thicken, B-splines and kernel guards. This is context, not a replacement for establishing the current baseline or testing new implementations.

## 7. Final delivery

Keep the single draft PR updated with:

- Final behavior and scope.
- A ticket-to-integration-commit table.
- Validation results.
- Format changes, migrations and compatibility evidence.
- Remaining blockers or limitations.

When all agreed work and final checks are complete, mark that same PR ready for review. Use `Refs #...` instead of automatic issue-closing keywords. **Do not merge it.**

If blocked, continue independent work and request the precise missing decision or information. Do not reduce scope without boss direction or claim completion while tickets remain unresolved.

Begin with repository inspection, baseline checks and a concise execution plan, then proceed autonomously within these instructions.
