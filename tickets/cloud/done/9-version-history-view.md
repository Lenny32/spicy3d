# CLOUD-09: Version History View

## Summary

A dedicated view listing every version of a cloud document, with preview, restore, labels and comparison. Manual versions are kept forever; autosaves are shown but pruned by the server over time.

## Scope

### Panel

- Opened from the document menu / title bar ("Version history") as a side panel next to the viewport.
- List grouped by local day (CLOUD-08), newest first; each row: time, kind icon (**manual** / **auto** / **merge** / **restore** / **mcp**), device name, optional label, thumbnail.
- Consecutive autosaves collapsed into "N autosaves" (expandable).
- Filter: "Manual only".
- Pruned autosaves disappear from the list (no tombstones), with a small note explaining the policy ("autosaves older than X are thinned out").

### Actions per version

- **Preview**: loads that version read-only in the viewport (banner "Viewing version from … — Restore / Back to latest"); no autosave/sync while previewing.
- **Restore**: creates a *new* version (`kind: restore`, parent = current head) with that content. History is never rewritten.
- **Name this version**: label (e.g. "Sent to supplier"); labeled autosaves are promoted to kept.
- **Save as new document** from this version.
- **Download** this version as `.spicy`.
- **Compare with current / with previous**: semantic change list from the merge engine's diff (CLOUD-12): "Extrude 3: distance 10 → 15 mm", "Sketch 2: +3 lines, −1 constraint", "Box 1 deleted". Stretch: ghost overlay of the other version's geometry in the viewport.

### Data

- `GET /api/documents/{id}/versions?cursor=` (SRV-05), keyset pagination, infinite scroll.
- Version content fetched on demand; blobs cached.

## Things to think about

- Previewing a version with an older `formatVersion` goes through migrations (CLOUD-02); a newer one shows "needs update".
- Merge versions have two parents; show as a single row with "merged changes from *<device>*", no git graph.
- Large histories (autosave every minute for months) → pagination and server-side pruning keep it bounded.

## Acceptance criteria

- [x] History lists versions with local times, kinds, devices; autosaves collapsed. (tests against the fake document server)
- [x] Preview is read-only and cannot overwrite the head. (the preview is a separate document on a read-only repository that refuses every save; tests against the fake document server)
- [x] Restore creates a new head version; the previous head stays in history. (tests against the fake document server)
- [x] Labeling an autosave keeps it through pruning (SRV-06 test). (mocked: the client's `PATCH` against the fake server and its simplified pruner; the real rule — `Label == null && !Pinned` — read in SpicySrv's `AutosavePruner`)
- [x] Compare lists semantic differences. (core's `SemanticDiffer` is the default `IDocumentDiffer` since CLOUD-12: the merge engine's two-way diff as display lines — "Extrude 1: depth 10 mm → 15 mm", "Sketch 1: +3 lines, −1 constraint", "Box 1 deleted"; `packages/builder/test/semanticDiff.test.ts` in English, `cloud/test/versionHistory.test.ts` through the history)

## Dependencies and complexity

Dependencies: CLOUD-06, CLOUD-08, SRV-05, SRV-06; compare needs CLOUD-12. Complexity: medium-high.
