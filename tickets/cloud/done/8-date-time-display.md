# CLOUD-08: Date & Time Display

## Summary

The server stores and returns **only UTC** timestamps. The client formats them in the local computer's locale and time zone. Locally stored documents keep their current behaviour.

## Scope

- Parse server timestamps (ISO 8601 with `Z`) with a single helper `parseUtc(iso): number` in `@spicy3d/core` — reject strings without a zone designator (never let `Date` guess local time).
- Format helpers using `Intl` (no date library needed):
  - `formatDateTime(epochMs)` → `Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })` — `undefined` = browser/OS locale, time zone = system zone.
  - `formatRelative(epochMs)` → `Intl.RelativeTimeFormat` for recent items ("5 minutes ago"), absolute date beyond ~7 days; full timestamp in a tooltip.
- Use everywhere cloud times appear: home list, version history, sessions list, API tokens (created/last used), conflict dialogs, autosave status.
- Grouping in the history view ("Today", "Yesterday", "Last week") computed in local time.
- Local documents: unchanged (`recents.date` is `Date.now()` epoch ms; keep displaying as today).
- The client never sends local timestamps for ordering; the server's time is authoritative. If the client needs "now" for relative display, use the local clock only for display.

## Things to think about

- Time zone changes while the app is open (travel, DST): format at render time, don't cache formatted strings.
- Tests: fix locale and time zone in tests (`TZ=Europe/Paris` / `Intl` stubs) and cover DST boundaries.
- UI language (i18n) vs formatting locale: format with the browser locale, not the UI language, unless the owner wants them tied.

## Acceptance criteria

- [x] A server timestamp `2026-03-29T00:30:00Z` displays correctly in Europe/Paris and America/New_York (tests with fixed TZ).
- [x] All cloud timestamps in the UI go through the helpers (grep test / lint rule for direct `toLocaleString` on server values).
- [x] Local document dates unchanged.

## Dependencies and complexity

Dependencies: CLOUD-04. Complexity: small.
