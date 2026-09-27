# CLOUD-06: Cloud Documents Integration

## Summary

`CloudDocumentRepository` against SRV-05 plus the UI to choose where documents live. Users decide per document: **this device** or **cloud**; both remain available at all times.

## Scope

### Repository

- `packages/cloud/src/repository.ts` implementing `IDocumentRepository` (CLOUD-03).
- Save = upload changed blobs (content-addressed, SRV-05) + create a version with `If-Match: <headVersion>`, `kind: manual|auto`, optional label, `Idempotency-Key`.
- Load = head manifest + blobs (cached in IndexedDB).
- Manifest splitting: large opaque values (BREP strings from `packages/wasm/src/shape.ts:90`, mesh buffers, images) replaced by `{ "$blob": "<sha256>" }`; hash the uncompressed bytes, upload gzipped. Pure function with tests.

### UI

- Home page: **Cloud** / **This device** sections (or filter), search by name, last-modified shown in local time (CLOUD-08), cloud badge, size.
- New document: default location = cloud when signed in (setting), else device.
- "Save to cloud" for a local document (moves it; offer to keep the local copy), "Save a copy on this device", "Download .spicy".
- Title bar status: Saved · Saving… · Offline · Conflict · Error.
- Delete cloud document → confirmation → server trash (restorable for N days, SRV-05) → "Undo" toast.
- Import: "Upload documents from this device…" checklist.

### MVP conflict behaviour (until CLOUD-13)

`409` → dialog "A newer version was saved from *<device>* at *<local time>*": **Open latest** (discards my unsaved changes — offer "download mine as .spicy" first) · **Save mine as a copy** · **Save mine as the latest version** (creates a new version on top; nothing lost because history keeps both).

## Things to think about

- Thumbnails: `toImage()` → downscaled WebP blob.
- The same cloud document in two tabs: detect via BroadcastChannel/Web Locks; second tab opens read-only with "edit here instead".
- Undo stack isn't persisted; reload/merge clears it — say so.
- Device name for version metadata ("Desktop – Firefox"): user-editable per browser, stored locally, sent with saves.

## Acceptance criteria

- [ ] Signed in: create cloud document, save, reload, reopen from Cloud list.
- [ ] Local and cloud documents coexist; moving a document between them works both ways.
- [x] Saving a document with unchanged imported geometry uploads only the manifest.
- [ ] Stale save shows the MVP dialog; each option behaves as described.
- [ ] Deleted cloud document can be restored from trash.

Implementation notes (CLOUD-06 branch): `CloudDocumentRepository` was run against a local SpicySrv
(PostgreSQL in Docker, from Node through the real client, no browser): create, new version with
`If-Match`, stale save → `version_conflict` with head device and time, reload from a fresh cache,
listing, trash and restore, and a second save with unchanged geometry uploading one blob (the
manifest) — hence the ticked box. The server's data export `latest.spicy` was reopened with
`decodeDocumentFile`. Everything with UI (home sections, move both ways, the conflict dialog's three
options, trash view, two tabs) is covered by tests against a fake server / fake repositories only
(`packages/cloud/test/cloudDocuments.test.ts`, `packages/ui/test/home.test.ts`) and still needs a run in
a browser. Uploads are raw: the server hashes the body as received, stores it gzipped itself and
doesn't accept `Content-Encoding: gzip` (`PUT /api/blobs/{sha256}`: "raw bytes, uncompressed").
The title bar adds "Unsaved changes" to the five states (edits since the last save, until
autosave, CLOUD-07); a read-only tab can still edit in memory but cannot save.

## Dependencies and complexity

Dependencies: CLOUD-03, CLOUD-05, SRV-05. Complexity: medium-high.
