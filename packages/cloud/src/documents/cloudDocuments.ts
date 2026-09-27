// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    Id,
    Logger,
    PubSub,
    type ResolutionChoice,
    SidePanels,
    TitleBar,
} from "@spicy3d/core";
import type { SignOutEvent } from "../account/account";
import type { CloudConnection } from "../cloud";
import { VersionHistoryPanel } from "../history/historyPanel";
import { previewOf } from "../history/previewRepository";
import { VersionHistory } from "../history/versionHistory";
import { EventsChannel } from "../sync/events";
import { SyncEngine, type SyncEngineOptions } from "../sync/syncEngine";
import { defaultSyncStore, type ISyncStore } from "../sync/syncStore";
import { defaultBlobCache, type IBlobCache } from "./blobCache";
import { type ConflictSyncActions, showConflictDialog } from "./conflictDialog";
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
    /** The offline sync's records (default: IndexedDB). */
    store?: ISyncStore;
    /** The events WebSocket (default: `config.eventsSocket`, where the browser has WebSockets); `false`: none. */
    events?: EventsChannel | false;
    /** Sync engine options for tests (backoff, timers, activity…). */
    sync?: Partial<SyncEngineOptions>;
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
    readonly store: ISyncStore;
    private repository?: CloudDocumentRepository;
    private engine?: SyncEngine;
    private historyPanel?: VersionHistoryPanel;
    private readonly statusItem?: DocumentStatusItem;
    private readonly removeSignOutHandler: () => void;

    constructor(
        readonly connection: CloudConnection,
        readonly app: IApplication,
        private readonly options: CloudDocumentsOptions = {},
    ) {
        this.cache = options.cache ?? defaultBlobCache();
        this.store = options.store ?? defaultSyncStore();
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
                openHistory: (document) => void this.openHistory(document),
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

    /** The offline sync while signed in. */
    get syncEngine(): SyncEngine | undefined {
        return this.engine;
    }

    /** The version history panel, while one is open. */
    get history(): VersionHistoryPanel | undefined {
        return this.historyPanel;
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
        this.engine = new SyncEngine({
            app: this.app,
            repository,
            store: this.store,
            locks: this.locks,
            events: this.createEvents(),
            ...this.options.sync,
        });
        this.engine.start();
        this.app.repositories.conflictHandler = (document, conflict) =>
            showConflictDialog(this.app, document, conflict, repository, this.conflictActions(document));
        this.app.repositories.cloud = repository;
        this.applyPreferred();
        for (const document of this.app.documents) this.onDocumentOpened(document);
    }

    private createEvents(): EventsChannel | undefined {
        if (this.options.events === false) return undefined;
        if (this.options.events) return this.options.events;
        if (typeof WebSocket === "undefined") return undefined;
        return new EventsChannel({
            url: this.connection.config.eventsSocket,
            baseUrl: this.connection.client.baseUrl,
            account: this.account,
        });
    }

    private readonly applyPreferred = () => {
        const cloud = this.repository && this.account.deviceSettings.newDocumentLocation === "cloud";
        this.app.repositories.preferred = cloud ? "cloud" : "local";
    };

    private stop() {
        const repository = this.repository;
        if (!repository) return;
        void this.closeHistory();
        this.engine?.stop();
        this.engine = undefined;
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
        const pending = (await this.engine?.pendingRecords()) ?? [];
        const pendingIds = new Set(pending.map((x) => x.docId));
        // Kept offline copies keep their pending saves too: pushed when this user signs in again.
        const unsynced = removeCachedDocuments ? pendingIds : new Set<string>();
        this.stop();
        for (const document of open) {
            await document.settled();
            if (document.isDirty || unsynced.has(document.id))
                await keepChangesAfterSignOut(this.app, document);
            await document.close({ discardChanges: true });
        }
        if (removeCachedDocuments && repository) {
            // Saved here but never pushed, and not open: kept on this device instead of being lost.
            const closed = pending.filter((x) => !open.some((d) => d.id === x.docId));
            for (const record of closed) await this.keepOnDevice(repository, record.docId, record.name);
            await this.cache.clear();
            await this.store.clear();
        }
    };

    /** A pending save of a closed document, as a new document on this device. */
    private async keepOnDevice(repository: CloudDocumentRepository, docId: string, name: string) {
        const loaded = await this.loadPending(repository, docId);
        if (!loaded) return;
        const id = Id.generate();
        const saved = await this.app.repositories.local.save({
            id,
            name,
            data: { ...loaded, id, name },
            kind: "manual",
        });
        if (saved.isOk) PubSub.default.pub("showToast", "cloud.sync.keptOnDevice{0}", name);
        else Logger.warn(`[cloud] ${docId}: the unsynced changes could not be kept (${saved.error.kind})`);
    }

    private async loadPending(repository: CloudDocumentRepository, docId: string) {
        const record = await this.store.get(docId);
        const sha = record?.localSnapshot?.manifestSha256;
        const bytes = sha ? await this.cache.get(sha) : undefined;
        if (!bytes) return undefined;
        const assembled = await repository.assemble(JSON.parse(new TextDecoder().decode(bytes)));
        return assembled.isOk ? assembled.value : undefined;
    }

    private readonly onDocumentOpened = (document: IDocument) => {
        if (!this.repository || document.repository !== this.repository) return;
        const engine = this.engine;
        void this.locks.acquire(document.id).then((mode) => {
            if (mode === "readOnly") PubSub.default.pub("showToast", "cloud.status.openedReadOnly");
            // Synced by this tab once it holds the lock; a read-only tab only shows newer versions.
            if (engine === this.engine) engine?.documentOpened(document);
        });
    };

    private readonly onDocumentClosed = (document: IDocument) => {
        if (document.repository !== this.repository) return;
        this.repository?.resetState(document.id);
        // Its lock goes, unless it still has changes to push (pushed in the background first).
        if (this.engine) void this.engine.documentClosed(document);
        else this.locks.release(document.id);
    };

    /** Moved to the cloud: this tab takes the edit lock; moved away: it lets go. */
    private readonly onRepositoryChanged = (document: IDocument, previous: IDocumentRepository) => {
        if (previous === this.repository && document.repository !== previous) {
            this.locks.release(document.id);
            this.repository?.resetState(document.id);
        }
        this.onDocumentOpened(document);
    };

    /** What the MVP conflict dialog does through the sync (a conflict met by the offline sync). */
    private conflictActions(document: IDocument): ConflictSyncActions | undefined {
        const engine = this.engine;
        if (!engine) return undefined;
        const id = document.id;
        return {
            hold: () => engine.hold(id),
            discardMine: () => engine.discardLocal(id),
            keepMine: () => engine.keepMine(id),
            mergeKeepingMine: engine.syncConflictOf(id)?.result
                ? async () => {
                      const conflict = engine.syncConflictOf(id);
                      const choices = (conflict?.result?.conflicts ?? []).map((x) => ({
                          path: x.path,
                          choice: keepMineChoice(x.choices),
                      }));
                      const resolved = await engine.resolve(id, choices);
                      return resolved.isOk;
                  }
                : undefined,
        };
    }

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
        if (conflict) {
            await showConflictDialog(
                this.app,
                document,
                conflict,
                repository,
                this.conflictActions(document),
            );
        }
    };

    /**
     * "Edit here instead": takes the document from the other tab. If that tab saved meanwhile and
     * nothing changed here, the latest version is reopened (the undo history is cleared); with
     * changes here, the next save meets the usual conflict dialog.
     */
    readonly takeOver = async (document: IDocument) => {
        const repository = this.repository;
        if (!repository || !(await this.locks.takeOver(document.id))) return;
        // The other tab may have left a save it couldn't push: this tab opens and pushes it.
        const pending = (await this.store.get(document.id))?.localDirty === true;
        const head = await repository.headVersion(document.id);
        const moved = head.isOk && head.value !== document.version;
        if ((!moved && !pending) || document.isDirty) {
            this.engine?.documentOpened(document);
            return;
        }
        await document.close({ discardChanges: true });
        await this.app.openDocument(document.id, repository);
    };

    /**
     * "Version history" of a cloud document (or of the one a preview shows): the side panel next
     * to the viewport, one at a time — opening another document's closes the first.
     */
    readonly openHistory = (document: IDocument): VersionHistoryPanel | undefined => {
        const repository = this.repository;
        if (!repository) return undefined;
        const documentId = previewOf(document)?.documentId ?? document.id;
        if (!previewOf(document) && document.repository !== repository) return undefined;
        if (this.historyPanel?.history.documentId === documentId) return this.historyPanel;
        void this.closeHistory();
        const fallbackName = document.name;
        const history = new VersionHistory({
            app: this.app,
            repository,
            documentId,
            name: () =>
                [...this.app.documents].find((x) => x.id === documentId && x.repository === repository)
                    ?.name ?? fallbackName,
        });
        const panel = new VersionHistoryPanel({
            history,
            retention: this.connection.config.storage.autosaveRetention,
            onClose: () => void this.closeHistory(),
        });
        this.historyPanel = panel;
        SidePanels.items.push(panel);
        return panel;
    };

    /** Closes the history panel, and the version it previews. */
    readonly closeHistory = async (): Promise<void> => {
        const panel = this.historyPanel;
        if (!panel) return;
        this.historyPanel = undefined;
        SidePanels.items.remove(panel);
        await panel.history.closePreview();
        panel.history.dispose();
    };
}

/**
 * "Keep mine" for one conflict: this device's side when offered, else this device's first (both
 * kept), else as merged (a dangling reference or a rebuild failure, fixed afterwards).
 */
export function keepMineChoice(choices: readonly ResolutionChoice[]): ResolutionChoice {
    if (choices.includes("ours")) return "ours";
    if (choices.includes("ours-first")) return "ours-first";
    return choices.includes("accept") ? "accept" : choices[0];
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
