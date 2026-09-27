# CLOUD-16: Deployment Readiness (LAN Now, Public Later)

## Summary

The web app must run unchanged on a LAN-only server today and a public server later. Remove hard-wired external URLs, make everything come from runtime config, and handle the browser's secure-context rules.

## Known items

| Item | Where | Fix |
|------|-------|-----|
| LLM defaults `api.anthropic.com` / `api.openai.com` | `packages/ai/src/settings.ts:29-43`, `packages/ai/src/llm/*` | Keep as defaults for users with internet; allow server-provided defaults via `/api/config` (e.g. an on-prem OpenAI-compatible endpoint); chat panel explains when the endpoint is unreachable. |
| Bridge download base baked at build time (`__MCP_BRIDGE_DOWNLOAD_URL__`, GitHub releases) | `scripts/build-mcp-bridge-binaries.mjs`, `packages/ai/src/mcp/panel.ts` | Server serves bridge binaries (`/downloads/mcp-bridge/`); download base from `/api/config` at runtime. |
| `npx --package=<site>/mcp/…tgz` | `scripts/pack-mcp-bridge.mjs` | `npx` fetches dependencies from the npm registry → fails without internet. Bundle dependencies or recommend the standalone binary on LAN. |
| Repo links in home/ribbon | `packages/ui/src/home/home.ts:158`, `packages/ui/src/ribbon/ribbon.ts:185` | New repo URL (CLOUD-01); harmless offline. |
| `?plugin=`, `?url=`, `?model=` | web entry | Same-origin or allowlist when cloud is enabled (CLOUD-17). |
| Fonts / icons | `public/fonts`, `public/iconfont.js` | Local already; verify no external `@import`. |

## Scope

- Web app built once, deployable anywhere: no server URL baked in; same-origin by default.
- Build output published as a versioned artifact/image consumed by the server repo's compose (SRV-02): e.g. GitHub Actions builds `spicy3d-web:<version>` (static files in a Caddy/nginx image) or a tarball of `dist/`.
- **Secure context**: `http://<lan-ip>` is not secure → `crypto.subtle`, Service Workers, Clipboard, File System Access unavailable. On startup, if `!window.isSecureContext` and not localhost, show a banner explaining HTTPS is required for some features; the server compose provides TLS (SRV-02).
- Smoke test in CI: headless Chromium with non-same-origin requests blocked → app loads, WASM initializes, local save/open works.
- Lint script `scripts/check-external-urls.mjs` with an allowlist.

## Acceptance criteria

- [x] With internet blocked, the app from the LAN server loads and works (local + cloud) with no failed external request.
- [x] MCP panel downloads/configs point only at the configured server.
- [x] Insecure-context banner appears over plain HTTP on a LAN IP.
- [x] Same build works on a public HTTPS host without rebuild.

Implementation notes (CLOUD-16 branch; operator guide `docs/deployment.md`, dev workflow in the README):
per-deployment settings come from `deployment.json` next to `index.html` (core `DeploymentConfig`,
`AppBuilder.useDeploymentConfig()`), not from `/api/config`: SpicySrv's `ConfigResponse` has no
field for them, and the file also covers the no-server case. `mcpBridge.downloadUrl` (relative = the
app's folder) replaces the build-time release URL in the MCP panel; `ai.presets` / `defaultPreset` /
`hideBuiltInPresets` feed the assistant's endpoint list (the chat panel isn't in the shipped bundle
yet; it names an unreachable endpoint and points at its settings). The npx tarball moved from `mcp/`
to `downloads/mcp-bridge/` — SpicySrv's Caddy sends `/mcp/*` to the API, so it was unreachable there
— and is esbuild-bundled without dependencies (verified with the registry unreachable); the command
gains `--allow-remote=all`, without which npm 12 refuses any package from a URL. Found on the way: the
macro plugin loaded ace from jsDelivr (offline: an alert on every start) — now bundled; SpicySrv's
default CSP stops the app at startup (embind's `new Function` needs `'unsafe-eval'`), so the image
sends its own (`docker/default.conf.template`), which the smoke test reads. The image is
`nginxinc/nginx-unprivileged` on 8080, non-root, read-only-safe; workflow **Web image** builds, tests
and exports/pushes it. `SPICY3D_API_URL=… npm run dev` proxies `/api/*`, `/ws/*` (not `/ws`, the
dev server's live reload) and `/mcp*`. Verified live: the dev proxy against a local SpicySrv copy
(`/api/config`, sign-up, sign-in in Chromium keeping the `__Host-` cookie on `http://localhost`,
`/ws/events` open, cloud repository present); and the LAN stack — SpicySrv's own `deploy/Caddyfile`
(`SPICY_TLS=internal`, `https://spicy.lan:8443`) in front of the built image and the API — in headless
Chromium with every other origin blocked: app and kernel, local save/reopen, sign-up, a cloud save,
`/ws/events`, zero external requests (`npm run smoke -- --url … --expect-server`). The banner was
checked on `http://spicy.lan` (a non-loopback name resolved to 127.0.0.1; a LAN IP is the same
insecure context), "public HTTPS" as the same image on that TLS origin — no real public host.
`?plugin=`/`?url=`/`?model=` allowlisting stays with CLOUD-17; fonts and `iconfont.js` were already
local.

## Dependencies and complexity

Dependencies: CLOUD-01, CLOUD-04. Complexity: medium.
