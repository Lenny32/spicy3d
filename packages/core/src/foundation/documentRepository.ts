// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { I18nKeys } from "../i18n";
import type { Serialized } from "../serialize";
import { Observable } from "./observer";
import type { Result } from "./result";

/** Where a document is persisted. */
export type DocumentLocation = "local" | "cloud";

/** Sync status of a cloud document (filled in by the offline sync, CLOUD-10). */
export type SyncState = "synced" | "pending" | "offline" | "conflict";

/** One entry of a repository listing. */
export interface DocumentMeta {
    id: string;
    name: string;
    /** Last save, epoch milliseconds (cloud: parsed from the server's UTC timestamp). */
    updatedAt: number;
    /** Image URL (a `data:` URL for local documents). */
    thumbnail?: string;
    location: DocumentLocation;
    /** Cloud only: the head version id. */
    headVersion?: string;
    /** Cloud only. */
    syncState?: SyncState;
    /** Cloud only: size of the latest version (manifest and blobs, uncompressed), in bytes. */
    sizeBytes?: number;
    /** Cloud trash only: when the document was moved to the trash, epoch milliseconds. */
    deletedAt?: number;
}

export interface DocumentListQuery {
    /** `nextCursor` of the previous page; omitted for the first page. */
    cursor?: string;
    /** Case-insensitive substring filter on the name. */
    search?: string;
    /** Page size; the repository picks its default when omitted. */
    limit?: number;
}

/** A page of a listing, most recently updated first. */
export interface DocumentPage {
    items: DocumentMeta[];
    /** Pass as `cursor` for the next page; `undefined` on the last page. */
    nextCursor?: string;
}

export interface LoadedDocument {
    data: Serialized;
    /** Cloud only: the version that was loaded, to send back as the base of the next save. */
    version?: string;
}

/**
 * Why a save happens (the server's `VersionKind`): the cloud keeps manual saves forever and prunes
 * autosaves; `merge` and `restore` are written by the sync and the history view, `mcp` by an agent.
 */
export type SaveKind = "manual" | "auto" | "merge" | "restore" | "mcp";

/** Extras of `IDocument.save`. */
export interface SaveOptions {
    /** Cloud only: the label of the version (labelled versions are never pruned). */
    label?: string;
}

export interface SaveRequest {
    id: string;
    name: string;
    data: Serialized;
    kind: SaveKind;
    /** Captured by the app layer (the repository never touches views). */
    thumbnail?: string;
    /**
     * Cloud only: the version the edits are based on (`If-Match`). A save based on a version
     * that is no longer the head answers `conflict` instead of overwriting.
     */
    baseVersion?: string;
    /** Cloud only: an optional label of the version (labelled versions are never pruned). */
    label?: string;
}

/** A save that was refused because another save moved the head first (cloud only). */
export interface SaveConflict {
    status: "conflict";
    /** The current head, to base the next save on. */
    headVersion?: string;
    /** When the head was saved, epoch milliseconds. */
    headCreatedAt?: number;
    /** The device that saved the head, as it named itself. */
    headDeviceName?: string;
}

export type SaveOutcome = { status: "saved"; updatedAt: number; version?: string } | SaveConflict;

/** Expected failures of a repository; unexpected ones are reported as `failed`. */
export type DocumentRepositoryError =
    | { kind: "offline" }
    | { kind: "unauthorized" }
    | { kind: "notFound"; id: string }
    | { kind: "quota" }
    /**
     * The document is being edited in another tab of this browser and this one only shows it, or
     * (`reason: "preview"`) it is an older version shown from the history, which is never saved.
     */
    | { kind: "readOnly"; reason?: "preview" }
    | { kind: "failed"; message: string };

/**
 * Document-level persistence: the browser's storage today, the cloud once signed in. Every
 * expected failure (offline, 401, 404, 409 as a `conflict` outcome, quota) is a `Result`.
 */
