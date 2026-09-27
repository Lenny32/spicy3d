// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    AutosaveSettings,
    AutosaveStatus,
    type IApplication,
    type IDocument,
    type IFileAutosave,
    type IService,
    Logger,
    PubSub,
    type Result,
    type SaveKind,
} from "@spicy3d/core";
import { autosaveToOriginFile, fileAutosave } from "../documentFiles";

export interface AutosaveServiceOptions {
    settings?: AutosaveSettings;
    status?: AutosaveStatus;
    /** The per-file opt-in of opened `.spicy` files. */
    files?: IFileAutosave;
    /** Writes a document back to its `.spicy` file. */
    writeFile?: (document: IDocument) => Promise<Result<void>>;
    /** How often a deferred autosave checks whether the user is done, in ms (default 1000). */
    idleCheckMs?: number;
    /** Whether a modal dialog is open (default: any open `<dialog>`). */
    isDialogOpen?: () => boolean;
    now?: () => number;
}

/** What one autosave did. */
export type AutosaveOutcome = "saved" | "skipped" | "conflict" | "failed";

interface Watched {
    /** When the document became dirty (or was last autosaved while staying dirty); the timer counts from it. */
    since?: number;
    timer?: ReturnType<typeof setTimeout>;
    /** Due, but the user was busy: runs as soon as they are done. */
    waiting: boolean;
    saving: boolean;
    /** The version an autosave met a conflict on: no autosave until the version changes. */
    conflictVersion?: string | null;
    unsubscribe: () => void;
}

const MINUTE = 60_000;

const anyDialogOpen = () => globalThis.document?.querySelector("dialog[open]") != null;

/**
 * Saves dirty documents on their own, `AutosaveSettings.intervalMinutes` after they became dirty
 * (or after the last autosave), never while the user is in the middle of something — a command, a
 * drag (pointer pressed), a modal dialog, an {@link AutosaveHolds} hold (sketch session) — but right
 * after it ends. A save of any kind makes the document clean and so restarts its timer.
 *
 * Targets: a cloud document gets a version of kind `auto`; a local one overwrites its copy in this
 * browser; a document opened from a `.spicy` file is written back to that file only when the user
 * turned that on for it (and not saved at all otherwise: the file is where it lives). Read-only
 * documents (edited in another tab) are skipped. An autosave that meets a conflict shows it in the
 * status but opens no dialog, and waits until the document's version changes (the user resolved it).
 * Offline, the next interval tries again (CLOUD-10 will write to the offline cache instead).
 */
export class AutosaveService implements IService {
    private app?: IApplication;
    private readonly watched = new Map<IDocument, Watched>();
    private readonly settings: AutosaveSettings;
    private readonly status: AutosaveStatus;
    private readonly files: IFileAutosave;
    private readonly writeFile: (document: IDocument) => Promise<Result<void>>;
    private readonly isDialogOpen: () => boolean;
    private readonly now: () => number;
    private readonly idleCheckMs: number;
    private idlePoll?: ReturnType<typeof setInterval>;
    private pointerDown = false;
    private removeHoldListener?: () => void;

    constructor(options: AutosaveServiceOptions = {}) {
        this.settings = options.settings ?? AutosaveSettings.current;
        this.status = options.status ?? AutosaveStatus.current;
        this.files = options.files ?? fileAutosave;
        this.writeFile = options.writeFile ?? autosaveToOriginFile;
        this.isDialogOpen = options.isDialogOpen ?? anyDialogOpen;
        this.now = options.now ?? (() => Date.now());
        this.idleCheckMs = options.idleCheckMs ?? 1000;
    }

    register(app: IApplication): void {
        this.app = app;
    }

