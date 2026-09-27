// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    compareDocuments,
    DOCUMENT_FILE_EXTENSION,
    DOCUMENT_FORMAT_VERSION,
    type DocumentChange,
    download,
    encodeDocumentFile,
    formatDateTime,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    Id,
    PubSub,
    Result,
    repositoryErrorMessage,
    type Serialized,
    saveDocumentCopy,
} from "@spicy3d/core";
import { div } from "@spicy3d/element";
import type {
    CloudDocumentRepository,
    CloudVersion,
    RestoredVersion,
    VersionUpdate,
} from "../documents/repository";
import style from "../ui/account.module.css";
import { Modal } from "../ui/modal";
import { versionTime } from "./historyModel";
import { previewOf, VersionPreviewRepository } from "./previewRepository";

export const PREVIEW_BANNER_ID = "cloud.history.preview";

/** A done restore: the new head, and the newer save it went on top of, if another got in first. */
export type RestoredOutcome = RestoredVersion;

/** Why a history action did not happen; `message` is already translated for a toast or the panel. */
export interface HistoryFailure {
    message: string;
    /** Superseded (a newer preview started, the history closed): nothing to report. */
    cancelled?: boolean;
}

/** What to do with unsaved changes of the open document before restoring a version. */
export type UnsavedBeforeRestore = "saveFirst" | "discard" | "cancel";

/**
 * When the open document is asked about: `before` the restore (save mine first = a version of
 * its own under the restore), or `after` it (edited while restoring: save mine first = a copy).
 */
export type RestoreStage = "before" | "after";

export interface VersionHistoryOptions {
    app: IApplication;
    repository: CloudDocumentRepository;
    documentId: string;
    /** The document's name (the open one's, which may be renamed meanwhile). */
    name: () => string;
    /** Asked before a restore when the open document has unsaved changes (replaced in tests). */
    askUnsaved?: (name: string, stage: RestoreStage) => Promise<UnsavedBeforeRestore>;
}

function failure(key: I18nKeys, ...args: unknown[]): HistoryFailure {
    return { message: I18n.translate(key, ...args) };
}

function repositoryFailure(error: Parameters<typeof repositoryErrorMessage>[0]): HistoryFailure {
    const [key, ...args] = repositoryErrorMessage(error);
    return failure(key, ...args);
}

/** A version saved by a newer Spicy3D: this build can't read it, so it isn't even downloaded. */
export function needsNewerApp(version: CloudVersion): boolean {
    return Number(version.formatVersion) > DOCUMENT_FORMAT_VERSION;
}

/**
 * "Restore" met unsaved changes in this tab: save them first (a version of their own, so nothing
 * is lost), discard them, or cancel.
 */
export function askUnsavedBeforeRestore(
    name: string,
    stage: RestoreStage = "before",
): Promise<UnsavedBeforeRestore> {
    return new Promise((resolve) => {
        new Modal({
            title: "cloud.history.unsavedTitle",
            content: [
                div({
                    className: style.muted,
                    textContent: I18n.translate(
                        stage === "before" ? "cloud.history.unsaved{0}" : "cloud.history.unsavedAfter{0}",
                        name,
                    ),
                }),
            ],
            onCancel: () => resolve("cancel"),
            actions: [
                { label: "common.cancel" },
                { label: "cloud.history.discardMine", kind: "danger", run: () => void resolve("discard") },
                {
                    label:
                        stage === "before" ? "cloud.history.saveMineFirst" : "cloud.history.keepMineAsCopy",
                    kind: "primary",
                    submit: true,
                    run: () => void resolve("saveFirst"),
                },
            ],
        }).open();
    });
}

/**
 * The actions of the version history of one cloud document (CLOUD-09).
 *
 * **Preview** opens the version as a *separate* document next to the open one, never in place of
 * it: the user's open document — unsaved edits, undo history, edit lock — is left untouched, so
 * nothing a preview does can lose work. The preview saves to a {@link VersionPreviewRepository}
 * (read-only: autosave skips it, Ctrl+S is refused), has an id of its own (never mistaken for the
 * cloud document) and goes through `app.loadDocument`, i.e. `Document.load`, so an older format is
 * migrated; a version of a newer format is refused before anything is downloaded. While it is the
 * active document a banner says so, with "Restore" and "Back to latest".
 *
 * **Restore** writes a new head (`kind: restore`, parent = the current head); the open document is
 * then reopened at it — after asking what to do with its unsaved changes, if it has any.
 */