export interface IDocumentRepository {
    readonly kind: DocumentLocation;
    list(query?: DocumentListQuery): Promise<Result<DocumentPage, DocumentRepositoryError>>;
    load(id: string): Promise<Result<LoadedDocument, DocumentRepositoryError>>;
    save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>>;
    /** Deletes the document; the cloud moves it to the trash (see `restore`). */
    delete(id: string): Promise<Result<void, DocumentRepositoryError>>;
    /** Renames without saving a new version (cloud: metadata only). */
    rename?(id: string, name: string): Promise<Result<void, DocumentRepositoryError>>;
    /** The trash: deleted documents that can still be restored, most recently deleted first. */
    listTrash?(query?: DocumentListQuery): Promise<Result<DocumentPage, DocumentRepositoryError>>;
    /** Brings a document back from the trash. */
    restore?(id: string): Promise<Result<void, DocumentRepositoryError>>;
    /** Days a deleted document stays restorable, when the repository has a trash. */
    readonly trashRetentionDays?: number;
    /**
     * The image URL of a listed document's thumbnail when `meta.thumbnail` isn't set (the cloud
     * downloads it on demand); `undefined` when it has none.
     */
    thumbnailUrl?(meta: DocumentMeta): Promise<string | undefined>;
    /**
     * Whether a document with this id is stored (without loading it); `undefined` when not. The
     * cloud also counts a document in the trash. Without it, callers fall back to `load`.
     */
    stat?(id: string): Promise<Result<StoredDocumentInfo | undefined, DocumentRepositoryError>>;
    /**
     * Whether this tab may only show the document (the cloud: another tab edits it), so saving it
     * would answer `readOnly`; autosave skips it. Without it, every document is writable.
     */
    isReadOnly?(id: string): boolean;
}

/** See `IDocumentRepository.stat`. */
export interface StoredDocumentInfo {
    name?: string;
    /** Cloud: the head version, to save a replacement on top of. */
    version?: string;
    /** Cloud: in the trash (restore it before saving). */
    trashed?: boolean;
}

/**
 * Resolves a save that answered `conflict` (the cloud's "a newer version was saved" dialog). The
 * cloud module registers it while signed in; without it the conflict is only reported.
 */
export type SaveConflictHandler = (document: IDocument, conflict: SaveConflict) => Promise<void>;

/** The repositories available to the application: local always, cloud while signed in. */
export class DocumentRepositories extends Observable {
    constructor(readonly local: IDocumentRepository) {
        super();
    }

    get cloud(): IDocumentRepository | undefined {
        return this.getPrivateValue("cloud", undefined);
    }
    set cloud(value: IDocumentRepository | undefined) {
        this.setProperty("cloud", value);
    }

    /** Where new documents go: the cloud when signed in and so configured, this device otherwise. */
    get preferred(): DocumentLocation {
        return this.getPrivateValue("preferred", "local");
    }
    set preferred(value: DocumentLocation) {
        this.setProperty("preferred", value);
    }

    /** See {@link SaveConflictHandler}. */
    conflictHandler: SaveConflictHandler | undefined;

    /** The repository new documents save to: `preferred`, falling back to local. */
    forNewDocuments(): IDocumentRepository {
        return this.get(this.preferred) ?? this.local;
    }

    get(location: DocumentLocation): IDocumentRepository | undefined {
        return location === "local" ? this.local : this.cloud;
    }

    all(): IDocumentRepository[] {
        return this.cloud ? [this.local, this.cloud] : [this.local];
    }
}

/** The toast (key and arguments) telling the user why a repository operation failed. */
export function repositoryErrorMessage(error: DocumentRepositoryError): [I18nKeys, ...unknown[]] {
    switch (error.kind) {
        case "offline":
            return ["error.repository.offline"];
        case "unauthorized":
            return ["error.repository.unauthorized"];
        case "notFound":
            return ["error.repository.notFound"];
        case "quota":
            return ["error.repository.quota"];
        case "readOnly":
            return [
                error.reason === "preview" ? "error.repository.readOnlyPreview" : "error.repository.readOnly",
            ];
        case "failed":
            return ["error.repository.failed:{0}", error.message];
    }
}
