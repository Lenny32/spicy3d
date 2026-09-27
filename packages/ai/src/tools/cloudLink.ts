// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free: what the cloud module lends the agent tools while the user is signed in (CLOUD-15).
// The cloud package depends on this one, never the reverse, so the tools only see this interface.

import type { DocumentRepositoryError, IDocument, Result, SaveConflict } from "@spicy3d/core";

/** The cloud side of a document, as the agent is told about it. */
export interface AgentCloudInfo {
    /** The sync's state of it (`clean`, `dirty`, `pushing`, `offline`, `conflict`, …). */
    syncState?: string;
    /** A newer version from another device waits until the user is done. */
    remoteChangesPending?: boolean;
    /** Another tab of this browser edits it: this one only shows it. */
    readOnly?: boolean;
    /** An older version shown from the history (never saved). */
    preview?: { documentId: string; versionId: string };
}

/** How an agent's save ended once the sync had its go at it. */
export type AgentSaveOutcome =
    /**
     * On the server; `version` is the new head, `kind` / `label` what it was stored as (not `mcp`
     * when the user's own save joined it; unknown when omitted).
     */
    | { status: "saved"; version?: string; kind?: string; label?: string }
    /** Kept on this device; uploaded when the connection is back, as `kind` / `label`. */
    | { status: "pending"; reason: "offline"; kind?: string; label?: string }
    /** Someone else saved meanwhile and the changes could not be merged on their own. */
    | { status: "conflict"; conflict: SaveConflict }
    | { status: "failed"; error: DocumentRepositoryError };

export interface IAgentCloudLink {
    /** Opens the latest version of a cloud document in this tab (or shows it, when it is open). */
    open(id: string): Promise<Result<IDocument, DocumentRepositoryError>>;
    /** Opens an older version read-only, as the version history's preview does. */
    openVersion(id: string, versionId: string): Promise<Result<IDocument, DocumentRepositoryError>>;
    /**
     * Saves a cloud document as an `mcp` version (with `label`) through the offline sync and waits
     * until it is uploaded, merged with a newer head, or stuck.
     */
    save(document: IDocument, label?: string): Promise<AgentSaveOutcome>;
    /** The cloud side of `document`; `undefined` when it is not a cloud document. */
    describe(document: IDocument): AgentCloudInfo | undefined;
}

let current: IAgentCloudLink | undefined;
const listeners = new Set<() => void>();

/** Set by the cloud module while someone is signed in; `undefined` hides the cloud tools again. */
export function setAgentCloudLink(link: IAgentCloudLink | undefined): void {
    if (current === link) return;
    current = link;
    for (const listener of [...listeners]) listener();
}

export function agentCloudLink(): IAgentCloudLink | undefined {
    return current;
}

/** How many listeners are registered (tests: servers must not leak theirs). */
export function agentCloudListenerCount(): number {
    return listeners.size;
}

/** Called whenever the link comes or goes (the MCP server announces a changed tool list). */
export function onAgentCloudChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
