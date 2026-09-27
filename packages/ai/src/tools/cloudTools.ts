// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Cloud-aware MCP tools (CLOUD-15): open one of the user's cloud documents, start a new one, save
// as an `mcp` version. They exist only while the cloud module lends its link (signed in); the
// listing and the history are answered by the server itself (spicy3d_list_documents,
// spicy3d_document_history), so these names must never be one of the server's.

import {
    type DocumentRepositoryError,
    formatUtcIso,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    Logger,
    PubSub,
    type SaveConflict,
} from "@spicy3d/core";
import type { Tool, ToolCallContext } from "../llm/types";
import { type AgentCloudInfo, agentCloudLink, onAgentCloudChanged } from "./cloudLink";
import { getDocument } from "./documentContext";
import { OPEN_WAIT_MS, OpenConsent } from "./openConsent";

export const OPEN_DOCUMENT_TOOL = "spicy3d_open_document";
export const NEW_DOCUMENT_TOOL = "spicy3d_new_document";
export const SAVE_TOOL = "spicy3d_save";
/**
 * The listing through the local bridge only: over the relay, the server answers
 * spicy3d_list_documents itself (without a tab), so the tab's own listing is hidden there.
 */
export const LIST_CLOUD_DOCUMENTS_TOOL = "spicy3d_list_cloud_documents";
export const CLOUD_TOOL_NAMES = [
    OPEN_DOCUMENT_TOOL,
    LIST_CLOUD_DOCUMENTS_TOOL,
    NEW_DOCUMENT_TOOL,
    SAVE_TOOL,
] as const;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

/** The server keeps labels up to this length (SpicySrv `label_too_long`). */
export const LABEL_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 200;

/** The document as the agent is told about it: where it is stored and how far it is saved. */
export interface AgentDocumentInfo extends AgentCloudInfo {
    id: string;
    name: string;
    /** `local`: this browser only; `cloud`: the user's cloud library. */
    location: string;
    /** The version this tab's content is based on (cloud only). */
    headVersion?: string;
    /** Changes since the last save. */
    dirty: boolean;
}

function application(): IApplication | undefined {
    try {
        return globalThis.app;
    } catch {
        return undefined;
    }
}

export function describeDocument(document: IDocument): AgentDocumentInfo {
    const cloud = agentCloudLink()?.describe(document);
    const info: AgentDocumentInfo = {
        id: document.id,
        name: document.name,
        location: cloud?.preview ? "cloud" : document.repository.kind,
        dirty: document.isDirty,
        ...cloud,
    };
    if (document.version) info.headVersion = document.version;
    return info;
}

/** The document's storage metadata for the `spicy3d://document` resource; `undefined`: none open. */
export function documentStorageInfo(): AgentDocumentInfo | undefined {
    const document = getDocument();
    return document ? describeDocument(document) : undefined;
}

const error = (message: string) => JSON.stringify({ error: message });

const NOT_SIGNED_IN =
    "The user is not signed in to Spicy3D cloud in this tab, so cloud documents are not available. Ask them to sign in.";

