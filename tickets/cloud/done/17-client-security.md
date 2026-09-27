# CLOUD-17: Client Security

## Summary

Once the app holds a session cookie to a server containing the user's documents (and later sits on the public internet), client-side weaknesses become account weaknesses. Review before going public.

## Checklist

- [x] **CSP** served by the server's proxy (SRV-02/SRV-11): `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, no inline scripts (check loading screen, `iconfont.js`), `connect-src 'self'` + configured LLM endpoints, `frame-ancestors 'none'`.
- [x] **Plugins** (`?plugin=` and plugin manager) execute arbitrary code with the user's session → when signed in: same-origin/allowlisted plugins only, or an explicit trust prompt naming the origin.
- [x] **`?url=` / `?model=`** loaders: same-origin/allowlist; never fetch arbitrary hosts silently.
- [x] **CSRF**: every state-changing request carries the custom header required by the server (`X-Spicy3D-Request: 1`).
- [x] **Tokens**: MCP personal access tokens shown once, never stored in localStorage; the old local-bridge token stays separate.
- [x] **Sign-out hygiene**: cached cloud documents, blobs and settings removed from IndexedDB/localStorage (unless "keep offline copies").
- [x] **MCP**: pairing prompt, agent indicator, disconnect (CLOUD-14); prompt-injection note in docs — document text (names, annotations) reaches the agent.
- [x] **Dependencies**: `npm audit` in CI; pin and review the MCP SDK and generated API client deps.
- [x] **Error handling**: no tokens or document content in logs/toasts/telemetry.

Implementation notes (CLOUD-17 branch; the guide is `docs/security.md`, with the release checklist):

- **CSP**: the policy is the web image's own (`docker/default.conf.template`, which SpicySrv's Caddy
  lets through), not the proxy's: SpicySrv's default `script-src 'self' 'wasm-unsafe-eval'` stops the
  app, because embind needs `'unsafe-eval'` until the WASM is rebuilt with `-sDYNAMIC_EXECUTION=0`
  (not done here). `connect-src https:` is gone: `'self'` + the local bridge + operator-listed
  `SPICY3D_CONNECT_ORIGINS` (validated at start). No inline script (index.html, iconfont.js, loading
  screen checked); `style-src 'unsafe-inline'`, `blob:` for plugins stay, each justified in the doc.
  `contentSecurityPolicy.test.ts` pins it; `npm run smoke` runs under it.
- **Plugins / links**: core `ExternalContentPolicy` (same origin or `deployment.json`
  `security.pluginOrigins` / `fileOrigins`, other http(s) origins ask, other schemes refused).
  Signed in — or not known yet: `useCloud` says "session" until discovery, `startCloud` until the
  account is `signedOut` — saved plugin trust is ignored, the prompt names the origin and warns about
  the account, and a Trust lasts for the page. Trust is now stored per origin (old host entries still
  count for https while signed out). `?url=` asks every time for another origin, no cookies sent.
- **CSRF**: already done by `CloudClient` (blob PUT included); `requestSurface.test.ts` lists every
  other `fetch`/WebSocket with its reason. WebSockets rely on SpicySrv's `Origin` check.
- **Tokens / sign-out**: PAT already shown once and stored nowhere (now asserted); the bridge token
  stays in `mcp.settings`, and a `?mcp=…?token=` link leaves the address bar once read. Sign-out
  already cleared the cloud cache DB, `lastUser` and the autosave account cache; it now also forgets
  MCP pairing decisions (sessionStorage). Full inventory in the doc.
- **MCP**: the prompt-injection note is in the doc and in the server instructions / chat prompt.
- **Dependencies**: `npm audit --audit-level=high` for all deps in CI next to the runtime one; the four
  high dev findings fixed by `npm audit fix` (lockfile only), no ignores. MCP SDK, `openapi-fetch`,
  `openapi-typescript`, `ws` pinned exactly, own Dependabot PRs (`dependencyPins.test.ts`).
- **Logs**: core `redactUrl` / `redactSecrets`; plugin/file/bridge URLs and errors redacted, open/
  close/autosave lines log the document id. No telemetry exists.

Not done: rebuilding the WASM without dynamic execution; moving inline styles to drop
`'unsafe-inline'`; a UI to review saved plugin trust (only reachable by clearing site data).

## Dependencies and complexity

Dependencies: CLOUD-05, CLOUD-14. Complexity: medium; repeat before each public release.
