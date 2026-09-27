// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

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

/** Why a save happens; the cloud keeps manual saves forever and prunes autosaves. */
export type SaveKind = "manual" | "auto";

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
}

export type SaveOutcome =
    | { status: "saved"; updatedAt: number; version?: string }
    | { status: "conflict"; headVersion?: string };

/** Expected failures of a repository; unexpected ones are reported as `failed`. */
export type DocumentRepositoryError =
    | { kind: "offline" }
    | { kind: "unauthorized" }
    | { kind: "notFound"; id: string }
    | { kind: "quota" }
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
    delete(id: string): Promise<Result<void, DocumentRepositoryError>>;
}

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

    get(location: DocumentLocation): IDocumentRepository | undefined {
        return location === "local" ? this.local : this.cloud;
    }

    all(): IDocumentRepository[] {
        return this.cloud ? [this.local, this.cloud] : [this.local];
    }
}
