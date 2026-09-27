# CLOUD-14: Remote MCP — Page Link

## Summary

Client side of remote MCP. The modelling engine keeps running **only in the user's browser tab**; the server is a pass-through relay (SRV-09). An MCP client connects to `https://<server>/mcp` with a personal access token; the server forwards JSON-RPC to the user's open, signed-in tab. No tab open → no tools (only a `spicy3d_connect` hint).

## How it works today

- The page runs an MCP **server** (`packages/ai/src/mcp/server.ts`) over a **WebSocket client transport** connecting out to the local bridge (`packages/ai/src/mcp/session.ts`, capped backoff reconnect).
- The stdio bridge (`packages/mcp-bridge/src/bridge.mjs`) relays JSON-RPC, replays `initialize` to late tabs, exposes `spicy3d_connect` while no tab is connected; calls serialized with `SerialQueue`.

## Scope

- **Remote mode** in the MCP panel (`packages/ai/src/mcp/panel.ts`): when signed in and `/api/config.features.mcp`, the tab connects its existing WebSocket transport to `wss://<server>/ws/mcp-page` (same-origin cookie auth). Local-bridge mode stays available and unchanged.
- Tab registration message: `{ tabId, documentId, documentName, deviceName, focused }`; update on document switch and window focus (server uses "most recently focused tab" as default target).
- **Pairing confirmation**: first call from a new MCP session shows an in-tab prompt "*<client name>* (token *<name>*) wants to control this tab — Allow / Deny"; remembered per session.
- **Agent indicator**: visible badge while an MCP session is bound to this tab, with **Disconnect agent**.
- **Screenshots**: `capture_screenshot` (`packages/ai/src/tools/viewTools.ts:94`) already returns image content; ensure it passes through unchanged (base64 image block). Add a max size/resolution option and JPEG/WebP encoding to keep payloads reasonable over the relay (server limit SRV-09).
- **Token management UI** (account settings): create/revoke personal access tokens (SRV-10), shown once.
- **Config generator**: ready-to-paste configs using the server URL + a new token:
  - Claude Code: `claude mcp add --transport http spicy3d https://<server>/mcp --header "Authorization: Bearer <token>"`
  - JSON for Cursor / VS Code / other HTTP-capable clients
  - stdio fallback: `spicy3d-mcp-bridge --server https://<server> ` with `SPICY3D_TOKEN` env (below)
- **Bridge `--server` mode** (`packages/mcp-bridge`): stdio ⇄ Streamable HTTP proxy with the token, for clients that only support stdio. Same binary; no local WebSocket listener in this mode.

## Things to think about

- Tool calls from the agent run in the user's live document → labeled transactions ("Agent: extrude") so undo is understandable; saves go through sync with `kind: mcp` metadata.
- Tab closed / reloaded mid-call → server returns a JSON-RPC error; on reload the tab re-registers and `initialize` is replayed by the server.
- Multiple tabs: agent can list/select via server tools (SRV-09); the tab UI shows which tab is targeted.
- Which MCP clients can reach the server: clients connecting **from the workstation** (Claude Code, Cursor, VS Code, stdio bridge) work on the LAN; clients whose connectors run in the vendor's cloud only work once the server is public (and then need OAuth — SRV-10 phase 2).

## Acceptance criteria

- [x] Claude Code connected to `/mcp` with a token can list tools, edit the open document and receive screenshots — no local bridge running.
- [x] Opening the tab after the client connected works; reloading the tab mid-session recovers.
- [x] Pairing prompt appears once per MCP session; Deny makes calls fail with a clear error.
- [x] Disconnect agent ends the binding immediately.
- [x] Stdio-only client works through `spicy3d-mcp-bridge --server`.
- [x] Local-bridge mode still works.

Implementation notes (CLOUD-14 branch): `packages/ai/src/mcp/` — SDK-free `remote.ts` /
`remoteState.ts` (link, state, client configs), `pairing.ts` (prompt + `PairingGate`),
`agentBadge.ts` (title bar), the panel's *Through the server* mode; lazy `remoteSession.ts` +
`pageTransport.ts` (the SRV-09 page protocol; a plain WebSocket because the relay accepts no `mcp`
subprotocol, which the SDK's client transport asks for) and `tabInfo.ts`. `packages/cloud/src/mcp/`
(`startCloudMcp`, called by `useCloud`) hands the link over while signed in with `features.mcp`; a
token created with an `mcp:*` scope shows the three configs filled in. Pairing asks on the first
request of a session that is not initialize/ping/a listing (so `tools/list` works before the user
answers), remembered per session id in the tab's `sessionStorage` (a reload does not ask again);
Deny answers with JSON-RPC `-32005`. Screenshots stay lossless PNG by default; `format`/`maxSize`/
`quality` are new arguments, and an image over the relay's `maxMessageBytes` is re-encoded (JPEG,
then smaller). `spicy3d-mcp-bridge --server` (`remote.mjs`, no dependencies, token in
`SPICY3D_TOKEN`). Live, against a local SpicySrv (PostgreSQL in Docker, the real app in headless
Chromium behind a same-origin proxy, the SDK client over Streamable HTTP): every box above — and
Claude Code itself (`claude -p` with the generated `type: http` config) created a box, received the
screenshot and read the document back after one Allow; sign-out closes the tab's socket (1008) and
the client falls back to `spicy3d_connect`. Not done: labeled "Agent: …" transactions and `kind: mcp`
saves (no tool saves yet); the badge lives in the title bar, which the home screen covers; with
several sessions on one tab, the SDK server keeps the client capabilities of the last `initialize`
(only `ask_user`'s elicitation depends on them).

## Dependencies and complexity

Dependencies: CLOUD-05, SRV-09, SRV-10. Complexity: medium-high.