    start(): void {
        this.status.fileAutosave ??= this.files;
        PubSub.default.sub("documentOpened", this.watch);
        PubSub.default.sub("documentClosed", this.unwatch);
        PubSub.default.sub("documentSaved", this.onSaved);
        PubSub.default.sub("documentRepositoryChanged", this.onRepositoryChanged);
        this.settings.onPropertyChanged(this.onSettingsChanged);
        this.app?.onPropertyChanged(this.onAppChanged);
        this.removeHoldListener = AutosaveHolds.onReleased(this.resumeIfIdle);
        globalThis.addEventListener?.("pointerdown", this.onPointerDown, true);
        globalThis.addEventListener?.("pointerup", this.onPointerUp, true);
        globalThis.addEventListener?.("pointercancel", this.onPointerUp, true);
        globalThis.addEventListener?.("blur", this.onPointerUp);
        globalThis.document?.addEventListener("visibilitychange", this.onVisibilityChange);
        for (const document of this.app?.documents ?? []) this.watch(document);
        Logger.info(`${AutosaveService.name} started`);
    }

    stop(): void {
        PubSub.default.remove("documentOpened", this.watch);
        PubSub.default.remove("documentClosed", this.unwatch);
        PubSub.default.remove("documentSaved", this.onSaved);
        PubSub.default.remove("documentRepositoryChanged", this.onRepositoryChanged);
        this.settings.removePropertyChanged(this.onSettingsChanged);
        this.app?.removePropertyChanged(this.onAppChanged);
        this.removeHoldListener?.();
        globalThis.removeEventListener?.("pointerdown", this.onPointerDown, true);
        globalThis.removeEventListener?.("pointerup", this.onPointerUp, true);
        globalThis.removeEventListener?.("pointercancel", this.onPointerUp, true);
        globalThis.removeEventListener?.("blur", this.onPointerUp);
        globalThis.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
        for (const document of [...this.watched.keys()]) this.unwatch(document);
        this.stopIdlePoll();
        if (this.status.fileAutosave === this.files) this.status.fileAutosave = undefined;
    }

    /** Whether the user is in the middle of something an autosave must not interrupt. */
    isBusy(): boolean {
        return (
            this.app?.executingCommand !== undefined ||
            AutosaveHolds.isHeld ||
            this.pointerDown ||
            this.isDialogOpen()
        );
    }

    private readonly watch = (document: IDocument) => {
        if (this.watched.has(document)) return;
        const onChanged = (property: keyof IDocument) => {
            if (property === "isDirty") this.onDirtyChanged(document);
        };
        document.onPropertyChanged(onChanged);
        const entry: Watched = {
            waiting: false,
            saving: false,
            unsubscribe: () => document.removePropertyChanged(onChanged),
        };
        this.watched.set(document, entry);
        if (document.isDirty) {
            entry.since = this.now();
            this.schedule(document, entry);
        }
    };

    private readonly unwatch = (document: IDocument) => {
        const entry = this.watched.get(document);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.unsubscribe();
        this.watched.delete(document);
        this.status.clear(document);
    };

    private onDirtyChanged(document: IDocument) {
        const entry = this.watched.get(document);
        if (!entry) return;
        if (document.isDirty) {
            entry.since ??= this.now();
            this.schedule(document, entry);
            return;
        }
        // Saved (by any kind of save) or undone back to the saved state: nothing to autosave.
        entry.since = undefined;
        entry.waiting = false;
        clearTimeout(entry.timer);
        entry.timer = undefined;
    }

    /** Any save but an autosave (manual, merge, restore…): the last save is no longer an autosave. */
    private readonly onSaved = (document: IDocument, kind: SaveKind) => {
        if (kind !== "auto") this.status.clear(document);
    };

    /** Moved to or from the cloud: its autosaves were elsewhere. */
    private readonly onRepositoryChanged = (document: IDocument) => {
        this.status.clear(document);
    };

    private readonly onSettingsChanged = (property: keyof AutosaveSettings) => {
        if (property !== "intervalMinutes") return;
        for (const [document, entry] of this.watched) this.schedule(document, entry);
    };

    private readonly onAppChanged = (property: keyof IApplication) => {
        if (property === "executingCommand") this.resumeIfIdle();
    };