/** Repository failures in the agent's words (the user sees the app's own toasts). */
export function describeRepositoryError(failure: DocumentRepositoryError): string {
    switch (failure.kind) {
        case "offline":
            return "The tab is offline (the server cannot be reached).";
        case "unauthorized":
            return "The user's session has expired: they must sign in again in the tab.";
        case "notFound":
            return `No cloud document with id "${failure.id}" (call spicy3d_list_documents).`;
        case "quota":
            return "The user's storage is full (server quota or this browser's storage).";
        case "readOnly":
            return failure.reason === "preview"
                ? "This is a read-only preview of an older version: it is never saved."
                : "Another tab of this browser is editing this document; this tab only shows it. Ask the user to edit it here (title bar: Edit here instead) or to use the other tab.";
        case "failed":
            return failure.message;
    }
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A label the server takes: trimmed, 1–200 characters, no control characters. */
function parseLabel(value: unknown): { label?: string; error?: string } {
    if (value === undefined || value === null) return {};
    if (typeof value !== "string") return { error: "label must be a string" };
    const label = value.trim();
    if (label === "") return {};
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (/[\u0000-\u001f\u007f]/.test(label)) return { error: "label must not contain control characters" };
    if (label.length > LABEL_MAX_LENGTH)
        return { error: `label must be at most ${LABEL_MAX_LENGTH} characters` };
    return { label };
}

/** Documents whose conflict UI an agent's save opened and that is still showing. */
const conflictsShown = new Set<string>();

function isInConflict(document: IDocument): boolean {
    return agentCloudLink()?.describe(document)?.syncState === "conflict";
}

/**
 * Hands a save conflict to the cloud's conflict UI, like the app's own Save command does — once: not
 * when the document already waited in conflict before the save (the user has been told, the title
 * bar shows it), nor while the UI an earlier save opened is still showing. Returns whether it opened.
 */
function showConflict(
    app: IApplication,
    document: IDocument,
    conflict: SaveConflict,
    wasInConflict: boolean,
) {
    if (wasInConflict || conflictsShown.has(document.id)) return false;
    const handler = app.repositories.conflictHandler;
    if (!handler) {
        PubSub.default.pub("showToast", "error.repository.conflict");
        return true;
    }
    conflictsShown.add(document.id);
    // Not awaited: the user resolves it whenever they want; the agent is told it waits.
    void handler(document, conflict)
        .catch((err) => Logger.warn(`[mcp] conflict UI failed: ${err}`))
        .finally(() => conflictsShown.delete(document.id));
    return true;
}

/** The "save first" of the open prompt: a manual save of the document the user was looking at. */
async function saveCurrent(app: IApplication, document: IDocument): Promise<boolean> {
    const wasInConflict = isInConflict(document);
    const saved = await document.save("manual");
    if (!saved.isOk) {
        Logger.warn(`[mcp] saving ${document.name} before opening failed: ${saved.error.kind}`);
        return false;
    }
    if (saved.value.status === "conflict") {
        showConflict(app, document, saved.value, wasInConflict);
        return false;
    }
    return true;
}

/** Whether switching away from `document` asks the user first: unsaved changes that can be saved. */
function hasSavableChanges(document: IDocument): boolean {
    if (!document.isDirty) return false;
    if (agentCloudLink()?.describe(document)?.preview) return false;
    return !(document.repository.isReadOnly?.(document.id) ?? false);
}

export interface CloudToolOptions {
    /** Default: one question per page, shared by every MCP connection. */
    consent?: OpenConsent;
    /** How long one call waits for the user's answer (default {@link OPEN_WAIT_MS}). */
    waitMs?: number;
}

const PAGE_CONSENT = new OpenConsent();

// Signing out ends every question an agent asked, and forgets the conflict UIs it opened.
onAgentCloudChanged(() => {
    if (agentCloudLink()) return;
    PAGE_CONSENT.cancel();
    conflictsShown.clear();
});

/** The MCP session `caller` ended: the open question it asked (if any) closes. */
export function forgetCloudCaller(caller: string): void {
    PAGE_CONSENT.forgetCaller(caller);
}

async function openDocument(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    context: ToolCallContext | undefined,
    consent: OpenConsent,
    waitMs: number,
): Promise<string> {
    const id = stringArg(args, "id");
    if (!id) return error("id is required: a document id from spicy3d_list_documents");
    if (args["version"] !== undefined && typeof args["version"] !== "string") {
        return error("version must be a version id from spicy3d_document_history");
    }
    const version = stringArg(args, "version");
    const app = application();
    const link = agentCloudLink();
    const cloud = app?.repositories.cloud;
    if (!app || !link || !cloud) return error(NOT_SIGNED_IN);

    const active = getDocument();
    if (!version && active && active.id === id && active.repository === cloud) {
        return JSON.stringify({ opened: true, alreadyActive: true, document: describeDocument(active) });
    }

    const stored = await statOf(cloud, id);
    if (typeof stored === "string") return error(stored);
    if (stored.trashed) {
        return error(
            `"${stored.name ?? id}" is in the trash: ask the user to restore it first (Home, Trash).`,
        );
    }

    // A version opens as a separate read-only preview: the active document stays as it is.
    if (!version && active && hasSavableChanges(active)) {
        const decision = await consent.request(
            id,
            { current: active.name, target: stored.name ?? id },
            () => saveCurrent(app, active),
            waitMs,
            signal,
            context?.caller,
        );
        if (decision === "waiting") {
            return JSON.stringify({
                opened: false,
                status: "waitingForUser",
                message: `"${active.name}" has unsaved changes, so the user is being asked in the tab whether to save them before "${stored.name ?? id}" opens. Nothing was opened yet. Call ${OPEN_DOCUMENT_TOOL} again with the same arguments to keep waiting for their answer.`,
            });
        }
        if (decision === "declined") {
            return error(
                `Declined: the user chose not to open "${stored.name ?? id}" now ("${active.name}" has unsaved changes). Do not retry unless they ask you to.`,
            );
        }
        if (decision === "saveFailed") {
            return error(
                `The user chose to save "${active.name}" first, but that save did not go through (the tab shows why), so "${stored.name ?? id}" was not opened.`,
            );
        }
    }

    const opened = version ? await link.openVersion(id, version) : await link.open(id);
    if (!opened.isOk) {
        return error(
            opened.error.kind === "notFound" && version
                ? `No version "${version}" of document "${id}" (call spicy3d_document_history).`
                : describeRepositoryError(opened.error),
        );
    }
    app.activeView?.cameraController.fitContent();
    const result: Record<string, unknown> = { opened: true, document: describeDocument(opened.value) };
    if (version) {
        result["readOnly"] = true;
        result["note"] =
            "This is a read-only preview of an older version (the history view's preview): look, measure and take screenshots, but edits here are never saved. To edit, open the document without a version (its latest).";
    }
    return JSON.stringify(result);
}

async function statOf(
    cloud: IDocumentRepository,
    id: string,
): Promise<string | { name?: string; trashed?: boolean }> {
    if (!cloud.stat) return {};
    const stat = await cloud.stat(id);
    if (!stat.isOk) return describeRepositoryError(stat.error);
    if (!stat.value) return describeRepositoryError({ kind: "notFound", id });
    return stat.value;
}

async function newDocument(args: Record<string, unknown>): Promise<string> {
    if (typeof args["name"] !== "string" || args["name"].trim() === "") return error("name is required");
    const name = args["name"].trim();
    if (name.length > NAME_MAX_LENGTH) return error(`name must be at most ${NAME_MAX_LENGTH} characters`);
    const app = application();
    const cloud = app?.repositories.cloud;
    if (!app || !agentCloudLink() || !cloud) return error(NOT_SIGNED_IN);
    const document = await app.newDocument(name, cloud);
    return JSON.stringify({
        created: true,
        document: describeDocument(document),
        note: `Empty, and not in the cloud yet: it is created there by the first ${SAVE_TOOL}.`,
    });
}

async function listCloudDocuments(args: Record<string, unknown>): Promise<string> {
    if (args["query"] !== undefined && typeof args["query"] !== "string")
        return error("query must be a string");
    const rawLimit = args["limit"];
    if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit))) {
        return error("limit must be an integer");
    }
    const limit = Math.min(
        Math.max((rawLimit as number | undefined) ?? LIST_LIMIT_DEFAULT, 1),
        LIST_LIMIT_MAX,
    );
    const app = application();
    const cloud = app?.repositories.cloud;
    if (!app || !agentCloudLink() || !cloud) return error(NOT_SIGNED_IN);
    const page = await cloud.list({ search: stringArg(args, "query"), limit });
    if (!page.isOk) return error(describeRepositoryError(page.error));
    const documents = page.value.items.map((meta) => ({
        id: meta.id,
        name: meta.name,
        updatedAt: formatUtcIso(meta.updatedAt),
        ...(meta.sizeBytes !== undefined && { sizeBytes: meta.sizeBytes }),
        ...(meta.headVersion && { headVersionId: meta.headVersion }),
        ...(meta.syncState && meta.syncState !== "synced" && { syncState: meta.syncState }),
    }));
    return JSON.stringify({ documents, ...(page.value.nextCursor && { more: true }) });
}

