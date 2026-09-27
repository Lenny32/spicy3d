# CLOUD-10: Offline-First Sync

## Summary

Every save lands in IndexedDB first; a sync engine pushes to the server in the background, pulls updates from the user's other devices, and triggers the merge when histories diverge. Losing the LAN/server never loses work.

## Model (per cloud document, in IndexedDB)

```
syncRecord { docId, baseVersion, localSnapshot, localDirty, pendingKind: manual|auto,
             pendingSince, lastError, clientId }
versionCache { versionId → manifest }   // must retain baseVersion while dirty (merge base)
blobCache    { sha256 → blob }           // LRU, size-capped
```

States: `clean → dirty → pushing → clean` · `pushing → diverged (409) → merging → pushing` · `* → offline → pushing` · `* → error` (401 → re-login, 413/quota → user).

## Scope

- Push: `POST /api/blobs/check` → upload missing → `POST versions` with `If-Match: baseVersion`, `Idempotency-Key`.
- Pull: WebSocket `/ws/events` `document.updated {id, head, clientId}` (ignore own), plus refetch on reconnect / window focus. Clean → fast-forward in place (toast "Updated from *<device>*"). Dirty → diverged → merge (CLOUD-12/13).
- Backoff retry; queue survives reloads; `navigator.storage.persist()`.
- One sync owner per document per browser (Web Locks API); other tabs read-only.
- Several offline autosaves collapse into one pushed `auto` version; a pending manual save pushes as `manual`.
- In-place reload after pull: `document.replaceContent(serialized)` keeping views/camera, deferring while a command is active ("remote changes pending" pill).

## Acceptance criteria

- [x] Stop the server, edit + save several times, restart → server has the changes with the correct parent; nothing lost.
- [x] Reload while offline with pending changes → still there, pushed later.
- [x] Update from device B appears on device A within ~2 s when A is clean.
- [x] Diverged state enters the merge flow.
- [x] Fault-injection test (flapping network) converges: server head == local base, local clean.

Implementation notes (CLOUD-10 branch): `packages/cloud/src/sync/` (`SyncEngine`, `EventsChannel`,
`SyncRecord` store), wired by `CloudDocuments`; state machine and storage in AGENTS.md. Mocked
(`packages/cloud/test/sync.test.ts`, `syncEvents.test.ts`, `syncStore.test.ts`: fake server, fake
WebSocket, fake IndexedDB): every box above, plus lost answers retried with the same key, the
landed-but-unanswered push used as the merge base, clean and conflicting merges, "Open latest" /
"Merge, keeping mine" from the MVP dialog, read-only tabs, background push of closed documents,
eviction, quota, re-login, restore after a flush, sign-out keeping unsynced saves. The fault
injection (16 seeds; drops, lost answers, duplicated requests, timeouts, socket drops, lost and
duplicated events, another device saving concurrently) was run over 200 times without a failure
before being trimmed. Live, against a local SpicySrv (PostgreSQL in Docker, the real client from
Node with a cookie jar and Node's WebSocket, not a browser): create, fast-forward of the other device
through `/ws/events` in ~170 ms, two offline saves collapsing into one push that met a 409 and was
pushed as a `merge` with `parentIds [head, own base]`, a conflict resolved with `resolve`, a lost
answer retried as one version, and the first box for real — the server process stopped, three saves
(auto, manual, auto), a reload while it was down (cached config and user, the pending snapshot
reopened), restarted → one `manual` version on the pre-stop head. Not run in a browser: IndexedDB
(the fake's `get`→`put` in one transaction relies on promise microtasks keeping it active, as modern
browsers do), `navigator.storage.persist()`, the status pill and the home badges. The merge result
is not validated with the kernel (`validateMerge`, CLOUD-13's panel); `settings.updated` events are
not used yet (the settings still refetch on focus / `online`).

## Dependencies and complexity

Dependencies: CLOUD-06, SRV-05, SRV-07 (events). Merge path: CLOUD-12/13. Complexity: high.
