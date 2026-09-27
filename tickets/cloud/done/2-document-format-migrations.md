# CLOUD-02: Document Format & Migration Framework

## Summary

Spicy3D starts at document format `1`, but cloud documents keep every version forever — a document saved today must still open in two years. Today `Document.load()` rejects anything whose `version` is not exactly the build's (`packages/app/src/document.ts:151`, via `alert`). Replace that with an integer format version plus a migration chain, in place **from day one**, so the first format change doesn't strand stored versions.

## Scope

- `formatVersion: number` in the serialized envelope (replaces the string `version`); constant `DOCUMENT_FORMAT_VERSION = 1` in `@spicy3d/core`.
- Module versions for independently evolving payloads: `moduleVersions: { parametric: 1, sketch: 1 }`, each module registering its own migrations.
- `registerMigration(module, from, migrate)` — pure `Serialized → Serialized`, no DOM/WASM, deterministic.
- `load()`:
  - older → run the chain;
  - newer than the build → non-blocking error "saved with a newer Spicy3D, please reload/update" (the web app is always the latest on the server, so this mainly hits cached tabs);
  - missing/unknown format (e.g. a Chili3D file) → "not a Spicy3D document".
- Unknown `__cla$$__` class (plugin not loaded): keep raw JSON in an `UnknownNode` placeholder so saving doesn't drop it.
- Fixture corpus `packages/core/test/fixtures/documents/v<N>/` — at least one rich document per format version, loaded by tests forever.
- Add rule to `CLAUDE.md`: changing any `@serialize()` field shape requires a migration + fixture.

## Things to think about

- The merge engine (CLOUD-12) requires base/ours/theirs at the same format → migrate all three first.
- The server treats documents as opaque but stores `formatVersion` as metadata (SRV-05), so the history view can say "needs a newer app" without downloading.
- `userData` passes through migrations untouched.
- Replace the `alert()` with the app's toast/dialog.

## Acceptance criteria

- [x] Format `1` documents round-trip; a synthetic `v0 → v1` test migration proves the chain runs.
- [x] Newer-format and non-Spicy3D files show a clear error and are not modified.
- [x] Unregistered node classes survive load/save.
- [x] Migrations run in Node without DOM/WASM.
- [x] Registry test: chain has no gaps for any module.

## Dependencies and complexity

Dependencies: CLOUD-01. Complexity: medium.