/** What the version became, when it isn't simply the agent's labelled one. */
function savedAs(kind: string | undefined, asked: string | undefined, label: string | undefined) {
    if (!kind) return {};
    const result: Record<string, unknown> = { kind, ...(label && { label }) };
    if (kind !== "mcp") {
        result["note"] =
            `The user's own save joined this one, so it is stored as a ${kind} version${asked ? " and your label was not kept" : ""}.`;
    }
    return result;
}

async function save(args: Record<string, unknown>): Promise<string> {
    const { label, error: labelError } = parseLabel(args["label"]);
    if (labelError) return error(labelError);
    const app = application();
    const link = agentCloudLink();
    if (!app || !link) return error(NOT_SIGNED_IN);
    const document = getDocument();
    if (!document) return error("No open document: open one with spicy3d_open_document or create one first.");

    if (link.describe(document)?.preview) {
        return error(
            `"${document.name}" is a read-only preview of an older version and is never saved. Open the latest with ${OPEN_DOCUMENT_TOOL} (no version) to edit and save; restoring an old version is the user's decision (version history).`,
        );
    }
    if (document.repository !== app.repositories.cloud) {
        const saved = await document.save("mcp");
        if (!saved.isOk) return error(describeRepositoryError(saved.error));
        return JSON.stringify({
            saved: true,
            location: document.repository.kind,
            note: "This document is stored in this browser only, so it has no cloud version history and the label was not kept. The user can move it to the cloud (title bar: Save to cloud).",
        });
    }

    const wasInConflict = isInConflict(document);
    const outcome = await link.save(document, label);
    switch (outcome.status) {
        case "saved":
            return JSON.stringify({
                saved: true,
                uploaded: true,
                ...(outcome.version && { version: outcome.version }),
                ...(outcome.kind ? savedAs(outcome.kind, label, outcome.label) : label && { label }),
                document: describeDocument(document),
            });
        case "pending":
            return JSON.stringify({
                saved: true,
                uploaded: false,
                ...savedAs(outcome.kind, label, outcome.label),
                message:
                    "Saved in this browser, but the tab is offline: the version is uploaded once the connection is back.",
            });
        case "conflict": {
            const shown = showConflict(app, document, outcome.conflict, wasInConflict);
            const told = shown
                ? "The user has been shown the conflict in the tab"
                : "The user already has the conflict in front of them (the tab shows it)";
            return error(
                `Conflict pending user resolution: this document was changed elsewhere meanwhile, and the changes could not be merged on their own. ${told} and decides how to resolve it; do not try to resolve it or work around it (no new document, no re-creating the edits). Your save is kept in this browser; call spicy3d_save again once the user says it is resolved.`,
            );
        }
        case "failed":
            return error(describeRepositoryError(outcome.error));
    }
}

