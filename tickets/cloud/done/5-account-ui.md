# CLOUD-05: Account UI

## Summary

Optional accounts: everything works without one; signing in unlocks cloud storage, synced settings and remote MCP. No paywall, no upsell nags beyond a discreet "Sign in to save to the cloud".

## Scope

### Screens / dialogs

- **Sign up**: email, display name, password (strength hint), accept privacy notice. If email verification is enabled (`/api/config.features.emailVerification`) → "check your inbox" state + resend.
- **Sign in**: email + password; "forgot password" (only shown when the server can send email).
- **Reset password**: landing route from the email link (`/reset-password?token=…`).
- **Verify email**: landing route `/verify-email?token=…`.
- **Account menu** (ribbon/title bar avatar): display name, email, Settings, Sign out.
- **Account settings**: change display name, email (re-verification), password; active sessions (device, last seen — UTC displayed locally) with revoke; API tokens for MCP (CLOUD-14); autosave interval (CLOUD-07).
- **Privacy / danger zone** (bottom of account settings, collapsed, deliberately not prominent):
  - **Download my data** — ZIP with all documents (latest version as `.spicy`, optionally all versions), account info and settings as JSON (SRV-08).
  - **Delete my account** — explains that all documents and history are permanently deleted, suggests downloading data first, requires typing the email + current password; after success: signed out, local cached cloud copies removed, local (non-cloud) documents untouched.

### Behaviour

- Session expiry during editing → re-login dialog that never discards the open document; the pending save retries afterwards.
- Sign out: stop sync, remove cached cloud documents from IndexedDB (setting "keep offline copies on this device" to opt out), keep local documents.
- All strings in i18n.

## Things to think about

- Cookie session is same-origin; when the server moves to a public host, the web app must be served from the same origin (SRV-02) — no cross-site cookies.
- Rate-limit / lockout messages from the server shown clearly ("too many attempts, try again in N minutes").
- Without email configured: sign-up still works (verification disabled), password reset is admin-only — show "contact the administrator".

## Acceptance criteria

- [ ] Sign up, sign in, sign out, change password, revoke session work against the server.
- [ ] With email verification on (smtp4dev in dev), verify and reset links from the email complete the flow.
- [ ] Delete account removes everything server-side and signs out; local documents remain.
- [ ] Data export downloads a ZIP that reopens in Spicy3D.
- [x] App remains fully usable when never signed in.

Implementation notes (CLOUD-05 branch): the first four criteria are covered by tests against a mocked
server only (`packages/cloud/test/account*.test.ts`) and still need a run against SpicySrv. The data
export ZIP holds the server's `spicy3d.cloudVersion` envelopes (manifest + base64 blobs), which the app
can reopen once CLOUD-06 defines the manifest; the "remove cached cloud copies" step is the
`Account.addSignOutHandler` hook (`removeCachedDocuments`), filled by CLOUD-06 with the cache; the
autosave interval goes in `AccountSettingsSections` (CLOUD-07).

## Dependencies and complexity

Dependencies: CLOUD-04, SRV-03, SRV-04, SRV-08. Complexity: medium-high.
