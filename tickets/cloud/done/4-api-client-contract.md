# CLOUD-04: API Client & Server Contract

## Summary

The server is a separate C# repository (SpicySrv). Keep client and server in sync through the **OpenAPI document the server publishes**, generating a typed TypeScript client in a new `packages/cloud`.

## Scope

- New package `@spicy3d/cloud`: `src/api/` (generated), `src/client.ts` (fetch wrapper: base URL, cookies, CSRF header, `Idempotency-Key`, problem+json → `Result` errors), `src/config.ts`.
- Generation: `openapi-typescript` (types only) + a thin hand-written fetch layer (or `openapi-fetch`). The spec is **committed** in this repo (`packages/cloud/openapi.json`) and updated by a script (`npm run cloud:api -- <path-or-url>`), so the web build never needs the server or network. CI fails if generated code is stale.
- Runtime discovery: `GET /api/config` (anonymous) →
  ```json
  { "serverVersion": "0.0.1", "apiVersion": 1,
    "features": { "signup": true, "emailVerification": false, "mcp": true },
    "mcp": { "endpoint": "https://…/mcp", "pageLink": "wss://…/ws/mcp-page" } }
  ```
  If absent (static hosting, no server) the cloud module stays dormant; the app works fully locally.
- Compatibility: client declares supported `apiVersion` range; outside it → banner "Spicy3D was updated, reload".
- `AppBuilder.useCloud({ baseUrl? })` (default same origin), lazily loaded so the local-only path doesn't pay for it.

## Wire conventions (mirror SRV-01)

- JSON, camelCase.
- Timestamps: ISO 8601 **UTC** with `Z` (e.g. `2026-09-25T14:03:11.123Z`) — never local offsets (CLOUD-08).
- IDs: strings. Version ids are server-generated UUIDv7.
- Errors: RFC 9457 `application/problem+json` with a stable `type`/`code` for i18n mapping.
- Optimistic concurrency: `ETag` / `If-Match` with the head version id; `409` on mismatch.

## Acceptance criteria

- [x] Generated client compiles from the committed spec; regenerating from a newer spec is one command.
- [x] Without a server, no failing network requests and no cloud UI.
- [x] Problem+json errors map to typed `Result` errors with i18n messages.
- [x] API-version mismatch shows the reload banner.

## Dependencies and complexity

Dependencies: SRV-01 (first OpenAPI draft). Complexity: medium.
