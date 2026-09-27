# Spicy3D Cloud — Client Roadmap

Client-side (this repository) tickets for the Spicy3D cloud: optional accounts, cloud storage with full version history, conflict-safe merging, autosave, and a remote MCP endpoint that relays to the user's open browser tab.

**Server tickets live in the server repository** (`Lenny32/SpicySrv`, private, C# / ASP.NET Core): `tickets/`. Tickets here reference them as `SRV-NN`.

## Product decisions (agreed)

| Topic | Decision |
|-------|----------|
| Name | Application renamed **Spicy3D** everywhere (npm scope `@spicy3d/*`, MCP `spicy3d_*` / `spicy3d://`, IndexedDB, WASM, C++, repo). Clean start: no migration of Chili3D-era local data. |
| Version | Restart at **0.0.1**; document format restarts at **1**. Chili3D files are not supported. |
| Accounts | Optional. Anyone can sign up. No paywall; every feature works without an account except cloud storage and remote MCP. |
| Local | Users can always save and open local documents (browser storage and file download/upload), signed in or not. |
| Privacy | A user can only see and use **their own** documents. No sharing. Admins manage accounts, never document content. |
| GDPR | Users can delete their account and all data (not prominently placed). Data export is included for portability (Art. 20). |
| History | Every cloud document keeps its version history, with a dedicated **history view**. Manual saves are kept forever; **autosaves are pruned**. |
| Autosave | Every **5 minutes** by default, configurable. The setting is stored on the server when signed in, locally otherwise. |
| Dates | Server stores and returns **UTC only**; the client displays in the local computer's locale and time zone. Local documents keep today's behaviour. |
| MCP | Remote MCP is a **pass-through**: the modelling engine only runs in the user's browser. No tab open = no MCP tools. Screenshots (`capture_screenshot`) flow through the relay. |
| Network | LAN-only now, public server later → everything configurable, nothing hard-wired to either. |
| Email | SMTP2GO in production, `rnwood/smtp4dev` for local tests (server side, SRV-04). |

## Tickets

| # | Ticket | Packages | Complexity | Depends on |
|---|--------|----------|-----------|-----------|
| 1 | [Rename to Spicy3D & restart versioning](done/1-rename-to-spicy3d.md) | all | M-H | – |
| 2 | [Document format & migration framework](done/2-document-format-migrations.md) | core, app | M | 1 |
| 3 | [Document repository abstraction](done/3-document-repository-abstraction.md) | core, app, ui | M | 2 |
| 4 | [API client & server contract](done/4-api-client-contract.md) | cloud | M | SRV-01 |
| 5 | [Account UI](done/5-account-ui.md) | cloud, ui, i18n | M-H | 4, SRV-03 |
| 6 | [Cloud documents integration](done/6-cloud-documents.md) | cloud, ui, app | M-H | 3, 5, SRV-05 |
| 7 | [Autosave](done/7-autosave.md) | app, cloud, ui | M | 3, 6, SRV-06 |
| 8 | [Date & time display](done/8-date-time-display.md) | core, ui | S | 4 |
| 9 | [Version history view](done/9-version-history-view.md) | cloud, ui | M-H | 6, 8 |
| 10 | [Offline-first sync](done/10-offline-sync.md) | cloud | H | 6 |
| 11 | [Merge model design](done/11-merge-model-design.md) | design | H | 2 |
| 12 | [Merge engine](done/12-merge-engine.md) | core, parametric | H | 11 |
| 13 | [Conflict resolution UI](13-conflict-resolution-ui.md) | ui, cloud | H | 10, 12 |
| 14 | [Remote MCP — page link](14-remote-mcp-page-link.md) | ai, mcp-bridge | M-H | 5, SRV-09 |
| 15 | [Cloud-aware MCP tools](15-cloud-mcp-tools.md) | ai | M | 6, 14 |
| 16 | [Deployment readiness (LAN now, public later)](16-deployment-readiness.md) | web, ai, builder | M | 1, 4 |
| 17 | [Client security](17-client-security.md) | web, core, ai | M | 5, 14 |

## Suggested sequence

```
A. Rename & foundations (no server needed)
   1 rename ─► 2 format/migrations ─► 3 repository refactor ─► 16 readiness
B. Accounts & cloud MVP (with SRV-01…06)
   4 API client ─► 5 account UI ─► 6 cloud documents ─► 7 autosave, 8 dates ─► 9 history view
   (stale save = 409 → "open latest / save mine as a copy")
C. Conflicts
   11 merge design ─► 12 engine ─► 10 sync ─► 13 conflict UI
D. Remote MCP (with SRV-09, SRV-10)
   14 page link ─► 15 cloud tools
E. 17 security review before going public
```

## Who can conflict with whom?

Documents are never shared, so conflicts only arise between **the same user's** sessions:

- two devices (desktop + laptop), one of them offline for a while;
- two browser tabs;
- the user and an MCP agent driving another tab/device.

That still needs a real 3-way merge (offline edits are the main case), but it rules out permission-related conflict kinds and makes "whose change is this?" a device/session question rather than a person question.
