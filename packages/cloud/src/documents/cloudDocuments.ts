// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    Logger,
    PubSub,
    TitleBar,
} from "@spicy3d/core";
import type { SignOutEvent } from "../account/account";
import type { CloudConnection } from "../cloud";
import { defaultBlobCache, type IBlobCache } from "./blobCache";
import { showConflictDialog } from "./conflictDialog";
import { keepChangesAfterSignOut } from "./documentActions";
import { EditLocks } from "./editLocks";
import { CloudDocumentRepository, type CloudDocumentRepositoryOptions } from "./repository";
import { DocumentStatusItem } from "./statusItem";

export interface CloudDocumentsOptions {
    cache?: IBlobCache;
    locks?: EditLocks;
    /** Repository options for tests (thumbnail encoding, split thresholds…). */
    repository?: Partial<CloudDocumentRepositoryOptions>;
    /** Mount the title bar status (default true). */
    titleBar?: boolean;
}

/**
 * Cloud documents for a connected server: while signed in, `app.repositories.cloud` is a
 * {@link CloudDocumentRepository}, new documents go to the cloud when the device setting says so,
 * a stale save opens the conflict dialog, each open cloud document is locked to one tab, and the
 * title bar shows the active document's status. Signing out stops all of it and, unless the user
 * keeps offline copies, clears the cached cloud documents; local documents are never touched.
 * Returns the teardown.
 */
export class CloudDocuments {
    readonly cache: IBlobCache;
    readonly locks: EditLocks;
    private repository?: CloudDocumentRepository;
    private readonly statusItem?: DocumentStatusItem;
    private readonly removeSignOutHandler: () => void;

    constructor(
        readonly connection: CloudConnection,
        readonly app: IApplication,
        private readonly options: CloudDocumentsOptions = {},
    ) {
        this.cache = options.cache ?? defaultBlobCache();
        this.locks = options.locks ?? new EditLocks();
        this.locks.handoverHandler = this.beforeHandover;
        this.removeSignOutHandler = this.account.addSignOutHandler(this.onSignOut);
        this.account.onPropertyChanged(this.onAccountChanged);
        this.account.deviceSettings.onPropertyChanged(this.applyPreferred);
        PubSub.default.sub("documentOpened", this.onDocumentOpened);
        PubSub.default.sub("documentClosed", this.onDocumentClosed);
        PubSub.default.sub("documentRepositoryChanged", this.onRepositoryChanged);
        if (options.titleBar !== false) {
            this.statusItem = new DocumentStatusItem({
                app,
                locks: this.locks,
                repository: () => this.repository,
                takeOver: this.takeOver,
                resolveConflict: this.resolveConflict,
            });
            // Left of the account button.
            TitleBar.items.push(this.statusItem);
            TitleBar.items.move(TitleBar.items.length - 1, 0);
        }
        this.sync();
    }

    get account() {
        return this.connection.account;
    }

    get cloud(): CloudDocumentRepository | undefined {
        return this.repository;
    }

    dispose(): void {
        this.removeSignOutHandler();
        this.account.removePropertyChanged(this.onAccountChanged);
        this.account.deviceSettings.removePropertyChanged(this.applyPreferred);
        PubSub.default.remove("documentOpened", this.onDocumentOpened);
        PubSub.default.remove("documentClosed", this.onDocumentClosed);
        PubSub.default.remove("documentRepositoryChanged", this.onRepositoryChanged);
        if (this.statusItem) TitleBar.items.remove(this.statusItem);
        this.stop();
        this.locks.dispose();
    }

    private readonly onAccountChanged = (property: string | number | symbol) => {
        if (property === "status") this.sync();
    };

    /** Signed in: the cloud repository is there. An expired session keeps it (saves wait for re-login). */
    private sync() {
        if (!this.account.isSignedIn || this.repository) return;
        this.repository = new CloudDocumentRepository({
            account: this.account,
            config: this.connection.config,
            cache: this.cache,
            editGuard: this.locks,
            ...this.options.repository,
        });
        const repository = this.repository;
        this.app.repositories.conflictHandler = (document, conflict) =>
            showConflictDialog(this.app, document, conflict, repository);
        this.app.repositories.cloud = repository;
        this.applyPreferred();
        for (const document of this.app.documents) this.onDocumentOpened(document);
    }