/** The cloud tools; the MCP server lists them only while {@link agentCloudLink} is set. */
export function buildCloudTools(options: CloudToolOptions = {}): Tool[] {
    const consent = options.consent ?? PAGE_CONSENT;
    const waitMs = options.waitMs ?? OPEN_WAIT_MS;
    return [
        {
            name: OPEN_DOCUMENT_TOOL,
            description:
                "Open one of the user's cloud documents in their Spicy3D tab (id from spicy3d_list_documents, or spicy3d_list_cloud_documents where that is listed), making it the document every other tool acts on; one already open is just brought to the front. With version (from spicy3d_document_history), opens that older version as a read-only preview instead. If the document the user has in front of them has unsaved changes, the user is asked first: the result can then be status waitingForUser (call again with the same arguments to keep waiting) or an error saying they declined.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Document id from spicy3d_list_documents" },
                    version: {
                        type: "string",
                        description: "Version id from spicy3d_document_history: open it read-only",
                    },
                },
                required: ["id"],
            },
            handler: (args, signal, context) => openDocument(args, signal, context, consent, waitMs),
        },
        {
            name: LIST_CLOUD_DOCUMENTS_TOOL,
            description:
                "List the user's cloud documents (id, name, last update in UTC, size), most recently updated first, as the tab sees them — the ids spicy3d_open_document takes.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Only documents whose name contains this" },
                    limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT_MAX },
                },
            },
            handler: (args) => listCloudDocuments(args),
        },
        {
            name: NEW_DOCUMENT_TOOL,
            description:
                "Create a new, empty cloud document in the user's Spicy3D tab and make it the active one. It is stored in the cloud by its first spicy3d_save.",
            parameters: {
                type: "object",
                properties: { name: { type: "string", description: "Document name" } },
                required: ["name"],
            },
            handler: (args) => newDocument(args),
        },
        {
            name: SAVE_TOOL,
            description:
                "Save the active document as a new version in the user's cloud history, marked as an agent save, optionally labelled (labelled versions are never pruned). Waits until the version is uploaded. If someone else changed the document meanwhile and it cannot be merged on its own, the user is shown the conflict and the result is an error: the user resolves it, never the agent.",
            parameters: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        description: `Short label of the version (at most ${LABEL_MAX_LENGTH} characters), e.g. what was changed`,
                    },
                },
            },
            handler: (args) => save(args),
        },
    ];
}