export class VersionHistory {
    private preview?: IDocument;
    private disposed = false;
    /** Bumped by every preview request: an older one still loading gives way. */
    private previewToken = 0;
    /** The restore running: asking again (a double click) shares it. */
    private restoring?: Promise<Result<RestoredOutcome | undefined, HistoryFailure>>;
    /**
     * Told when the history changed (`restored`: a new head) or the preview did (`preview`), e.g.
     * by the banner's buttons: the panel reloads or re-renders.
     */
    onChanged?: (change: "restored" | "preview") => void;

    constructor(readonly options: VersionHistoryOptions) {
        PubSub.default.sub("activeViewChanged", this.updateBanner);
        PubSub.default.sub("documentClosed", this.onDocumentClosed);
    }

    get app() {
        return this.options.app;
    }

    get repository() {
        return this.options.repository;
    }

    get documentId() {
        return this.options.documentId;
    }

    /** The version shown in the preview, while one is open. */
    get previewed(): CloudVersion | undefined {
        return previewOf(this.preview)?.version;
    }

    get previewDocument(): IDocument | undefined {
        return this.preview;
    }

    /** The cloud document open in this tab (not a preview), if it is. */
    openDocument(): IDocument | undefined {
        return [...this.app.documents].find(
            (x) => x.id === this.documentId && x.repository === this.repository,
        );
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        PubSub.default.remove("activeViewChanged", this.updateBanner);
        PubSub.default.remove("documentClosed", this.onDocumentClosed);
        this.previewToken++;
        PubSub.default.pub("hideBanner", PREVIEW_BANNER_ID);
    }

    // ---- Content -----------------------------------------------------------------------------

    private async content(version: CloudVersion): Promise<Result<Serialized, HistoryFailure>> {
        if (needsNewerApp(version)) return Result.err(failure("cloud.history.needsUpdate"));
        const loaded = await this.repository.loadVersion(version);
        return loaded.isOk ? Result.ok(loaded.value) : Result.err(repositoryFailure(loaded.error));
    }

    private versionName(version: CloudVersion): string {
        return I18n.translate(
            "cloud.history.versionName{0}{1}",
            this.options.name(),
            formatDateTime(versionTime(version)),
        );
    }

    // ---- Preview -----------------------------------------------------------------------------

    /** Opens `version` read-only (replacing a preview already open); resolves the preview. */
    async showPreview(version: CloudVersion): Promise<Result<IDocument, HistoryFailure>> {
        const token = ++this.previewToken;
        const superseded = () => this.disposed || token !== this.previewToken;
        const cancelled: HistoryFailure = { message: "", cancelled: true };
        const data = await this.content(version);
        if (superseded()) return Result.err(cancelled);
        if (!data.isOk) return Result.err(data.error);
        await this.closePreview();
        if (superseded()) return Result.err(cancelled);
        const document = await this.app.loadDocument(
            { ...data.value, id: Id.generate(), name: this.versionName(version) },
            { repository: new VersionPreviewRepository(this.documentId, version), version: version.id },
        );
        if (superseded()) {
            // A newer preview (or the panel closing) came first: this one is no longer wanted.
            if (document && this.app.documents.has(document)) await document.close({ discardChanges: true });
            if (!this.preview) PubSub.default.pub("hideBanner", PREVIEW_BANNER_ID);
            return Result.err(cancelled);
        }
        // `Document.load` reported why (a migration failed…).
        if (!document) return Result.err(failure("cloud.history.previewFailed"));
        this.preview = document;
        this.updateBanner();
        this.onChanged?.("preview");
        return Result.ok(document);
    }

    /** Closes the preview (its edits are dropped: it never saves). */
    async closePreview(): Promise<void> {
        const preview = this.preview;
        this.preview = undefined;
        PubSub.default.pub("hideBanner", PREVIEW_BANNER_ID);
        if (preview && this.app.documents.has(preview)) await preview.close({ discardChanges: true });
        if (preview) this.onChanged?.("preview");
    }

