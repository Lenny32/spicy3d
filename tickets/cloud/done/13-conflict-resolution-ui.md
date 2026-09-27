# CLOUD-13: Conflict Resolution UI

## Summary

When sync detects divergence: merge silently if clean, otherwise let the user resolve conflicts with context, then save a two-parent `merge` version.

## Flow

1. Diverged → fetch base + latest → merge → validate.
2. **Clean**: apply as one transaction, push, toast "Merged changes from *<device>*" with **View changes** / **Undo merge**.
3. **Conflicts**: non-modal panel grouped by body/node:
   - description, *This device* vs *<other device>* values (base on hover), **Keep this / Take other**, **Keep both** where meaningful;
   - selecting a row highlights the node / opens the feature in the timeline / selects the sketch entity;
   - live preview of the merged model with current choices (debounced re-evaluation);
   - bulk "Keep all from this device" / "Take all from other";
   - **Save as a copy instead** at any time.
4. All resolved + validation OK (or remaining rebuild errors explicitly accepted) → push `merge` version.
5. New remote update during resolution → re-merge, reapply choices by conflict path.

## Things to think about

- Conflicts are always between the same user's devices/agents → label sides by device name and time (local, CLOUD-08), and "Agent (MCP)" when the other side came from MCP.
- Rebuild-failure conflicts have no side to pick → "open failing feature", edit, re-validate.
- Autosave/sync paused while resolving.
- "Export merge report" (base/ours/theirs manifests as JSON) for bug reports.

## Acceptance criteria

- [x] Clean divergence auto-merges; "Undo merge" restores the pre-merge local state. (`packages/cloud/test/conflictPanel.test.ts`, "a clean merge": the toast's View changes / Undo merge, the pre-merge content back as one undo step, nothing pushed on top of the merge, "Merge again" pushes it; refused once edited)
- [x] Every CLOUD-11 fixture is resolvable through the UI (component tests). (`packages/builder/test/mergeConflictPanel.test.ts`: all 34 cases, the n-th choice of every conflict — and of every conflict a choice creates — clicked in the panel, Finish; the pushed `merge` version equals `reapplyResolutions` of the fixture with those choices; clean cases merge on their own; the rebuild failure needs its Accept)
- [x] Selecting a conflict highlights the affected object. (`conflictPanel.test.ts` — the row selects its node in the document; `core/test/mergeReveal.test.ts` — node selection, the feature opened in the timeline, revealers; `parametric/test/sketch/mergeReveal.test.ts` — the sketch entity; `ui/test/featureListProperty.test.ts` — the timeline expands the feature)
- [x] Save-as-copy leaves the other version as head and creates a new document with mine. (`conflictPanel.test.ts`)
- [x] Remote update during resolution keeps chosen resolutions. (`conflictPanel.test.ts`: the tablet saves again while the panel is open — re-merged, the choice kept by path, the one whose conflict is gone dropped with a note, pushed on the newer head)

Implementation notes (CLOUD-13 branch): `packages/cloud/src/conflicts/` — `ConflictPanel` (side panel,
`SidePanels.items`) over `ConflictResolution`; opened from the Conflict pill, the conflict toast's
Resolve and a save meeting a conflict (`CloudDocuments.openConflicts`; the MVP dialog stays for a
conflict without a merge result — the base is gone). Design decisions:

- **Preview**: a separate, read-only document (`MergePreviewRepository`, fresh id, `app.loadDocument`),
  its content replaced (debounced) with the merge of the current choices — never the open document,
  which keeps this device's side untouched until Finish (a crash or closed tab while resolving loses
  nothing, and `SyncEngine.resolve` merges from it). Rows reveal their object in whichever of the two
  is on screen.
- **Choices** are kept by path and reapplied with `reapplyResolutions` (rounds of `resolveMerge`, so a
  conflict a choice creates is answered in the same call; `SyncEngine.resolve` uses it too); a newer
  head re-merges while the panel holds the sync (the engine now re-merges in `conflict` despite a
  hold), dropped choices get a note.
- **Finish** re-merges with the document as it is (edits made meanwhile count), rebuilds
  (`validateMerge` with the sync's evaluator; rebuild failures need an explicit Accept, or a fix and
  Re-validate; no evaluator = pushed unvalidated, as the sync does), then `SyncEngine.resolve`.
- **Undo merge** (`SyncEngine.undoMerge`): the pre-merge content back as one undo step (`undo merge`),
  the sync record back on the old base with this device's changes pending (a merge push that landed
  unanswered is forgotten, so it is "theirs"), and the document held in `conflict` with `undone`:
  pushing mine on top would silently revert the other device's changes, and merging again by itself
  would loop — the panel offers Merge again / Save mine as a copy / Open latest. Refused once the
  document was edited after the merge; kept per session (a reload merges again, with the same toast).
- Sides: device name + local time (CLOUD-08 helpers), "Agent (MCP)" when the other version's kind is
  `mcp` (`SyncSide.kind`). Export merge report: base/ours/theirs, conflicts, choices, dropped (JSON).
- Toasts take several actions (`showActionToast` with an array).

Not run in a browser: the panel, the preview document and the sketch-entity reveal were exercised in
happy-dom component tests only (no layout-dependent logic; rendering never triggers loads).

## Dependencies and complexity

Dependencies: CLOUD-10, CLOUD-12. Complexity: high.