    private readonly onPointerDown = () => {
        this.pointerDown = true;
    };

    /** Also on blur: a release outside the window (alt-tab mid-drag) never reaches it. */
    private readonly onPointerUp = () => {
        this.pointerDown = false;
        this.resumeIfIdle();
    };

    private readonly onVisibilityChange = () => {
        if (globalThis.document?.visibilityState === "hidden") this.onPointerUp();
    };

    /** (Re)arms the document's timer for `since + interval`; off (0) or clean: no timer. */
    private schedule(document: IDocument, entry: Watched) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const interval = this.settings.intervalMinutes;
        if (interval === 0 || entry.since === undefined || entry.saving) {
            entry.waiting = false;
            return;
        }
        const delay = Math.max(0, entry.since + interval * MINUTE - this.now());
        entry.timer = setTimeout(() => this.due(document), delay);
    }

    private due(document: IDocument) {
        const entry = this.watched.get(document);
        if (!entry) return;
        entry.timer = undefined;
        // One at a time: the running autosave schedules the next one when it ends.
        if (!document.isDirty || entry.saving) {
            entry.waiting = false;
            return;
        }
        if (this.isBusy()) {
            entry.waiting = true;
            this.startIdlePoll();
            return;
        }
        entry.waiting = false;
        void this.run(document, entry);
    }

    private readonly resumeIfIdle = () => {
        if (this.isBusy()) return;
        for (const [document, entry] of this.watched) {
            if (!entry.waiting) continue;
            entry.waiting = false;
            if (document.isDirty && !entry.saving) void this.run(document, entry);
        }
        if (![...this.watched.values()].some((x) => x.waiting)) this.stopIdlePoll();
    };

    /** Commands and pointer releases are signalled; dialogs closing are not, so poll while waiting. */
    private startIdlePoll() {
        this.idlePoll ??= setInterval(this.resumeIfIdle, this.idleCheckMs);
    }

    private stopIdlePoll() {
        clearInterval(this.idlePoll);
        this.idlePoll = undefined;
    }

    private async run(document: IDocument, entry: Watched) {
        entry.saving = true;
        let outcome: AutosaveOutcome;
        try {
            outcome = await this.autosave(document, entry);
        } catch (error) {
            Logger.warn(`autosave of ${document.name} failed`, error);
            outcome = "failed";
        } finally {
            entry.saving = false;
        }
        if (!this.watched.has(document)) return;
        if (outcome === "saved") this.status.recordAutosave(document, this.now());
        // Edits made while saving (or a failure): the next round counts from now.
        entry.since = document.isDirty ? this.now() : undefined;
        this.schedule(document, entry);
    }

    private async autosave(document: IDocument, entry: Watched): Promise<AutosaveOutcome> {
        // A save may be running (Ctrl+S, "save" in the close prompt): wait for it, then look again —
        // it may have saved everything, or the document may have closed (never save a closed one).
        await document.settled();
        if (!this.watched.has(document) || !document.isDirty) return "skipped";
        if (document.repository.isReadOnly?.(document.id)) return "skipped";
        if (entry.conflictVersion !== undefined) {
            if (entry.conflictVersion === (document.version ?? null)) return "skipped";
            entry.conflictVersion = undefined;
        }

        const file = this.files.state(document);
        if (file === "on") {
            const written = await this.writeFile(document);
            return written.isOk ? "saved" : "failed";
        }
        // Opened from a `.spicy` file without the opt-in: the file is where it lives, leave it be.
        if (file === "off") return "skipped";

        const saved = await document.save("auto");
        if (!saved.isOk) {
            Logger.info(`autosave of ${document.name}: ${saved.error.kind}`);
            return saved.error.kind === "readOnly" ? "skipped" : "failed";
        }
        if (saved.value.status === "conflict") {
            // Shown by the document's status; the dialog opens when the user asks (status, Ctrl+S).
            entry.conflictVersion = document.version ?? null;
            return "conflict";
        }
        return "saved";
    }
}