    /** "Back to latest": closes the preview and shows the open document again. */
    async backToLatest(): Promise<void> {
        await this.closePreview();
        const open = this.openDocument();
        const view = open && this.app.views.find((x) => x.document === open);
        if (view) this.app.activeView = view;
    }

    private readonly updateBanner = () => {
        const preview = this.preview;
        const version = this.previewed;
        if (!preview || !version || this.app.activeView?.document !== preview) {
            PubSub.default.pub("hideBanner", PREVIEW_BANNER_ID);
            return;
        }
        PubSub.default.pub("showBanner", {
            id: PREVIEW_BANNER_ID,
            level: "info",
            message: "cloud.history.viewing{0}",
            args: [formatDateTime(versionTime(version))],
            dismissible: false,
            // While a restore runs, no buttons: a second click can't start another one.
            actions: this.restoring
                ? []
                : [
                      { label: "cloud.history.restore", run: () => void this.restoreAndReport(version) },
                      { label: "cloud.history.backToLatest", run: () => void this.backToLatest() },
                  ],
        });
    };

    private readonly onDocumentClosed = (document: IDocument) => {
        if (document !== this.preview) return;
        this.preview = undefined;
        PubSub.default.pub("hideBanner", PREVIEW_BANNER_ID);
        this.onChanged?.("preview");
    };

    // ---- Restore -----------------------------------------------------------------------------

    /**
     * A new head with `version`'s content. With unsaved changes in the open document, asks first:
     * save them first (their own version, then the restore on top), discard them, or cancel
     * (`undefined`, nothing done). Afterwards the preview closes and the document is reopened at
     * the new head.
     */
    restore(version: CloudVersion): Promise<Result<RestoredOutcome | undefined, HistoryFailure>> {
        if (!this.restoring) {
            const restoring = this.restoreOnce(version).finally(() => {
                if (this.restoring === restoring) this.restoring = undefined;
                this.updateBanner();
            });
            this.restoring = restoring;
            this.updateBanner();
        }
        return this.restoring;
    }

    private async restoreOnce(
        version: CloudVersion,
    ): Promise<Result<RestoredOutcome | undefined, HistoryFailure>> {
        if (needsNewerApp(version)) return Result.err(failure("cloud.history.needsUpdate"));
        if (this.repository.isReadOnly(this.documentId)) {
            return Result.err(failure("cloud.history.restoreReadOnly"));
        }
        const ask = this.options.askUnsaved ?? askUnsavedBeforeRestore;
        const open = this.openDocument();
        // The undo position the user decided about: edits after it are asked about once more.
        let decided: object | undefined;
        if (open) {
            await open.settled();
            decided = open.history.position();
            if (open.isDirty) {
                const choice = await ask(open.name, "before");
                if (choice === "cancel") return Result.ok(undefined);
                if (choice === "saveFirst") {
                    const saved = await open.save("manual");
                    decided = open.history.position();
                    if (!saved.isOk) return Result.err(repositoryFailure(saved.error));
                    if (saved.value.status === "conflict") {
                        await this.app.repositories.conflictHandler?.(open, saved.value);
                        return Result.err(failure("cloud.history.restoreConflict"));
                    }
                }
            }
        }

        const restored = await this.repository.restoreVersion(this.documentId, version);
        if (!restored.isOk) return Result.err(repositoryFailure(restored.error));

        await this.closePreview();
        const current = this.openDocument();
        if (current) {
            // Edited again while the restore ran: those edits are asked about too, never dropped silently.
            await current.settled();
            if (current.isDirty && (current !== open || current.history.position() !== decided)) {
                const choice = await ask(current.name, "after");
                if (choice === "cancel") {
                    // Keeps this tab's copy open as it is; its next save meets the new head (conflict dialog).
                    this.onChanged?.("restored");
                    return Result.ok(restored.value);
                }
                if (choice === "saveFirst") {
                    const name = I18n.translate("cloud.conflict.copyName{0}", current.name);
                    const copy = await saveDocumentCopy(this.app, current, this.repository, name);
                    if (!copy.isOk) {
                        this.onChanged?.("restored");
                        return Result.err(repositoryFailure(copy.error));
                    }
                }
            }
            await current.close({ discardChanges: true });
        }
        await this.app.openDocument(this.documentId, this.repository);
        this.onChanged?.("restored");
        return Result.ok(restored.value);
    }

