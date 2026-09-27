// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Skill } from "./types";

/** MCP clients only: the in-app assistant has no cloud tools. */
export const cloudDocuments: Skill = {
    name: "cloud-documents",
    description:
        "Working with the user's cloud library through MCP: find a document, open it, edit, check with a screenshot, save a labelled version; unsaved-changes prompts, read-only previews, conflicts",
    content: `Cloud documents (MCP, while the user is signed in to Spicy3D cloud in the tab).

Who answers what depends on how you are connected:
- Through the Spicy3D server (remote MCP, an access token): spicy3d_list_documents { query?, limit? } and spicy3d_document_history { id, limit? } are answered by the server itself — with no tab open, only the token owner's documents (ids, names, UTC times, sizes; versions with kind manual/auto/merge/restore/mcp, label, device). They exist only for a token the user created with "Let agents list documents and history" (the documents:read scope, which also lets the token read every document's content); if they are not listed, ask the user which document to open, or to create a token with that option. spicy3d_list_tabs / spicy3d_select_tab choose which open tab the tab tools act on (default: the most recently focused one). With no tab connected the server answers the tab tools with an error asking the user to open Spicy3D in their browser and sign in — relay that to the user, don't retry in a loop.
- Through the local bridge (the spicy3d-mcp-bridge on the user's computer): spicy3d_list_cloud_documents { query?, limit? } lists the documents through the tab. There is no history tool on this connection: a version id has to come from the user.
- spicy3d_open_document, spicy3d_new_document and spicy3d_save run in the user's tab, like every modelling tool.

Workflow:
1. Find: spicy3d_list_documents (or spicy3d_list_cloud_documents) { query: "bracket" } → pick the id. Ask the user when several match.
2. Open: spicy3d_open_document { id }. The tab switches to it; the document the user had in front of them stays open in its own view tab. If that document has unsaved changes, the user is asked first:
   - result status "waitingForUser": nothing was opened yet; call spicy3d_open_document again with the same arguments to keep waiting (do nothing else meanwhile);
   - an error saying they declined: stop and tell the user; don't retry unless they ask.
3. Look before editing: read the spicy3d://document resource or call get_document_state; capture_screenshot to see it.
4. Edit with the modelling tools (run_program, set_node_properties, …). Every change lands on the user's undo stack.
5. Verify: select_nodes + fit_content + capture_screenshot, and query ops for dimensions (mm, degrees).
6. Save: spicy3d_save { label: "what changed, in a few words" }. The version is marked as an agent save (kind mcp) in the user's history; a label keeps it from ever being pruned. The call waits for the upload:
   - saved + uploaded: done — the history shows the new version. The result's kind says what it was stored as: mcp is yours; when the user's own save joined it (they saved, or their autosave ran with their own edits) it is their manual/auto version and your label is dropped;
   - saved but not uploaded: the tab is offline; it uploads by itself later;
   - error "Conflict pending user resolution": someone saved another change meanwhile and it could not be merged automatically. The user is shown the conflict and decides. Never resolve it yourself, never recreate the edits elsewhere to get around it; tell the user and wait. Once they say it is resolved, spicy3d_save again if there is anything left to save.

New documents: spicy3d_new_document { name } creates an empty cloud document and makes it active; it exists in the cloud after its first spicy3d_save.

Older versions: spicy3d_open_document { id, version } (a version id from spicy3d_document_history) opens that version as a read-only preview, beside the document — the user's open document is not touched, so nothing is asked — look, measure, screenshot, compare. It can't be saved (spicy3d_save refuses it); restoring an old version is the user's decision, from the version history.

Where things stand: the spicy3d://document resource has a "document" entry — id, name, location (cloud or local), headVersion (the version the tab's content is based on), dirty (unsaved changes), syncState (clean, dirty, pushing, offline, conflict, …), readOnly (another browser tab edits it), preview. A local document (stored in this browser only) saves locally: no cloud history, no label.`,
};
