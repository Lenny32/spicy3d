# CLOUD-07: Autosave

## Summary

Automatically save dirty documents every **5 minutes** by default. The interval is configurable; when signed in it is stored in the user's settings on the server (follows the user across devices), otherwise in local storage. Autosaves create versions of kind `auto`, which the server prunes; manual saves are kept forever.

## Scope

- `AutosaveService` in `packages/app`: timer per open document; fires only when `document.isDirty`.
- Never interrupt the user: skip/defer while a command is active (sketch editing, drag, gizmo, dialogs mid-operation) and while a merge is being resolved; run as soon as the command ends.
- Setting `autosave.intervalMinutes`: options Off, 1, 2, 5 (default), 10, 15, 30. Stored:
  - signed in → `PUT /api/me/settings` (SRV-06), cached locally for offline start;
  - signed out → `localStorage` `spicy3d.settings.autosave`.
  - On sign-in, the server value wins; if none exists yet, upload the local value.
- Targets:
  - cloud document → version with `kind: "auto"`;
  - local document → overwrite the local IndexedDB copy (there is no local history);
  - opened `.spicy` file via File System Access handle → write back only if the user enabled it for that file.
- Status bar: "Autosaved 14:05" (local time).
- Manual save (Ctrl+S) always creates a `manual` version, even if nothing changed since the last autosave (it "promotes" the state to a kept version).

## Things to think about

- Offline: autosave writes to the local cache; sync (CLOUD-10) pushes later — possibly several autosaves collapse into one pushed version.
- Autosave + conflict: an autosave hitting `409` enters the normal merge flow silently when clean; if conflicts arise, show the conflict pill, do not pop a modal.
- Timer reset after any manual save.
- Retention of autosaves is server policy (SRV-06); the history view (CLOUD-09) shows them collapsed.

## Acceptance criteria

- [x] Dirty document is saved at the configured interval; clean document is not.
- [x] No autosave fires mid-command; it fires right after the command ends.
- [x] Interval changed on device A applies on device B after sign-in / settings refresh.
- [x] Signed-out interval persists locally across reloads.
- [x] Cloud autosaves appear as `auto` versions; manual saves as `manual`.

Verification: all five with unit tests only (fake timers `rs.useFakeTimers`, in-memory repositories,
the fake SpicySrv of `packages/cloud/test/_helpers` plus a fake `/api/me/settings` with ETags and
412) — not yet against a running SpicySrv nor clicked through in a browser (File System Access
write-back permission prompts in particular are only mocked).

## Implementation notes

- `AutosaveService` (`packages/app/src/services/autosaveService.ts`, registered by `AppBuilder`):
  the timer of a document starts when it becomes dirty and fires `interval` later; any save makes it
  clean, which stops the timer (so a manual save resets it). Busy = `app.executingCommand`, a pressed
  pointer (drag, gizmo), an open `<dialog>` (every modal of the app and the cloud, incl. the conflict
  dialog) or an `AutosaveHolds` hold (the sketch session, whose body rollback must never be saved);
  a due autosave waits and runs as soon as that ends (command end / hold release / pointer up are
  signalled, dialogs are polled every second).
- Setting: `AutosaveSettings` (core). Off is stored as `0` locally and as `enabled: false` on the
  server (which keeps the last interval). The account's value is cached in
  `spicy3d.settings.autosave.account` so an offline start (cloud module not even loaded) still uses
  it; a change made then is pending and uploaded on the next refresh. "None exists yet" on the
  server = ETag `"0"` (SpicySrv returns defaults for a user who never saved settings).
- UI: the interval is on the home page's settings (signed in or not — it shows and changes the
  account's value while signed in) and in the account settings (`AccountSettingsSections`).
  "Autosaved 14:05" (`formatTime`, local time, formatted when shown) is in the cloud title-bar pill
  for cloud documents and in the status bar for the others; the status bar also has the per-file
  "Autosave to file" opt-in of a document opened from a `.spicy` file (turning it on asks the browser
  for write access, as a timer can't; remembered for that file for the tab's session).
- `.spicy` files opened with a handle are not autosaved at all without the opt-in (the file is
  where they live; saving into browser storage behind the user's back would create a copy).
- Conflict: an autosave's 409 sets the Conflict status (clickable → the conflict dialog) and
  autosave pauses for that document until its version changes. The silent merge of a clean
  conflict needs the merge engine (CLOUD-12/13).
- Offline: status Offline, the next interval tries again. **CLOUD-10:** write the autosave to the
  offline cache instead and let the sync push it (several autosaves may collapse into one version).
- Manual save always saves: neither `Document.save` nor `CloudDocumentRepository` short-circuits a
  clean document, and SpicySrv does not deduplicate identical manifests (a new `manual` version on
  top of the `auto` one, same manifest, no blob re-upload).
- Not done: the server's `settings.updated` real-time event (no event channel in the client yet,
  CLOUD-10) — until then another device's change shows on sign-in / tab focus / `online` / opening
  the account settings.

## Dependencies and complexity

Dependencies: CLOUD-03, CLOUD-06, SRV-06. Complexity: medium.
