# CLOUD-15: Cloud-Aware MCP Tools

## Summary

Let agents work with the user's cloud library, not just the document already open — still executed in the user's tab (no server-side engine).

## Tools

Answered by the **server** (SRV-09, no tab needed, only the token owner's documents):
- `spicy3d_list_documents { query? }` → id, name, updatedAt (UTC), size
- `spicy3d_document_history { id, limit? }`
- `spicy3d_list_tabs` / `spicy3d_select_tab`

Relayed to the **tab** (this ticket):
- `spicy3d_open_document { id, version? }` — opens in the bound tab (asks the user if the current document has unsaved changes; the agent gets "waiting for user" / "declined")
- `spicy3d_new_document { name }`
- `spicy3d_save { label? }` — manual save through sync, version tagged `mcp`; a conflict is shown **to the user**, the agent receives "conflict pending user resolution" (agents never resolve merges)
- existing modelling + `capture_screenshot` tools unchanged

## Scope

- Implement relayed tools in `packages/ai/src/tools/`, hidden in local-bridge mode when not signed in.
- Update `buildMcpInstructions()` and skills with the open → edit → screenshot → save workflow.
- `spicy3d://document` resource includes cloud metadata (id, head version, dirty, location).

## Acceptance criteria

- [x] Agent lists documents, opens one, edits, captures a screenshot, saves with a label; history shows an `mcp` version.
- [x] Server-side tools work with no tab open; relayed tools return a clear "open Spicy3D in your browser" error.
- [x] Unsaved-changes prompt blocks `open_document` until the user answers.

Implementation notes (CLOUD-15 branch): `packages/ai/src/tools/cloudTools.ts` (the three tools,
MCP only — the in-app assistant has no cloud tools), SDK-free `cloudLink.ts` (`IAgentCloudLink`,
lent by `CloudDocuments` while signed in as `CloudAgentDocuments`, `packages/cloud/src/mcp/`) and
`openConsent.ts` (the prompt). "Hidden when not signed in" applies to both connections: the tools are
listed through the local bridge too once signed in, and the server sends `tools/list_changed` when
the sign-in comes or goes. Choices made:
- `spicy3d_open_document` keeps the app's multi-document model: the other document stays open in its
  own view tab, so the prompt is *Save and open* / *Open, keep unsaved* / *Cancel* (declined). A call
  waits up to 45 s (below the 60 s MCP clients give a request and the relay's 120 s), then answers
  `status: waitingForUser`; the retry with the same arguments waits for the same question (an answer
  given in between is kept 5 min). One question per page; asking about another document closes it.
  Calls are serialized, so everything else waits too (tested). `version` opens the history panel's
  read-only preview (`CloudDocuments.openHistoryOf`), like the history view; `spicy3d_save` refuses it.
- `spicy3d_new_document` always creates a cloud document (the tools exist only while signed in, and a
  local document has no history for an `mcp` version); stored by its first save.
- `spicy3d_save`: `IDocument.save("mcp", { label })` (new `SaveOptions`) through the offline sync, then
  `sync.flush` so the agent learns the outcome: uploaded (new head id), offline (kept on the device,
  uploaded later), conflict (handed to `repositories.conflictHandler` — the MVP dialog here, CLOUD-13's
  panel once merged — and the agent gets "Conflict pending user resolution…"), or the failure. A local
  document saves locally (no label, told so). Kind precedence: a pending manual save still wins; a push
  merged with a newer head is a `merge` version.
- `spicy3d://document` adds `document`: id, name, location, headVersion (what the tab's content is based
  on), dirty, syncState, readOnly, preview. MCP clients also get the `cloud-documents` skill
  (`MCP_SKILLS`) and a cloud section in `buildMcpInstructions()`. Tokens created from the MCP panel now
  include `documents:read` (the server's list/history tools need it).
- Not done: "Agent: …" transaction labels (the tools' undo steps are already named "AI …").

Review fixes: tokens from the MCP panel no longer include `documents:read` (least privilege — it
also opens every document to the REST API); the token dialog offers it as the explicit opt-in "Let
agents list documents and history (also grants read access to all document content)", and the
instructions / skill say list and history need it. The local bridge gets its own
`spicy3d_list_cloud_documents` (through the tab's cloud repository; hidden on the relay, where the
server's tool exists) and connection-specific instructions. A save conflict opens the conflict UI
once per document. The server's sign-in listener no longer leaks per reconnect attempt. Save kinds
and labels shared by one write follow core's `combineSaves` (manual wins, else the latest save's
kind, a label only with its own kind), and `spicy3d_save` reports the kind stored. The open question
closes with the session that asked or on sign-out; opening a version never asks.

Live, against a SpicySrv copy (PostgreSQL in Docker, the built app in headless Chromium behind a
same-origin proxy, the SDK client over Streamable HTTP with a token): after one Allow the client saw the
three tab tools next to the server's; created "Live Bracket" + box + `spicy3d_save {label}`; left a
second document with unsaved changes; `spicy3d_list_documents` found the first; `spicy3d_open_document`
showed the prompt and returned only after "Save and open" was clicked 3 s later; added a box, received
the JPEG screenshot, the resource showed `location: cloud`, `dirty: true`, `syncState`, `headVersion`;
`spicy3d_save {label: "Agent: added a boss"}` → `spicy3d_document_history` listed both versions as
`kind: mcp` with their labels; a version opened read-only and its save was refused; with the tab closed
the list showed only the server's tools, `spicy3d_list_documents` still answered, and
`spicy3d_open_document` failed with the relay's "No Spicy3D tab is connected. Ask the user to open …
in their browser and sign in …" (-32000). Conflicts were checked with the fake server (unit tests), not
live.

## Dependencies and complexity

Dependencies: CLOUD-06, CLOUD-14, SRV-09. Complexity: medium.