    private readonly applyPreferred = () => {
        const cloud = this.repository && this.account.deviceSettings.newDocumentLocation === "cloud";
        this.app.repositories.preferred = cloud ? "cloud" : "local";
    };

    private stop() {
        const repository = this.repository;
        if (!repository) return;
        for (const document of this.app.documents) {
            if (document.repository === repository) this.locks.release(document.id);
        }
        this.repository = undefined;
        if (this.app.repositories.cloud === repository) this.app.repositories.cloud = undefined;
        this.app.repositories.conflictHandler = undefined;
        this.app.repositories.preferred = "local";
    }

    /**
     * Signed out: the open cloud documents belong to that account, so they close — never into
     * another user's account, never losing changes silently: unsaved ones are first offered as a
     * copy on this device or a `.spicy` download.
     */
    private readonly onSignOut = async ({ removeCachedDocuments }: SignOutEvent) => {
        const repository = this.repository;
        const open = [...this.app.documents].filter((x) => repository && x.repository === repository);
        this.stop();
        for (const document of open) {
            await document.settled();
            if (document.isDirty) await keepChangesAfterSignOut(this.app, document);
            await document.close({ discardChanges: true });
        }
        if (removeCachedDocuments) await this.cache.clear();
    };

    private readonly onDocumentOpened = (document: IDocument) => {
        if (!this.repository || document.repository !== this.repository) return;
        void this.locks.acquire(document.id).then((mode) => {
            if (mode === "readOnly") PubSub.default.pub("showToast", "cloud.status.openedReadOnly");
        });
    };

    private readonly onDocumentClosed = (document: IDocument) => {
        if (document.repository !== this.repository) return;
        this.locks.release(document.id);
        this.repository?.resetState(document.id);
    };

    /** Moved to the cloud: this tab takes the edit lock; moved away: it lets go. */
    private readonly onRepositoryChanged = (document: IDocument, previous: IDocumentRepository) => {
        if (previous === this.repository && document.repository !== previous) {
            this.locks.release(document.id);
            this.repository?.resetState(document.id);
        }
        this.onDocumentOpened(document);
    };

    /** The editing tab, asked to hand over: saves unsaved changes first so nothing is lost. */
    private readonly beforeHandover = async (id: string) => {
        const document = [...this.app.documents].find((x) => x.id === id && x.repository === this.repository);
        if (!document) return;
        // A save already running must finish first; the one below then bases on it.
        await document.settled();
        if (!document.isDirty) return;
        const saved = await document.save("auto");
        if (!saved.isOk || saved.value.status !== "saved") {
            Logger.warn(`[cloud] ${id}: could not save before handing it over`);
        }
    };

    /** The dialog of the conflict the last save met — an autosave opens none by itself. */
    readonly resolveConflict = async (document: IDocument) => {
        const repository = this.repository;
        if (!repository || document.repository !== repository) return;
        await document.settled();
        const conflict = repository.conflictOf(document.id);
        if (conflict) await showConflictDialog(this.app, document, conflict, repository);
    };

    /**
     * "Edit here instead": takes the document from the other tab. If that tab saved meanwhile and
     * nothing changed here, the latest version is reopened (the undo history is cleared); with
     * changes here, the next save meets the usual conflict dialog.
     */
    readonly takeOver = async (document: IDocument) => {
        const repository = this.repository;
        if (!repository || !(await this.locks.takeOver(document.id))) return;
        const head = await repository.headVersion(document.id);
        if (!head.isOk || head.value === document.version || document.isDirty) return;
        await document.close({ discardChanges: true });
        await this.app.openDocument(document.id, repository);
    };
}

/** Starts cloud documents for the connection; returns the teardown. */
export function startCloudDocuments(
    connection: CloudConnection,
    app: IApplication,
    options?: CloudDocumentsOptions,
): () => void {
    const documents = new CloudDocuments(connection, app, options);
    return () => documents.dispose();
}
