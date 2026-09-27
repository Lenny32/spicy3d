// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { AgentCloudInfo, AgentSaveOutcome, IAgentCloudLink } from "@spicy3d/ai";
import { type DocumentRepositoryError, type IDocument, Result } from "@spicy3d/core";
import type { CloudDocuments } from "../documents/cloudDocuments";
import type { CloudDocumentRepository, CloudVersion } from "../documents/repository";
import { previewOf } from "../history/previewRepository";

/** Versions looked through for `openVersion`, newest first (pages of 200). */
const MAX_VERSION_PAGES = 25;
const VERSION_PAGE_SIZE = 200;

const SIGNED_OUT: DocumentRepositoryError = { kind: "unauthorized" };

/**
 * The cloud side of the agent tools (CLOUD-15), lent to the ai module while signed in: opening
 * goes through `app.openDocument` (one copy per document, the edit lock, the sync's pending save),
 * a version through the history panel's preview, a save through the offline sync — kind `mcp`,
 * pushed right away, and a conflict left in the sync's hands (the tool hands it to the conflict UI).
 */
export class CloudAgentDocuments implements IAgentCloudLink {
    constructor(private readonly documents: CloudDocuments) {}

    private get repository(): CloudDocumentRepository | undefined {
        return this.documents.cloud;
    }

    async open(id: string): Promise<Result<IDocument, DocumentRepositoryError>> {
        const repository = this.repository;
        if (!repository) return Result.err(SIGNED_OUT);
        const document = await this.documents.app.openDocument(id, repository);
        // `Document.open` toasted why (offline without a copy, a newer format…).
        if (!document)
            return Result.err({
                kind: "failed",
                message: "The document could not be opened (the tab says why).",
            });
        return Result.ok(document);
    }

    async openVersion(id: string, versionId: string): Promise<Result<IDocument, DocumentRepositoryError>> {
        const repository = this.repository;
        if (!repository) return Result.err(SIGNED_OUT);
        const version = await this.findVersion(repository, id, versionId);
        if (!version.isOk) return Result.err(version.error);
        const open = [...this.documents.app.documents].find(
            (x) => x.id === id && x.repository === repository,
        );
        let name = open?.name;
        if (!name) {
            const stat = await repository.stat(id);
            name = (stat.isOk ? stat.value?.name : undefined) ?? id;
        }
        const panel = this.documents.openHistoryOf(id, name);
        if (!panel) return Result.err(SIGNED_OUT);
        const preview = await panel.history.showPreview(version.value);
        if (!preview.isOk) {
            return Result.err({
                kind: "failed",
                message: preview.error.message || "The preview was replaced.",
            });
        }
        return Result.ok(preview.value);
    }

    private async findVersion(
        repository: CloudDocumentRepository,
        id: string,
        versionId: string,
    ): Promise<Result<CloudVersion, DocumentRepositoryError>> {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_VERSION_PAGES; page++) {
            const listed = await repository.listVersions(id, { cursor, limit: VERSION_PAGE_SIZE });
            if (!listed.isOk) return Result.err(listed.error);
            const version = listed.value.items.find((x) => x.id === versionId);
            if (version) return Result.ok(version);
            cursor = listed.value.nextCursor;
            if (!cursor) break;
        }
        return Result.err({ kind: "notFound", id: versionId });
    }

    async save(document: IDocument, label?: string): Promise<AgentSaveOutcome> {
        const repository = this.repository;
        if (!repository || document.repository !== repository) return { status: "failed", error: SIGNED_OUT };
        const saved = await document.save("mcp", label ? { label } : {});
        if (!saved.isOk) return { status: "failed", error: saved.error };
        if (saved.value.status === "conflict") return { status: "conflict", conflict: saved.value };
        const sync = repository.sync;
        if (!sync) return { status: "saved", version: document.version };
        // Local first: the save is on this device; the agent waits for the upload (or its fate).
        const flushed = await sync.flush(document.id);
        if (flushed.isOk) return { status: "saved", version: document.version };
        switch (flushed.error.kind) {
            case "conflict":
                return {
                    status: "conflict",
                    conflict: repository.conflictOf(document.id) ?? { status: "conflict" },
                };
            case "offline":
                return { status: "pending", reason: "offline" };
            default:
                return { status: "failed", error: flushed.error };
        }
    }

    describe(document: IDocument): AgentCloudInfo | undefined {
        const preview = previewOf(document);
        if (preview) {
            return {
                readOnly: true,
                preview: { documentId: preview.documentId, versionId: preview.version.id },
            };
        }
        const repository = this.repository;
        if (!repository || document.repository !== repository) return undefined;
        const engine = this.documents.syncEngine;
        const info: AgentCloudInfo = {
            syncState: engine?.stateOf(document.id) ?? repository.stateOf(document.id),
            readOnly: repository.isReadOnly(document.id),
        };
        if (engine?.hasRemotePending(document.id)) info.remoteChangesPending = true;
        return info;
    }
}