    /** {@link restore}, toasting the outcome (the banner's button). */
    async restoreAndReport(version: CloudVersion): Promise<boolean> {
        const restored = await this.restore(version);
        if (!restored.isOk) {
            PubSub.default.pub("showToast", "cloud.history.failed{0}", restored.error.message);
            return false;
        }
        if (!restored.value) return false;
        const onTopOf = restored.value.onTopOf;
        if (onTopOf) {
            PubSub.default.pub(
                "showToast",
                "cloud.history.restoredOnTop{0}{1}",
                onTopOf.deviceName || I18n.translate("cloud.conflict.unknownDevice"),
                onTopOf.createdAt !== undefined && Number.isFinite(onTopOf.createdAt)
                    ? formatDateTime(onTopOf.createdAt)
                    : I18n.translate("cloud.conflict.unknownTime"),
            );
        } else {
            PubSub.default.pub(
                "showToast",
                "cloud.history.restored{0}",
                formatDateTime(versionTime(version)),
            );
        }
        return true;
    }

    // ---- Label, pin --------------------------------------------------------------------------

    async update(
        version: CloudVersion,
        change: VersionUpdate,
    ): Promise<Result<CloudVersion, HistoryFailure>> {
        const updated = await this.repository.updateVersion(version.id, change);
        return updated.isOk ? Result.ok(updated.value) : Result.err(repositoryFailure(updated.error));
    }

    // ---- Copies ------------------------------------------------------------------------------

    /** "Save as new document": a new cloud document (new id) with the version's content, opened. */
    async saveAsNew(version: CloudVersion): Promise<Result<string, HistoryFailure>> {
        const data = await this.content(version);
        if (!data.isOk) return Result.err(data.error);
        const id = Id.generate();
        const name = this.versionName(version);
        const saved = await this.repository.save({
            id,
            name,
            data: { ...data.value, id, name },
            kind: "manual",
        });
        if (!saved.isOk) return Result.err(repositoryFailure(saved.error));
        if (saved.value.status !== "saved") return Result.err(failure("cloud.history.copyFailed"));
        await this.app.openDocument(id, this.repository);
        return Result.ok(id);
    }

    /** "Download": the version as a `.spicy` file, as it was saved. */
    async download(version: CloudVersion): Promise<Result<void, HistoryFailure>> {
        const data = await this.content(version);
        if (!data.isOk) return Result.err(data.error);
        const blob = await encodeDocumentFile(data.value);
        // The UTC date keeps the file name free of locale separators ("/", ":").
        download(
            [blob],
            `${this.options.name()} ${version.createdAt.slice(0, 10)}${DOCUMENT_FILE_EXTENSION}`,
        );
        return Result.ok(undefined);
    }

    // ---- Compare -----------------------------------------------------------------------------

    /**
     * What changed from `version` to the current state: the open document as it is in this tab
     * (unsaved edits included), else the head version `head`.
     */
    async compareWithCurrent(
        version: CloudVersion,
        head: CloudVersion | undefined,
    ): Promise<Result<DocumentChange[], HistoryFailure>> {
        const open = this.openDocument();
        let current: Serialized;
        if (open) {
            current = open.serialize();
        } else {
            if (!head) return Result.err(failure("cloud.history.compareFailed"));
            const loaded = await this.content(head);
            if (!loaded.isOk) return Result.err(loaded.error);
            current = loaded.value;
        }
        const before = await this.content(version);
        if (!before.isOk) return Result.err(before.error);
        return this.diff(before.value, current);
    }

    /** What `version` changed compared to `previous` (the version before it). */
    async compareVersions(
        previous: CloudVersion,
        version: CloudVersion,
    ): Promise<Result<DocumentChange[], HistoryFailure>> {
        const before = await this.content(previous);
        if (!before.isOk) return Result.err(before.error);
        const after = await this.content(version);
        if (!after.isOk) return Result.err(after.error);
        return this.diff(before.value, after.value);
    }

    private diff(before: Serialized, after: Serialized): Result<DocumentChange[], HistoryFailure> {
        const changes = compareDocuments(before, after);
        return changes.isOk ? Result.ok(changes.value) : Result.err(failure("cloud.history.compareFailed"));
    }
}
