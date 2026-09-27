# CLOUD-03: Document Repository Abstraction

## Summary

Move document persistence behind a document-level interface so local and cloud storage are interchangeable and users can always keep working locally. Pure refactor first (local only, identical behaviour), plus local file download/upload.

## Current call sites

- `packages/app/src/document.ts:105` `save()` → `storage.put(documents)` + `storage.put(recents)` (thumbnail via `activeView.toImage()`)
- `packages/app/src/document.ts:133` `open()` → `storage.get(documents)`
- `packages/ui/src/home/home.ts:54` → `storage.page(recents, 0)`
- `packages/ui/src/home/home.ts:235` → `storage.delete(documents|recents)`

## Proposed interface (`packages/core/src/foundation/documentRepository.ts`)

```ts
export interface DocumentMeta {
    id: string;
    name: string;
    updatedAt: number;          // epoch ms; cloud: parsed from server UTC (CLOUD-08)
    thumbnail?: string;
    location: "local" | "cloud";
    headVersion?: string;       // cloud only
    syncState?: SyncState;      // cloud only (CLOUD-10)
}

export interface IDocumentRepository {
    readonly kind: "local" | "cloud";
    list(query: { page: number; search?: string }): Promise<Result<DocumentMeta[]>>;
    load(id: string): Promise<Result<LoadedDocument>>;       // { data: Serialized, version?: string }
    save(request: SaveRequest): Promise<Result<SaveOutcome>>; // kind: "manual" | "auto"; outcome may be "conflict"
    delete(id: string): Promise<Result<void>>;
}
```

- `IApplication.repositories`: local always, cloud when signed in. Each open document remembers its repository.
- `LocalDocumentRepository` wraps `IStorage` (IndexedDB `spicy3d-db`).
- `Result` for all expected failures (offline, 401, 404, 409, quota).

### Local files (always available, signed in or not)

- **Download** the current document as a `.spicy` file (gzipped JSON, format-versioned) and **open** a `.spicy` file from disk (file input + drag & drop).
- Where supported, File System Access API "Save" writes back to the same file; otherwise download.
- Cloud documents can be downloaded as `.spicy` too ("keep a local copy").

## Things to think about

- Thumbnail capture stays in the app layer and is passed into the repository.
- Add `document.isDirty` (history position vs last saved) — needed for autosave (CLOUD-07) and sync.
- `Document.close()`'s `window.confirm` → app dialog; save goes through the document's repository.

## Acceptance criteria

- [x] No direct `storage.*` calls for documents remain outside `LocalDocumentRepository`.
- [x] Download → reopen a `.spicy` file round-trips the model.
- [x] `isDirty` toggles on edit / save / undo back to the saved point.
- [x] Existing tests pass; unit tests for the local repository.

## Dependencies and complexity

Dependencies: CLOUD-02. Complexity: medium.
