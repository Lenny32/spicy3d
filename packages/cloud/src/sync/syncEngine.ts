// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    applyMergeToDocument,
    type DocumentMeta,
    type DocumentRepositoryError,
    documentThumbnail,
    EditSessions,
    I18n,
    type IApplication,
    type IDocument,
    type IMergeEvaluator,
    type LoadedDocument,
    Logger,
    MergeEvaluators,
    type MergeResolution,
    type MergeResult,
    mergeDocuments,
    PubSub,
    parseUtc,
    Result,
    repositoryErrorMessage,
    type SaveConflict,
    type SaveOutcome,
    type SaveRequest,
    type Serialized,
    type ToastAction,
    UserActivity,
    validateMerge,
} from "@spicy3d/core";
import { newIdempotencyKey } from "../client";
import { reapplyResolutions } from "../conflicts/resolutions";
import type { EditLocks } from "../documents/editLocks";
import type {
    CloudDocumentRepository,
    CloudSaveState,
    CloudVersion,
    IRepositorySync,
    PushFailure,
    PushOutcome,
} from "../documents/repository";
import type { CloudEvent, EventsChannel } from "./events";
import {
    combinePending,
    type ISyncStore,
    type LocalSnapshot,
    type PushAttempt,
    retainedBlobs,
    type SyncRecord,
    type SyncVersionRef,
} from "./syncStore";

/**
 * Where a cloud document stands with the server (CLOUD-10):
 * `clean → dirty → pushing → clean`; `pushing → diverged (409) → merging → pushing`;
 * `* → offline → pushing`; `* → error` (a session to renew, a full quota, a refused save);
 * `conflict`: the merge needs the user (CLOUD-13).
 */
export type DocumentSyncState =
    | "clean"
    | "dirty"
    | "pushing"
    | "offline"
    | "diverged"
    | "merging"
    | "conflict"
    | "error";

/** One side of a merge as the conflict UI labels it: which device saved it, and when. */
export interface SyncSide {
    versionId?: string;
    deviceName?: string;
    /** Epoch milliseconds. */
    at?: number;
    /** The version's kind (`mcp`: saved by an agent). */
    kind?: string;
}

/**
 * A merge the sync can't finish on its own: CLOUD-13's conflict UI shows `result.conflicts` with
 * the sides labelled, then calls {@link SyncEngine.resolve}. `local`: what this device has that the
 * server doesn't — a pending save (`pending`), or only unsaved edits of the open document.
 */
export interface SyncConflict {
    docId: string;
    /** `undefined` when there was nothing to merge against (the base is gone, or an id was taken). */
    result?: MergeResult;
    base: SyncSide;
    ours: SyncSide;
    theirs: SyncSide;
    local: "pending" | "unsaved";
    /**
     * The user undid a clean merge ("Undo merge"): this device's content is back, and the sync
     * waits for the user to merge again or keep theirs as a copy instead of merging it back.
     */
    undone?: boolean;
}

/**
 * A clean merge the sync applied to an open document, while it can still be undone ("View
 * changes" / "Undo merge" of its toast): this device's state before it, and what came in.
 */
export interface AppliedMerge {
    docId: string;
    /** The open document's content before the merge (this device's side). */
    before: Serialized;
    result: MergeResult;
    theirs: SyncSide;
}

/** Buttons of the sync's toasts, given by the UI (CLOUD-13). */
export interface SyncToastActions {
    /** "Merged changes from <device>": View changes / Undo merge. */
    merged?: (docId: string) => ToastAction[];
    /** "<document>: changes from another device conflict with yours": Resolve. */
    conflict?: (docId: string) => ToastAction[];
}

export interface SyncEngineOptions {
    app: IApplication;
    repository: CloudDocumentRepository;
    store: ISyncStore;
    locks: EditLocks;
    events?: EventsChannel;
    activity?: UserActivity;
    /** Blob cache cap (default 512 MiB); pending saves and their bases are never evicted. */
    cacheLimitBytes?: number;
    /** Push retry backoff: first delay and cap (default 1 s, 60 s), with jitter. */
    initialDelayMs?: number;
    maxDelayMs?: number;
    /** A push taking longer is given up and retried (same `Idempotency-Key`; default 2 min). */
    pushTimeoutMs?: number;
    /** How often a deferred update checks whether the user is done (default 1 s). */
    idleCheckMs?: number;
    /** Events are gathered this long before refetching (default 150 ms). */
    pullDelayMs?: number;
    random?: () => number;
    now?: () => number;
    /** `navigator.storage.persist()`, asked once. */
    requestPersistence?: () => Promise<boolean>;
    /** Rebuilds a merge before it is pushed (default: the app's registered `MergeEvaluators.current`). */
    evaluator?: IMergeEvaluator;
    /** Actions offered on the merge and conflict toasts (none: plain toasts). */
    toastActions?: SyncToastActions;
}

/** What the conflict panel validated and previewed (`resolve` refuses to push anything else). */
export interface ExpectedMerge {
    /** The head the merge was made against. */
    headVersionId?: string;
    /** `JSON.stringify` of the merged document. */
    merged?: string;
}

/** A clean merge applied in place, kept for "Undo merge". */
interface LastMerge extends AppliedMerge {
    /** The undo position right after the merge was applied: edited since = no undo. */
    appliedAt: object;
    /** What this device had: a pending save (its kind and label), or unsaved edits only. */
    local: "pending" | "unsaved";
    /** The version this device was based on before the merge (the merge base). */
    base?: SyncVersionRef;
    pendingKind?: SyncRecord["pendingKind"];
    pendingLabel?: string;
}

/** The undo step of a newer version applied in place (its undo goes back to the version before). */
export const REMOTE_UPDATE_HISTORY_NAME = "remote update";
/** The undo step of "Undo merge" (this device's content from before a clean merge, back in place). */
export const UNDO_MERGE_HISTORY_NAME = "undo merge";

interface Entry {
    state: DocumentSyncState;
    /** A newer head waits until the user is done (a command, a drag, a dialog). */
    remotePending: boolean;
    /** Whether the next pass asks the server for the head. */
    pullRequested: boolean;
    /** Deferred until the user is idle; the idle watcher runs the pass again. */
    waitingIdle: boolean;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
    /** When `timer` fires (epoch ms of `now()`). */
    timerDue?: number;
    pullTimer?: ReturnType<typeof setTimeout>;
    running?: Promise<void>;
    again: boolean;
    conflict?: SyncConflict;
    /** Autosave held while the document waits in `conflict`. */
    releaseConflictHold?: () => void;
    /** Resolution holds (CLOUD-13's panel): no pushes, no pulls applied. */
    holds: number;
    /** Bumped whenever the conflict is entered, replaced or cleared: a re-merge begun before gives way. */
    conflictGeneration: number;
    /** `resolve` / `undoMerge` running: no re-merge meanwhile (it would bring the old conflict back). */
    resolving: number;
    /** A push is in flight (saves made meanwhile are counted as the next push's). */
    pushing: boolean;
    /** This tab holds the document's edit lock for a closed document (its pending changes). */
    backgroundLock: boolean;
    /** `document.save` calls in flight: the document's content must not be replaced meanwhile. */
    savesInFlight: number;
    /** Counts the saves written here: tells a save made after a merge was applied from one before. */
    saves: number;
    errorReported?: string;
    /** The last clean merge applied to the open document, while "Undo merge" is possible. */
    lastMerge?: LastMerge;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DEFAULT_CACHE_LIMIT = 512 * 1024 * 1024;
/** Unanswered pushes remembered per document (see `SyncRecord.unconfirmed`). */
const MAX_UNCONFIRMED = 20;
const decoder = new TextDecoder();

/** A macrotask: every microtask continuation (a save finishing) has run by then. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function versionRef(version: CloudVersion, blobs: string[]): SyncVersionRef {
    const ref: SyncVersionRef = { id: version.id, manifestSha256: version.manifestSha256, blobs };
    if (version.deviceName) ref.deviceName = version.deviceName;
    const at = parseUtc(version.createdAt);
    if (Number.isFinite(at)) ref.createdAt = at;
    if (version.kind) ref.kind = version.kind;
    return ref;
}

function sideOf(ref: SyncVersionRef | undefined): SyncSide {
    const side: SyncSide = {};
    if (ref?.id) side.versionId = ref.id;
    if (ref?.deviceName) side.deviceName = ref.deviceName;
    if (ref?.createdAt !== undefined) side.at = ref.createdAt;
    if (ref?.kind) side.kind = ref.kind;
    return side;
}

/** A save that could not be kept on this device: a full disk is `quota`. */
function storageError(docId: string, error: unknown): DocumentRepositoryError {
    Logger.warn(`[cloud] ${docId}: cannot keep the save on this device: ${error}`);
    const quota = (error as { name?: string } | null)?.name === "QuotaExceededError";
    return quota ? { kind: "quota" } : { kind: "failed", message: String(error) };
}

function isQuota(failure: PushFailure): boolean {
    return (
        failure.error.kind === "quota" ||
        failure.code === "payload_too_large" ||
        failure.code === "quota_exceeded"
    );
}

/**
 * Offline-first sync of cloud documents (CLOUD-10). Every save lands in IndexedDB first (a
 * {@link SyncRecord}: the snapshot's manifest and blobs in the blob cache, the record pointing at
 * them and at the version they are based on), then a background pass pushes it — retried with
 * jittered exponential backoff, the same `Idempotency-Key` across retries and reloads, so the queue
 * survives both. Several saves made meanwhile collapse into one push (manual wins over auto).
 *
 * Pulls: the events WebSocket (`document.updated`, own `clientId` ignored) and a refetch of every
 * head on (re)connect, window focus and `online`. A newer head on a clean document is applied in
 * place (`replaceContent`, views kept) unless the user is busy ("remote changes pending" until they
 * are done). A document with changes here merges (CLOUD-12): a clean merge is applied as one undo
 * step and pushed as a `merge` version (parents: the head, then this device's base), and can be
 * taken back ({@link undoMerge}); a merge with conflicts waits in `conflict` ({@link syncConflictOf},
 * {@link onChanged}) for the user — CLOUD-13's conflict panel, which holds the sync ({@link hold})
 * and finishes with {@link resolve}.
 *
 * One tab syncs a document: the one holding its edit lock ({@link EditLocks}); a closed document
 * with pending changes is synced by whichever tab gets its lock first.
 */
export class SyncEngine implements IRepositorySync {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<(docId: string) => void>();
    private readonly recordLocks = new Map<string, Promise<unknown>>();
    private readonly cleanups: (() => void)[] = [];
    private readonly activity: UserActivity;
    private readonly now: () => number;
    private readonly random: () => number;
    private idlePoll?: ReturnType<typeof setInterval>;
    private evictTimer?: ReturnType<typeof setTimeout>;
    private persistenceAsked = false;
    private noEvaluatorLogged = false;
    /** Cancels a merge validation still running when the sync stops. */
    private readonly abort = new AbortController();
    private started = false;
    private stopped = false;

    constructor(readonly options: SyncEngineOptions) {
        this.activity = options.activity ?? UserActivity.current;
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? Math.random;
    }

    get repository(): CloudDocumentRepository {
        return this.options.repository;
    }

    private get app(): IApplication {
        return this.options.app;
    }

    private get ownerId(): string | undefined {
        return this.repository.ownerId;
    }

    // ---- Lifecycle ---------------------------------------------------------------------------

    /** Attaches to the repository, picks up the pending saves of earlier sessions and starts pulling. */
    start(): void {
        if (this.started) return;
        this.started = true;
        this.repository.attachSync(this);
        this.cleanups.push(this.activity.start());
        this.cleanups.push(this.activity.onMaybeIdle(this.resumeIdle));
        this.app.onPropertyChanged(this.onAppChanged);
        this.cleanups.push(() => this.app.removePropertyChanged(this.onAppChanged));
        this.repository.account.onPropertyChanged(this.onAccountChanged);
        this.cleanups.push(() => this.repository.account.removePropertyChanged(this.onAccountChanged));
        const events = this.options.events;
        if (events) {
            this.cleanups.push(events.onEvent(this.onEvent));
            this.cleanups.push(events.onConnected(this.refreshAll));
            events.start();
            this.cleanups.push(() => events.stop());
        }
        // Another tab let a document go: its pending changes may be this tab's to push now.
        this.cleanups.push(this.options.locks.onReleasedElsewhere(() => void this.resumePending()));
        globalThis.addEventListener?.("online", this.refreshAll);
        globalThis.addEventListener?.("focus", this.refreshAll);
        globalThis.document?.addEventListener("visibilitychange", this.onVisibilityChange);
        this.cleanups.push(() => {
            globalThis.removeEventListener?.("online", this.refreshAll);
            globalThis.removeEventListener?.("focus", this.refreshAll);
            globalThis.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
        });
        void this.resumePending();
    }

    /** Stops every timer and pull; pending saves stay in the store for the next session. */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.abort.abort();
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        for (const [id, entry] of this.entries) {
            clearTimeout(entry.timer);
            clearTimeout(entry.pullTimer);
            if (entry.backgroundLock) this.options.locks.release(id);
            entry.releaseConflictHold?.();
        }
        this.stopIdlePoll();
        clearTimeout(this.evictTimer);
        if (this.repository.sync === this) this.repository.attachSync(undefined);
    }

    /** Resolves once no pass runs (tests, sign-out). */
    async idle(): Promise<void> {
        for (;;) {
            const running = [...this.entries.values()].map((x) => x.running).filter((x) => x !== undefined);
            if (running.length === 0) return;
            await Promise.all(running);
        }
    }

    /**
     * Resolves once nothing is due within `withinMs`: no pass running, no pass or refetch scheduled
     * sooner (a backoff retry later doesn't count). For tests and sign-out.
     */
    async settle(withinMs = 0): Promise<void> {
        for (let round = 0; round < 1000; round++) {
            await nextTask();
            await this.idle();
            const soon = Date.now() + withinMs;
            const due = [...this.entries.values()].some(
                (x) => x.running || x.pullTimer || (x.timer && (x.timerDue ?? 0) <= soon),
            );
            if (!due) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    async flush(docId: string): Promise<Result<void, DocumentRepositoryError | { kind: "conflict" }>> {
        const entry = this.entry(docId);
        for (let round = 0; round < 3; round++) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.attempt = 0;
            await this.run(docId);
            await nextTask();
            await this.idle();
            const record = await this.record(docId);
            if (!record?.localDirty) return Result.ok(undefined);
            if (entry.state === "conflict") return Result.err({ kind: "conflict" });
            if (entry.state === "offline") return Result.err({ kind: "offline" });
            if (entry.state === "error") {
                return Result.err({ kind: "failed", message: record.lastError?.message ?? "sync failed" });
            }
        }
        return Result.err({ kind: "offline" });
    }

    /** Returns the unsubscribe function; called with a document id whenever its state changes. */
    onChanged(listener: (docId: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    stateOf(docId: string): DocumentSyncState {
        return this.entries.get(docId)?.state ?? "clean";
    }

    /** Whether a newer version from another device waits for the user to be done. */
    hasRemotePending(docId: string): boolean {
        return this.entries.get(docId)?.remotePending ?? false;
    }

    /** The conflict of a document in `conflict` (for CLOUD-13's panel). */
    conflictOf(docId: string): SaveConflict | undefined {
        const conflict = this.entries.get(docId)?.conflict;
        if (!conflict) return undefined;
        const saveConflict: SaveConflict = { status: "conflict" };
        if (conflict.theirs.versionId) saveConflict.headVersion = conflict.theirs.versionId;
        if (conflict.theirs.at !== undefined) saveConflict.headCreatedAt = conflict.theirs.at;
        if (conflict.theirs.deviceName) saveConflict.headDeviceName = conflict.theirs.deviceName;
        return saveConflict;
    }

    /** The merge waiting for the user, with both sides labelled. */
    syncConflictOf(docId: string): SyncConflict | undefined {
        return this.entries.get(docId)?.conflict;
    }

    /** The records of this user with changes the server doesn't have. */
    async pendingRecords(): Promise<SyncRecord[]> {
        return (await this.options.store.all()).filter((x) => x.ownerId === this.ownerId && x.localDirty);
    }

    private entry(docId: string): Entry {
        let entry = this.entries.get(docId);
        if (!entry) {
            entry = {
                state: "clean",
                remotePending: false,
                pullRequested: false,
                waitingIdle: false,
                attempt: 0,
                again: false,
                holds: 0,
                conflictGeneration: 0,
                resolving: 0,
                pushing: false,
                backgroundLock: false,
                savesInFlight: 0,
                saves: 0,
            };
            this.entries.set(docId, entry);
        }
        return entry;
    }

    private setState(docId: string, state: DocumentSyncState, remotePending?: boolean) {
        const entry = this.entry(docId);
        const pending = remotePending ?? entry.remotePending;
        if (entry.state === state && entry.remotePending === pending) return;
        entry.state = state;
        entry.remotePending = pending;
        if (state !== "error") entry.errorReported = undefined;
        this.repository.reportState(docId, this.saveState(entry));
        for (const listener of [...this.listeners]) listener(docId);
    }

    private saveState(entry: Entry): CloudSaveState {
        switch (entry.state) {
            case "clean":
                return entry.remotePending ? "remotePending" : "saved";
            case "dirty":
                return "pending";
            case "pushing":
                return "saving";
            case "offline":
                return "offline";
            case "diverged":
            case "merging":
                return "merging";
            case "conflict":
                return "conflict";
            case "error":
                return "error";
        }
    }

    private emit(docId: string) {
        for (const listener of [...this.listeners]) listener(docId);
    }

    /** One read-modify-write of a document's record at a time. */
    private async withRecord<T>(docId: string, run: () => Promise<T>): Promise<T> {
        const previous = this.recordLocks.get(docId) ?? Promise.resolve();
        const next = previous.then(run, run);
        const settled = next.then(
            () => undefined,
            () => undefined,
        );
        this.recordLocks.set(docId, settled);
        try {
            return await next;
        } finally {
            if (this.recordLocks.get(docId) === settled) this.recordLocks.delete(docId);
        }
    }

    private async record(docId: string): Promise<SyncRecord | undefined> {
        const record = await this.options.store.get(docId);
        return record && record.ownerId === this.ownerId ? record : undefined;
    }

    private openDocument(docId: string): IDocument | undefined {
        for (const document of this.app.documents) {
            if (document.id === docId && document.repository === this.repository) return document;
        }
        return undefined;
    }

    /** This tab syncs the document: open here and editable, or its lock taken for pending changes. */
    private owns(docId: string): boolean {
        const entry = this.entries.get(docId);
        if (entry?.backgroundLock) return true;
        return this.openDocument(docId) !== undefined && !this.options.locks.isReadOnly(docId);
    }

    // ---- Open documents ----------------------------------------------------------------------

    /** A cloud document opened in this tab: synced from now on (its lock is taken by the caller). */
    documentOpened(document: IDocument): void {
        if (this.stopped || document.repository !== this.repository) return;
        this.requestPull(document.id, 0);
    }

    /**
     * A cloud document closed here: its lock is let go unless it still has changes to push, which
     * this tab then pushes in the background.
     */
    async documentClosed(document: IDocument): Promise<void> {
        const id = document.id;
        const entry = this.entries.get(id);
        const record = await this.record(id);
        // Reopened meanwhile ("open latest"): the new document keeps the lock.
        if (this.openDocument(id)) return;
        if (!this.stopped && record?.localDirty && !this.options.locks.isReadOnly(id)) {
            this.entry(id).backgroundLock = true;
            this.schedulePass(id, 0);
            return;
        }
        if (entry) {
            clearTimeout(entry.timer);
            clearTimeout(entry.pullTimer);
            entry.backgroundLock = false;
            if (!entry.running) this.entries.delete(id);
        }
        this.options.locks.release(id);
    }

    /** Pending saves of earlier sessions (or other tabs that closed): taken and pushed. */
    private async resumePending() {
        for (const record of await this.pendingRecords()) {
            if (this.stopped) return;
            const id = record.docId;
            const entry = this.entries.get(id);
            // Already pushed from here, or waiting in conflict for its next opening.
            if (entry?.backgroundLock || (entry?.state === "conflict" && !this.openDocument(id))) continue;
            if (this.openDocument(id)) {
                this.schedulePass(id, 0);
                continue;
            }
            if ((await this.options.locks.acquire(id)) !== "editing") {
                // Another tab of this browser syncs it.
                this.options.locks.release(id);
                continue;
            }
            this.entry(id).backgroundLock = true;
            this.schedulePass(id, 0);
        }
    }

    /** The background lock of a closed document goes once it is clean. */
    private releaseIfDone(docId: string, record: SyncRecord | undefined) {
        const entry = this.entries.get(docId);
        if (!entry?.backgroundLock || record?.localDirty || this.openDocument(docId)) return;
        entry.backgroundLock = false;
        this.options.locks.release(docId);
    }

    // ---- Saving (local first) ----------------------------------------------------------------

    /**
     * A save: written to this device (the snapshot's blobs in the cache, the record in IndexedDB),
     * then pushed in the background. Resolves `saved` once it is safe here — the document is then
     * clean even offline; the status tells whether the server has it yet.
     */
    async save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const entry = this.entry(request.id);
        entry.savesInFlight++;
        try {
            return await this.saveLocally(request, entry);
        } finally {
            entry.savesInFlight--;
        }
    }

    private async saveLocally(
        request: SaveRequest,
        entry: Entry,
    ): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        const ownerId = this.ownerId;
        if (!ownerId) return Result.err({ kind: "unauthorized" });
        const prepared = await this.repository.prepare(request.data, request.thumbnail);
        if (!prepared.isOk) return Result.err(prepared.error);
        const { bytes, ...snapshot } = prepared.value;
        // Stored for sure before the record points at them (else a reload would find nothing).
        try {
            await Promise.all([...bytes].map(([sha, blob]) => this.repository.cache.putStrict(sha, blob)));
        } catch (error) {
            return Result.err(storageError(request.id, error));
        }

        const saved = await this.withRecord(request.id, async () => {
            const stored = await this.record(request.id);
            const now = this.now();
            const record: SyncRecord = stored ?? {
                docId: request.id,
                ownerId,
                name: request.name,
                localDirty: false,
                clientId: this.repository.clientId,
                updatedAt: now,
            };
            if (!record.localDirty) {
                // Clean: based on what this device last synced (the record is kept up to date by
                // every push and pull; `document.version` may lag behind a push that just ended).
                // Without a record, on what the document was loaded from.
                const base = request.baseVersion;
                if (!stored && base) record.baseVersion = { id: base, manifestSha256: "", blobs: [] };
                record.pendingKind = undefined;
                record.pendingLabel = undefined;
                record.nextKind = undefined;
                record.nextLabel = undefined;
                record.mergeParent = undefined;
                record.pendingSince = now;
            }
            record.name = request.name;
            record.localSnapshot = { ...snapshot, savedAt: now };
            record.localDirty = true;
            // An attempt made (maybe in flight): this save is the next push's.
            if (record.attempt) {
                const next = combinePending(record.nextKind, record.nextLabel, request.kind, request.label);
                record.nextKind = next.kind;
                record.nextLabel = next.label;
            } else {
                const next = combinePending(
                    record.pendingKind,
                    record.pendingLabel,
                    request.kind,
                    request.label,
                );
                record.pendingKind = next.kind;
                record.pendingLabel = next.label;
            }
            record.pendingSince ??= now;
            record.clientId = this.repository.clientId;
            record.updatedAt = now;
            try {
                await this.options.store.put(record);
                entry.saves++;
                return Result.ok(record);
            } catch (error) {
                return Result.err<DocumentRepositoryError>(storageError(request.id, error));
            }
        });
        if (!saved.isOk) return Result.err(saved.error);
        // Saved while waiting for the user: resolving it now merges (and pushes) this save.
        if (entry.conflict) entry.conflict = { ...entry.conflict, local: "pending" };
        this.askPersistence();
        if (entry.state === "clean" || entry.state === "error" || entry.state === "offline") {
            this.setState(request.id, entry.state === "offline" ? "offline" : "dirty");
        }
        this.schedulePass(request.id, 0);
        // No version: the sync sets `document.version` itself once pushed (a version answered here
        // could be older than the one a push running meanwhile sets).
        return Result.ok({ status: "saved", updatedAt: this.now() });
    }

    /** `navigator.storage.persist()` once: pending saves must not be evicted by the browser. */
    private askPersistence() {
        if (this.persistenceAsked) return;
        this.persistenceAsked = true;
        const request =
            this.options.requestPersistence ??
            (() => {
                const storage = globalThis.navigator?.storage;
                if (!storage?.persist) return Promise.resolve(false);
                return storage.persisted().then((persisted) => persisted || storage.persist());
            });
        void request().then(
            (persisted) => Logger.info(`[cloud] persistent storage: ${persisted}`),
            (error) => Logger.warn(`[cloud] persistent storage not granted: ${error}`),
        );
    }

    // ---- Loading -----------------------------------------------------------------------------

    /**
     * Opens a cloud document: this device's pending save when there is one (the server gets it
     * later), otherwise the complete copy last synced here. Opening starts a background pull
     * through the usual fast-forward/merge path; a cache miss loads the server's head.
     */
    async load(id: string, useCache = true): Promise<Result<LoadedDocument, DocumentRepositoryError>> {
        const record = await this.record(id);
        if (record?.localDirty && record.localSnapshot) {
            const pending = await this.snapshotContent(record);
            if (pending.isOk) {
                this.entry(id);
                this.setState(id, "dirty");
                return Result.ok({
                    data: { ...pending.value, name: record.name },
                    version: record.baseVersion?.id,
                });
            }
            Logger.warn(
                `[cloud] ${id}: the pending save can't be read (${pending.error.kind}), opening the head`,
            );
        }
        if (useCache && record && !record.localDirty && record.baseVersion?.manifestSha256) {
            const cached = await this.repository.loadCachedVersion(record.baseVersion.manifestSha256);
            if (cached.isOk) {
                this.setState(id, "clean", false);
                return Result.ok({
                    data: { ...cached.value, name: record.name },
                    version: record.baseVersion.id,
                });
            }
        }
        const loaded = await this.repository.loadHead(id);
        if (loaded.isOk) {
            const { head, name, data, blobs } = loaded.value;
            const ownerId = this.ownerId;
            if (ownerId) {
                await this.options.store.putIfClean({
                    docId: id,
                    ownerId,
                    name,
                    baseVersion: versionRef(head, blobs),
                    localDirty: false,
                    clientId: this.repository.clientId,
                    updatedAt: this.now(),
                });
            }
            this.setState(id, "clean", false);
            this.scheduleEviction();
            return Result.ok({ data, version: head.id });
        }
        if (loaded.error.kind === "offline" && record?.baseVersion?.manifestSha256) {
            const cached = await this.repository.loadVersion({
                id: record.baseVersion.id,
                manifestSha256: record.baseVersion.manifestSha256,
            });
            if (cached.isOk) {
                this.setState(id, "offline");
                return Result.ok({
                    data: { ...cached.value, name: record.name },
                    version: record.baseVersion.id,
                });
            }
        }
        return Result.err(loaded.error);
    }

    private async snapshotContent(record: SyncRecord): Promise<Result<Serialized, DocumentRepositoryError>> {
        const snapshot = record.localSnapshot;
        if (!snapshot) return Result.err({ kind: "failed", message: "no pending save" });
        const bytes = await this.repository.cache.get(snapshot.manifestSha256);
        if (!bytes)
            return Result.err({ kind: "failed", message: "the pending save's manifest is not cached" });
        let manifest: unknown;
        try {
            manifest = JSON.parse(decoder.decode(bytes));
        } catch (error) {
            return Result.err({ kind: "failed", message: String(error) });
        }
        return this.repository.assemble(manifest);
    }

    async offlineList(search?: string): Promise<DocumentMeta[]> {
        const needle = search?.toLowerCase();
        return (await this.options.store.all())
            .filter((x) => x.ownerId === this.ownerId && (!needle || x.name.toLowerCase().includes(needle)))
            .map((record) => {
                const meta: DocumentMeta = {
                    id: record.docId,
                    name: record.name,
                    updatedAt:
                        record.localSnapshot?.savedAt ?? record.baseVersion?.createdAt ?? record.updatedAt,
                    location: "cloud",
                    syncState: this.entries.get(record.docId)?.conflict
                        ? "conflict"
                        : record.localDirty
                          ? "offline"
                          : "synced",
                };
                if (record.baseVersion) meta.headVersion = record.baseVersion.id;
                if (record.localSnapshot?.thumbnailSha256) {
                    // Shown from the cache like any cloud thumbnail.
                    this.repository.rememberThumbnail(record.docId, record.localSnapshot.thumbnailSha256);
                }
                return meta;
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async annotate(items: DocumentMeta[]): Promise<void> {
        const pending = new Set((await this.pendingRecords()).map((x) => x.docId));
        for (const item of items) {
            if (this.entries.get(item.id)?.conflict) item.syncState = "conflict";
            else if (pending.has(item.id)) item.syncState = "pending";
        }
    }

    // ---- Passes ------------------------------------------------------------------------------

    private schedulePass(docId: string, delayMs: number) {
        if (this.stopped) return;
        const entry = this.entry(docId);
        clearTimeout(entry.timer);
        entry.timerDue = Date.now() + delayMs;
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            entry.timerDue = undefined;
            void this.run(docId);
        }, delayMs);
    }

    /** Events gathered for a moment, then one refetch of the head. */
    private requestPull(docId: string, delayMs = this.options.pullDelayMs ?? 150) {
        if (this.stopped) return;
        const entry = this.entry(docId);
        entry.pullRequested = true;
        if (entry.pullTimer) return;
        entry.pullTimer = setTimeout(() => {
            entry.pullTimer = undefined;
            void this.run(docId);
        }, delayMs);
    }

    /** One pass at a time per document; a request meanwhile runs another right after. */
    private run(docId: string): Promise<void> {
        const entry = this.entry(docId);
        if (entry.running) {
            entry.again = true;
            return entry.running;
        }
        const running = (async () => {
            try {
                do {
                    entry.again = false;
                    await this.pass(docId, entry);
                } while (entry.again && !this.stopped);
            } catch (error) {
                Logger.warn(`[cloud] sync of ${docId} failed`, error);
                this.setState(docId, "error");
            } finally {
                entry.running = undefined;
            }
        })();
        entry.running = running;
        return running;
    }

    private async pass(docId: string, entry: Entry): Promise<void> {
        if (this.stopped || !this.repository.account.isSignedIn) return;
        const account = this.repository.account;
        if (account.isUnconfirmed && !(await account.confirmSession())) {
            // Started offline from the cached user: nothing goes to the server before it says who
            // is signed in (a 401 ends that session; offline: asked again later).
            if (account.isSignedIn) {
                this.setState(docId, "offline");
                this.retry(docId, entry, { error: { kind: "offline" }, retryable: true });
            }
            return;
        }
        const document = this.openDocument(docId);
        if (!this.owns(docId)) {
            // Read-only here (another tab syncs it): newer versions are still shown when clean.
            if (document && entry.pullRequested) await this.pullReadOnly(docId, entry, document);
            return;
        }
        const record = await this.record(docId);
        if (entry.state === "conflict") {
            // Waits for the user; a newer head re-merges, also while the conflict panel holds the
            // sync (nothing is pushed or applied: the panel reapplies its choices by path).
            if (entry.pullRequested && entry.resolving === 0) await this.remerge(docId, entry, record);
            return;
        }
        if (entry.holds > 0) return;
        if (record?.localDirty) {
            await this.push(docId, entry, record);
        } else if (entry.pullRequested || entry.waitingIdle) {
            await this.pull(docId, entry, record);
        } else if (entry.state !== "error") {
            this.setState(docId, "clean");
        }
        this.releaseIfDone(docId, await this.record(docId));
    }

    private retry(docId: string, entry: Entry, failure: PushFailure) {
        const cap = Math.min(
            this.options.maxDelayMs ?? 60_000,
            (this.options.initialDelayMs ?? 1000) * 2 ** entry.attempt,
        );
        entry.attempt++;
        const jittered = cap / 2 + (this.random() * cap) / 2;
        this.schedulePass(docId, Math.max(jittered, failure.retryAfterMs ?? 0));
    }

    private fail(docId: string, entry: Entry, failure: PushFailure, record?: SyncRecord) {
        this.setState(docId, "error");
        const [key, ...args] = isQuota(failure)
            ? (["cloud.sync.quota"] as const)
            : repositoryErrorMessage(failure.error);
        const message = `${key}:${args.join(",")}`;
        if (entry.errorReported !== message) {
            entry.errorReported = message;
            PubSub.default.pub("showToast", key, ...args);
        }
        if (record) {
            void this.withRecord(docId, async () => {
                const current = await this.record(docId);
                if (!current) return;
                current.lastError = { kind: failure.error.kind, message, at: this.now() };
                await this.options.store.put(current).catch(() => undefined);
            });
        }
    }

    /** A push that failed for now: offline, or waiting for the retry. */
    private deferPush(docId: string, entry: Entry, failure: PushFailure) {
        if (failure.error.kind === "unauthorized") {
            // The re-login was declined or is still open: pushed again once signed in.
            this.setState(docId, "error");
            return;
        }
        this.setState(docId, failure.error.kind === "offline" ? "offline" : "dirty");
        this.retry(docId, entry, failure);
    }

    // ---- Push --------------------------------------------------------------------------------

    /**
     * The attempt to push the record's snapshot: the one kept with the record when it is for this
     * snapshot on this base (a retry resends it field for field), else a new one — written before
     * anything is sent. Saves made from then on count as the next push's (`nextKind`).
     */
    private async attemptFor(docId: string, snapshotSha: string): Promise<PushAttempt | undefined> {
        return this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current?.localDirty || current.localSnapshot?.manifestSha256 !== snapshotSha)
                return undefined;
            const reusable =
                current.attempt &&
                current.attempt.manifestSha256 === snapshotSha &&
                current.attempt.baseVersion === current.baseVersion?.id &&
                current.attempt.mergeParent === current.mergeParent;
            if (reusable) return current.attempt;
            // A stale attempt (another snapshot or base): its saves meanwhile join this push.
            if (current.attempt) this.fold(current);
            const attempt: PushAttempt = {
                idempotencyKey: newIdempotencyKey(),
                name: current.name,
                kind: current.pendingKind ?? "auto",
                manifestSha256: snapshotSha,
                clientId: this.repository.clientId,
                deviceName: this.repository.account.deviceSettings.effectiveDeviceName,
            };
            if (current.baseVersion?.id) attempt.baseVersion = current.baseVersion.id;
            if (current.mergeParent) attempt.mergeParent = current.mergeParent;
            if (current.pendingLabel) attempt.label = current.pendingLabel;
            current.attempt = attempt;
            await this.options.store.put(current);
            return attempt;
        }).catch(() => undefined);
    }

    /** The kinds and label of the saves made since the attempt join the pending ones; no attempt. */
    private fold(record: SyncRecord) {
        if (record.nextKind) {
            const next = combinePending(
                record.pendingKind,
                record.pendingLabel,
                record.nextKind,
                record.nextLabel,
            );
            record.pendingKind = next.kind;
            record.pendingLabel = next.label;
        }
        record.nextKind = undefined;
        record.nextLabel = undefined;
        record.attempt = undefined;
    }

    private async push(docId: string, entry: Entry, record: SyncRecord): Promise<void> {
        const snapshot = record.localSnapshot;
        if (!snapshot) return;
        const attempt = await this.attemptFor(docId, snapshot.manifestSha256);
        if (!attempt) {
            entry.again = true;
            return;
        }

        this.setState(docId, "pushing");
        entry.pushing = true;
        let outcome: Result<PushOutcome, PushFailure>;
        try {
            outcome = await this.withTimeout(
                this.repository.push({
                    id: docId,
                    name: attempt.name,
                    baseVersion: attempt.baseVersion,
                    mergeParent: attempt.mergeParent,
                    kind: attempt.kind,
                    label: attempt.label,
                    manifestSha256: snapshot.manifestSha256,
                    blobs: snapshot.blobs,
                    thumbnailSha256: snapshot.thumbnailSha256,
                    formatVersion: snapshot.formatVersion,
                    idempotencyKey: attempt.idempotencyKey,
                    clientId: attempt.clientId,
                    deviceName: attempt.deviceName,
                    bytes: (sha) => this.repository.cache.get(sha),
                }),
            );
        } finally {
            entry.pushing = false;
        }

        if (!outcome.isOk) {
            if (outcome.error.code === "idempotency_key_reused") {
                // The key was bound to another request (an older client, a record written by one):
                // the version may exist; a new attempt goes through the 409 / landed-push path.
                await this.dropAttempt(docId, snapshot, attempt.clientId);
                entry.again = true;
                return;
            }
            if (outcome.error.retryable) await this.rememberUnanswered(docId, snapshot, attempt.clientId);
            // A full quota doesn't free itself: the user is told, the next save tries again.
            if (outcome.error.retryable && !isQuota(outcome.error))
                this.deferPush(docId, entry, outcome.error);
            else this.fail(docId, entry, outcome.error, record);
            return;
        }
        entry.attempt = 0;
        if (outcome.value.status === "conflict") {
            await this.dropAttempt(docId);
            await this.diverged(docId, entry);
            return;
        }
        const version = outcome.value.version;
        const clean = await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return true;
            current.baseVersion = versionRef(version, [...snapshot.blobs]);
            current.mergeParent = undefined;
            current.lastError = undefined;
            current.unconfirmed = undefined;
            current.updatedAt = this.now();
            const same =
                current.localSnapshot?.manifestSha256 === snapshot.manifestSha256 && !current.nextKind;
            if (same) {
                current.localDirty = false;
                current.localSnapshot = undefined;
                current.pendingKind = undefined;
                current.pendingLabel = undefined;
                current.pendingSince = undefined;
            } else {
                // Saved since the attempt: those saves go next, on top of what was just pushed.
                current.pendingKind = current.nextKind ?? "auto";
                current.pendingLabel = current.nextLabel;
                current.pendingSince = current.localSnapshot?.savedAt ?? this.now();
            }
            current.nextKind = undefined;
            current.nextLabel = undefined;
            current.attempt = undefined;
            await this.options.store.put(current);
            return same;
        });
        const document = this.openDocument(docId);
        if (document) document.version = version.id;
        entry.pullRequested = false;
        if (clean) {
            this.setState(docId, "clean");
            this.scheduleEviction();
        } else {
            this.setState(docId, "dirty");
            entry.again = true;
        }
    }

    /** The attempt is over (answered 409, or its key refused): folded; its snapshot maybe landed. */
    private async dropAttempt(docId: string, unanswered?: LocalSnapshot, clientId?: string) {
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            this.fold(current);
            if (unanswered) this.addUnconfirmed(current, unanswered, clientId);
            await this.options.store.put(current).catch(() => undefined);
        });
    }

    /** No answer came: the attempt stays (its retry replays), its snapshot may have landed. */
    private async rememberUnanswered(docId: string, snapshot: LocalSnapshot, clientId: string) {
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            this.addUnconfirmed(current, snapshot, clientId);
            await this.options.store.put(current).catch(() => undefined);
        });
    }

    private addUnconfirmed(record: SyncRecord, snapshot: LocalSnapshot, clientId?: string) {
        const unconfirmed = (record.unconfirmed ?? []).filter(
            (x) => x.manifestSha256 !== snapshot.manifestSha256,
        );
        const entry: NonNullable<SyncRecord["unconfirmed"]>[number] = {
            manifestSha256: snapshot.manifestSha256,
            blobs: snapshot.blobs,
        };
        if (clientId) entry.clientId = clientId;
        unconfirmed.push(entry);
        record.unconfirmed = unconfirmed.slice(-MAX_UNCONFIRMED);
    }

    /**
     * The newest version between the head and the record's base that is one of this device's
     * unanswered pushes — it landed, so it is the merge base (not the older record base).
     */
    private async landedPush(
        docId: string,
        record: SyncRecord,
    ): Promise<Result<CloudVersion | undefined, DocumentRepositoryError>> {
        // By manifest and by the client that sent it: another device saving the same content is not us.
        const unconfirmed = new Set(
            (record.unconfirmed ?? []).map((x) => `${x.manifestSha256}|${x.clientId ?? ""}`),
        );
        if (unconfirmed.size === 0) return Result.ok(undefined);
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
            const versions = await this.repository.listVersions(docId, { cursor, limit: 50 });
            // Unknown: merging against the older base would take this device's own version for theirs.
            if (!versions.isOk) return Result.err(versions.error);
            for (const version of versions.value.items) {
                if (version.id === record.baseVersion?.id) return Result.ok(undefined);
                if (version.clientId && unconfirmed.has(`${version.manifestSha256}|${version.clientId}`)) {
                    return Result.ok(version);
                }
            }
            cursor = versions.value.nextCursor;
            if (!cursor) return Result.ok(undefined);
        }
        return Result.ok(undefined);
    }

    private withTimeout(
        push: Promise<Result<PushOutcome, PushFailure>>,
    ): Promise<Result<PushOutcome, PushFailure>> {
        const ms = this.options.pushTimeoutMs ?? 120_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<Result<PushOutcome, PushFailure>>((resolve) => {
            timer = setTimeout(
                () => resolve(Result.err({ error: { kind: "offline" }, retryable: true })),
                ms,
            );
        });
        return Promise.race([push, timeout]).finally(() => clearTimeout(timer));
    }

    // ---- Pull --------------------------------------------------------------------------------

    private async pull(docId: string, entry: Entry, record: SyncRecord | undefined): Promise<void> {
        const saves = entry.saves;
        const head = await this.repository.fetchHead(docId);
        if (!head.isOk) {
            if (head.error.kind === "offline") {
                this.setState(docId, "offline");
                this.retry(docId, entry, { error: head.error, retryable: true });
            } else if (head.error.kind !== "unauthorized") {
                entry.pullRequested = false;
                this.setState(docId, "clean", false);
            }
            return;
        }
        entry.attempt = 0;
        const version = head.value.version;
        const document = this.openDocument(docId);
        const base = record?.baseVersion?.id ?? document?.version;
        if (
            !version ||
            (version.id === base && (!document || document.name === head.value.name || document.isDirty))
        ) {
            entry.pullRequested = false;
            entry.waitingIdle = false;
            this.setState(docId, "clean", false);
            return;
        }
        if (!document) {
            // Closed and clean: the next opening revalidates the cached base.
            entry.pullRequested = false;
            this.setState(docId, "clean", false);
            return;
        }
        if (!document.isDirty) {
            await this.fastForward(docId, entry, document, version, head.value.name, saves);
        } else {
            await this.mergeUnsaved(docId, entry, document, record, version, saves);
        }
    }

    /** Read-only tab: a newer version is shown when nothing was changed here, never pushed. */
    private async pullReadOnly(docId: string, entry: Entry, document: IDocument): Promise<void> {
        const head = await this.repository.fetchHead(docId);
        if (!head.isOk) return;
        const version = head.value.version;
        entry.pullRequested = false;
        if (
            !version ||
            (version.id === document.version && document.name === head.value.name) ||
            document.isDirty
        )
            return;
        const loaded = await this.repository.loadVersion(version);
        if (!loaded.isOk || !(await this.canReplace(document, entry))) {
            entry.pullRequested = true;
            return;
        }
        const applied = document.replaceContent(
            { ...loaded.value, name: head.value.name },
            REMOTE_UPDATE_HISTORY_NAME,
        );
        if (!applied.isOk) return;
        document.markSaved();
        document.version = version.id;
    }

    /**
     * Whether the open document's content may be replaced now: no save of it in flight (its content
     * was serialized before), the user not in the middle of something. Checked on a fresh task;
     * the caller then replaces synchronously.
     */
    private async canReplace(document: IDocument, entry: Entry): Promise<boolean> {
        await nextTask();
        if (!this.app.documents.has(document) || this.stopped) return false;
        // The save, once written, runs the next pass.
        if (entry.savesInFlight > 0) return false;
        if (this.activity.isBusy(this.app)) {
            entry.waitingIdle = true;
            this.startIdlePoll();
            return false;
        }
        entry.waitingIdle = false;
        return true;
    }

    /** A clean document: the newer head in place, as one undo step; the undo history stays. */
    private async fastForward(
        docId: string,
        entry: Entry,
        document: IDocument,
        version: CloudVersion,
        name: string,
        saves: number,
    ): Promise<void> {
        const loaded = await this.repository.loadVersion(version);
        if (!loaded.isOk) {
            this.retry(docId, entry, { error: loaded.error, retryable: loaded.error.kind === "offline" });
            return;
        }
        const manifest = await this.repository.manifestOf(version);
        if (!(await this.canReplace(document, entry))) {
            if (entry.waitingIdle) this.setState(docId, "clean", true);
            return;
        }
        if (document.isDirty || entry.saves !== saves) {
            // Edited (or saved) meanwhile: merged instead, on the next pass.
            entry.again = true;
            return;
        }
        const applied = document.replaceContent({ ...loaded.value, name }, REMOTE_UPDATE_HISTORY_NAME);
        if (!applied.isOk) {
            Logger.warn(`[cloud] ${docId}: the newer version can't be shown (${applied.error.kind})`);
            entry.pullRequested = false;
            this.setState(docId, "error", false);
            return;
        }
        document.markSaved();
        document.version = version.id;
        entry.pullRequested = false;
        entry.lastMerge = undefined;
        await this.rebase(docId, version, manifest.isOk ? manifest.value.blobs : [], name);
        this.setState(docId, "clean", false);
        PubSub.default.pub("showToast", "cloud.sync.updatedFrom{0}", this.deviceLabel(version.deviceName));
    }

    /** A clean record now based on `version` (written only if no save got in meanwhile). */
    private async rebase(docId: string, version: CloudVersion, blobs: string[], name?: string) {
        const ownerId = this.ownerId;
        if (!ownerId) return;
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            await this.options.store.putIfClean({
                docId,
                ownerId,
                name: name ?? current?.name ?? this.openDocument(docId)?.name ?? docId,
                baseVersion: versionRef(version, blobs),
                localDirty: false,
                clientId: this.repository.clientId,
                updatedAt: this.now(),
            });
        });
    }

    private deviceLabel(deviceName: string | null | undefined): string {
        return deviceName || I18n.translate("cloud.conflict.unknownDevice");
    }

    // ---- Merge -------------------------------------------------------------------------------

    /** The three inputs of a merge: the base (cached while pending), this device's, the head. */
    private async mergeInputs(
        record: SyncRecord | undefined,
        head: CloudVersion,
        oursFromRecord: boolean,
    ): Promise<
        Result<{ base?: Serialized; theirs: Serialized; ours?: Serialized }, DocumentRepositoryError>
    > {
        const theirs = await this.repository.loadVersion(head);
        if (!theirs.isOk) return Result.err(theirs.error);
        let base: Serialized | undefined;
        const baseRef = record?.baseVersion;
        if (baseRef) {
            const loaded = baseRef.manifestSha256
                ? await this.repository.loadVersion({
                      id: baseRef.id,
                      manifestSha256: baseRef.manifestSha256,
                  })
                : await this.repository.loadVersionById(baseRef.id);
            if (loaded.isOk) base = loaded.value;
            else if (loaded.error.kind === "offline") return Result.err(loaded.error);
        }
        let ours: Serialized | undefined;
        if (oursFromRecord && record) {
            const snapshot = await this.snapshotContent(record);
            if (!snapshot.isOk) return Result.err(snapshot.error);
            ours = snapshot.value;
        }
        return Result.ok({ base, theirs: theirs.value, ours });
    }

    /** The push met a newer head (409): merge this device's pending save into it. */
    private async diverged(docId: string, entry: Entry): Promise<void> {
        this.setState(docId, "diverged");
        const head = await this.repository.fetchHead(docId);
        if (!head.isOk || !head.value.version) {
            const failure: PushFailure = {
                error: head.isOk ? { kind: "notFound", id: docId } : head.error,
                retryable: !head.isOk && head.error.kind === "offline",
            };
            if (failure.retryable) this.deferPush(docId, entry, failure);
            else this.fail(docId, entry, failure);
            return;
        }
        const version = head.value.version;
        if (head.value.trashed) {
            this.fail(docId, entry, {
                error: { kind: "failed", message: "document_in_trash" },
                retryable: false,
                code: "document_in_trash",
            });
            return;
        }
        let record = await this.record(docId);
        if (!record?.localDirty || !record.localSnapshot) return;
        if (version.manifestSha256 === record.localSnapshot.manifestSha256) {
            // The head already is this save (an earlier push whose answer was lost).
            await this.adoptHead(docId, record, version);
            return;
        }
        const found = await this.landedPush(docId, record);
        if (!found.isOk) {
            this.deferPush(docId, entry, { error: found.error, retryable: found.error.kind === "offline" });
            return;
        }
        const landed = found.value;
        if (landed) {
            // An earlier push of this device did land: the pending save is based on it.
            const blobs =
                record.unconfirmed?.find((x) => x.manifestSha256 === landed.manifestSha256)?.blobs ?? [];
            record = await this.withRecord(docId, async () => {
                const current = await this.record(docId);
                if (!current) return undefined;
                current.baseVersion = versionRef(landed, blobs);
                current.unconfirmed = undefined;
                this.fold(current);
                // A merge that landed is done; what is pending now is an ordinary save on top of it.
                if (current.pendingKind === "merge") {
                    current.pendingKind = "auto";
                    current.mergeParent = undefined;
                }
                await this.options.store.put(current);
                return current;
            });
            if (!record) return;
            if (landed.id === version.id) {
                // Nothing from elsewhere: pushed again on top of it.
                this.setState(docId, "dirty");
                entry.again = true;
                return;
            }
        }
        this.setState(docId, "merging");
        const document = this.openDocument(docId);
        const inputs = await this.mergeInputs(record, version, document === undefined);
        if (!inputs.isOk) {
            this.deferPush(docId, entry, { error: inputs.error, retryable: inputs.error.kind === "offline" });
            return;
        }
        const { base, theirs } = inputs.value;
        if (!base) {
            this.enterConflict(docId, entry, record, version, undefined, "pending");
            return;
        }
        if (document) {
            if (!(await this.canReplace(document, entry))) {
                this.setState(docId, "diverged");
                return;
            }
            const position = document.history.position();
            const saves = entry.saves;
            const before = document.serialize();
            const merged = mergeDocuments(base, before, theirs);
            if (!merged.isOk || merged.value.conflicts.length > 0) {
                this.enterConflict(
                    docId,
                    entry,
                    record,
                    version,
                    merged.isOk ? merged.value : undefined,
                    "pending",
                );
                return;
            }
            const validated = await this.validate(merged.value);
            if (!validated) return;
            if (validated.conflicts.length > 0) {
                // The merge breaks the model where neither side did: the user decides (CLOUD-13).
                this.enterConflict(docId, entry, record, version, validated, "pending");
                return;
            }
            if (!(await this.canReplace(document, entry))) {
                this.setState(docId, "diverged");
                return;
            }
            if (document.history.position() !== position || entry.saves !== saves) {
                // Edited or saved while validating: merged again with that.
                entry.again = true;
                return;
            }
            // Synchronous from the check to the replacement: no save can serialize in between.
            const applied = applyMergeToDocument(document, merged.value);
            if (!applied.isOk) {
                this.enterConflict(docId, entry, record, version, merged.value, "pending");
                return;
            }
            const appliedAt = document.history.position();
            document.version = version.id;
            entry.lastMerge = {
                docId,
                before,
                result: merged.value,
                theirs: sideOf(versionRef(version, [])),
                appliedAt,
                local: "pending",
                base: record.baseVersion,
                pendingKind: record.pendingKind,
                pendingLabel: record.pendingLabel,
            };
            const recorded = await this.recordMerge(
                docId,
                entry,
                version,
                merged.value.merged,
                documentThumbnail(this.app, document),
            );
            // Clean once the merge is kept here (a save made meanwhile marked itself).
            if (recorded === "merged") document.markSaved(appliedAt);
        } else {
            const merged = mergeDocuments(base, inputs.value.ours!, theirs);
            if (!merged.isOk || merged.value.conflicts.length > 0) {
                this.enterConflict(
                    docId,
                    entry,
                    record,
                    version,
                    merged.isOk ? merged.value : undefined,
                    "pending",
                );
                return;
            }
            const validated = await this.validate(merged.value);
            if (!validated) return;
            if (validated.conflicts.length > 0) {
                this.enterConflict(docId, entry, record, version, validated, "pending");
                return;
            }
            await this.recordMerge(docId, entry, version, merged.value.merged);
        }
        this.mergedToast(docId, entry, version);
        this.setState(docId, "dirty");
        entry.again = true;
    }

    /** "Merged changes from <device>", with View changes / Undo merge while the merge can be undone. */
    private mergedToast(docId: string, entry: Entry, version: CloudVersion) {
        const device = this.deviceLabel(version.deviceName);
        const actions = entry.lastMerge ? this.options.toastActions?.merged?.(docId) : undefined;
        if (actions?.length)
            PubSub.default.pub("showActionToast", "cloud.sync.mergedFrom{0}", actions, device);
        else PubSub.default.pub("showToast", "cloud.sync.mergedFrom{0}", device);
    }

    /**
     * The kernel's check of a clean merge before it is pushed (`validateMerge`): features that fail
     * only after the merge come back as `rebuild-failure` conflicts. Without an evaluator (no app,
     * tests) or when it fails to run, the merge goes as it is; `undefined`: the sync stopped.
     */
    private async validate(result: MergeResult): Promise<MergeResult | undefined> {
        const evaluator = this.options.evaluator ?? MergeEvaluators.current;
        if (!evaluator) {
            if (!this.noEvaluatorLogged)
                Logger.info("[cloud] no merge evaluator: merges are pushed unvalidated");
            this.noEvaluatorLogged = true;
            return result;
        }
        const validated = await validateMerge(result, { evaluator, signal: this.abort.signal });
        if (this.stopped) return undefined;
        if (!validated.isOk) {
            if (validated.error.kind === "cancelled") return undefined;
            Logger.warn(`[cloud] merge validation failed (${validated.error.message}): pushed unvalidated`);
            return result;
        }
        return validated.value;
    }

    /**
     * The merged content becomes the pending save: a `merge` on top of the head. Called right after
     * the merge was applied to the open document (or computed for a closed one).
     */
    private async recordMerge(
        docId: string,
        entry: Entry,
        head: CloudVersion,
        merged: Serialized,
        thumbnail?: string,
    ): Promise<"merged" | "newer"> {
        // A save written from now on serialized the merged document: it is newer than `merged`.
        const savesAtMerge = entry.saves;
        const prepared = await this.repository.prepare(merged, thumbnail);
        if (!prepared.isOk) throw new Error(`merged document refused: ${prepared.error.kind}`);
        const { bytes, ...snapshot } = prepared.value;
        await Promise.all([...bytes].map(([sha, blob]) => this.repository.cache.putStrict(sha, blob)));
        const theirsBlobs = await this.repository.manifestOf(head);
        return this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return "newer";
            const previousBase = current.baseVersion?.id;
            // Saved after the merge was applied: that save contains it and is newer, keep it. A save
            // written before (while the inputs were fetched) is older than the merge: replaced.
            const newer = entry.saves !== savesAtMerge && current.localSnapshot !== undefined;
            if (!newer) current.localSnapshot = { ...snapshot, savedAt: this.now() };
            current.baseVersion = versionRef(head, theirsBlobs.isOk ? theirsBlobs.value.blobs : []);
            current.mergeParent = previousBase;
            current.pendingKind = "merge";
            current.localDirty = true;
            this.fold(current);
            current.updatedAt = this.now();
            await this.options.store.put(current);
            return newer ? "newer" : "merged";
        });
    }

    /** The head already has this device's pending content: it is the new base, nothing to push. */
    private async adoptHead(docId: string, record: SyncRecord, version: CloudVersion) {
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            current.baseVersion = versionRef(version, record.localSnapshot?.blobs ?? []);
            if (current.localSnapshot?.manifestSha256 === version.manifestSha256) {
                current.localDirty = false;
                current.localSnapshot = undefined;
                current.pendingKind = undefined;
                current.pendingLabel = undefined;
                current.pendingSince = undefined;
            }
            current.mergeParent = undefined;
            this.fold(current);
            await this.options.store.put(current);
        });
        const document = this.openDocument(docId);
        if (document) document.version = version.id;
        const entry = this.entry(docId);
        entry.pullRequested = false;
        this.setState(docId, "clean");
        entry.again = true;
    }

    /**
     * The head moved while the open document has unsaved edits (nothing pending): the head is
     * merged into it, the edits stay unsaved on top of it.
     */
    private async mergeUnsaved(
        docId: string,
        entry: Entry,
        document: IDocument,
        record: SyncRecord | undefined,
        version: CloudVersion,
        saves: number,
    ): Promise<void> {
        this.setState(docId, "merging");
        const inputs = await this.mergeInputs(record, version, false);
        if (!inputs.isOk) {
            this.setState(docId, inputs.error.kind === "offline" ? "offline" : "clean");
            if (inputs.error.kind === "offline")
                this.retry(docId, entry, { error: inputs.error, retryable: true });
            return;
        }
        const { base, theirs } = inputs.value;
        if (!(await this.canReplace(document, entry))) {
            this.setState(docId, "clean", entry.waitingIdle);
            return;
        }
        if (!document.isDirty || entry.saves !== saves) {
            // Saved (or undone) meanwhile: the next pass pushes or fast-forwards instead.
            entry.again = true;
            return;
        }
        const before = document.serialize();
        const merged = base ? mergeDocuments(base, before, theirs) : undefined;
        if (!merged?.isOk || merged.value.conflicts.length > 0) {
            this.enterConflict(
                docId,
                entry,
                record,
                version,
                merged?.isOk ? merged.value : undefined,
                "unsaved",
            );
            return;
        }
        const applied = applyMergeToDocument(document, merged.value);
        if (!applied.isOk) {
            this.enterConflict(docId, entry, record, version, merged.value, "unsaved");
            return;
        }
        entry.lastMerge = {
            docId,
            before,
            result: merged.value,
            theirs: sideOf(versionRef(version, [])),
            appliedAt: document.history.position(),
            local: "unsaved",
            base: record?.baseVersion,
        };
        document.version = version.id;
        entry.pullRequested = false;
        const manifest = await this.repository.manifestOf(version);
        await this.rebase(docId, version, manifest.isOk ? manifest.value.blobs : []);
        this.setState(docId, "clean", false);
        this.mergedToast(docId, entry, version);
    }

    private enterConflict(
        docId: string,
        entry: Entry,
        record: SyncRecord | undefined,
        head: CloudVersion,
        result: MergeResult | undefined,
        local: SyncConflict["local"],
        undone = false,
    ) {
        this.enterConflictWith(docId, entry, record, sideOf(versionRef(head, [])), result, local, undone);
    }

    private enterConflictWith(
        docId: string,
        entry: Entry,
        record: SyncRecord | undefined,
        theirs: SyncSide,
        result: MergeResult | undefined,
        local: SyncConflict["local"],
        undone: boolean,
    ) {
        entry.lastMerge = undefined;
        entry.conflictGeneration++;
        const conflict: Mutable<SyncConflict> = {
            docId,
            base: sideOf(record?.baseVersion),
            ours: {
                deviceName: this.repository.account.deviceSettings.effectiveDeviceName,
                at: record?.localSnapshot?.savedAt ?? this.now(),
            },
            theirs,
            local,
        };
        if (result) conflict.result = result;
        if (undone) conflict.undone = true;
        const first = entry.state !== "conflict";
        entry.conflict = conflict;
        entry.pullRequested = false;
        // No autosave while it waits: the user decides first (manual saves still land here).
        entry.releaseConflictHold ??= AutosaveHolds.hold(`sync conflict ${docId}`);
        if (entry.backgroundLock && !this.openDocument(docId)) {
            // Closed: nobody can resolve it here; the record stays, the next opening merges again.
            entry.backgroundLock = false;
            this.options.locks.release(docId);
        }
        this.setState(docId, "conflict");
        this.emit(docId);
        if (first && !undone) {
            const document = this.openDocument(docId);
            const name = document?.name ?? record?.name ?? docId;
            const actions = document ? this.options.toastActions?.conflict?.(docId) : undefined;
            if (actions?.length)
                PubSub.default.pub("showActionToast", "cloud.sync.conflict{0}", actions, name);
            else PubSub.default.pub("showToast", "cloud.sync.conflict{0}", name);
        }
    }

    private clearConflict(entry: Entry) {
        entry.conflict = undefined;
        entry.conflictGeneration++;
        entry.releaseConflictHold?.();
        entry.releaseConflictHold = undefined;
    }

    /** A newer head while in conflict: merged again, the conflict updated (choices are reapplied by path). */
    private async remerge(docId: string, entry: Entry, record: SyncRecord | undefined): Promise<void> {
        entry.pullRequested = false;
        const generation = entry.conflictGeneration;
        // Resolved, replaced or being resolved meanwhile: this re-merge is stale.
        const stale = () =>
            entry.state !== "conflict" || entry.conflictGeneration !== generation || entry.resolving > 0;
        const head = await this.repository.fetchHead(docId);
        if (stale() || !head.isOk || !head.value.version) return;
        const version = head.value.version;
        if (entry.conflict?.theirs.versionId === version.id) return;
        const document = this.openDocument(docId);
        const inputs = await this.mergeInputs(record, version, document === undefined);
        if (stale() || !inputs.isOk || !inputs.value.base) return;
        const ours = document ? document.serialize() : inputs.value.ours;
        if (!ours) return;
        const merged = mergeDocuments(inputs.value.base, ours, inputs.value.theirs);
        this.enterConflict(
            docId,
            entry,
            record,
            version,
            merged.isOk ? merged.value : undefined,
            entry.conflict?.local ?? "pending",
            entry.conflict?.undone,
        );
    }

    // ---- Resolution (the conflict panel, CLOUD-13; the MVP dialog) ---------------------------

    /**
     * Pauses the sync of a document (and autosave) while the user resolves its conflict; returns the
     * release, after which the sync goes on (idempotent).
     */
    hold(docId: string): () => void {
        const entry = this.entry(docId);
        entry.holds++;
        const releaseAutosave = AutosaveHolds.hold(`sync conflict ${docId}`);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseAutosave();
            entry.holds--;
            if (entry.holds === 0) this.schedulePass(docId, 0);
        };
    }

    /**
     * Resolves the conflict with the user's choices: merged again with the document as it is now,
     * the choices reapplied by path, applied as one undo step and pushed as a `merge` version.
     * Answers the remaining conflicts when the choices don't cover them all.
     */
    async resolve(
        docId: string,
        choices: readonly MergeResolution[],
        expected?: ExpectedMerge,
    ): Promise<
        Result<
            void,
            | { kind: "notInConflict" }
            | { kind: "unresolved"; result: MergeResult }
            | { kind: "changed"; result: MergeResult }
            | { kind: "busy" }
            | { kind: "failed"; message: string }
        >
    > {
        const entry = this.entries.get(docId);
        if (!entry?.conflict?.result || !entry.conflict.theirs.versionId)
            return Result.err({ kind: "notInConflict" });
        entry.resolving++;
        try {
            // A pass re-merging meanwhile finishes first (it would bring the conflict back after).
            while (entry.running) await entry.running;
            return await this.resolveNow(docId, entry, choices, expected);
        } finally {
            entry.resolving--;
        }
    }

    private async resolveNow(
        docId: string,
        entry: Entry,
        choices: readonly MergeResolution[],
        expected: ExpectedMerge | undefined,
    ): Promise<
        Result<
            void,
            | { kind: "notInConflict" }
            | { kind: "unresolved"; result: MergeResult }
            | { kind: "changed"; result: MergeResult }
            | { kind: "busy" }
            | { kind: "failed"; message: string }
        >
    > {
        const conflict = entry.conflict;
        if (!conflict?.result || !conflict.theirs.versionId) return Result.err({ kind: "notInConflict" });
        const document = this.openDocument(docId);
        if (document) {
            // Nothing is replaced under a running command; an edit session (the sketch editor)
            // commits and closes first, so what it holds is merged too.
            if (this.app.executingCommand) return Result.err({ kind: "busy" });
            EditSessions.endAll(document);
        }
        const record = await this.record(docId);
        const head = await this.repository.fetchHead(docId);
        if (!head.isOk || !head.value.version) {
            return Result.err({ kind: "failed", message: head.isOk ? "no head" : head.error.kind });
        }
        const version = head.value.version;
        const inputs = await this.mergeInputs(record, version, document === undefined);
        if (!inputs.isOk || !inputs.value.base) {
            return Result.err({ kind: "failed", message: inputs.isOk ? "no base" : inputs.error.kind });
        }
        // Whether this device has a pending save now (an unsaved-edits conflict may have been saved
        // meanwhile): read with no save in between, then merged and applied synchronously.
        let pending = false;
        for (let attempt = 0; ; attempt++) {
            const saves = entry.saves;
            pending = (await this.record(docId))?.localDirty === true;
            await nextTask();
            if (entry.saves === saves && entry.savesInFlight === 0) break;
            if (attempt === 10) return Result.err({ kind: "failed", message: "saving" });
        }
        const ours = document ? document.serialize() : inputs.value.ours!;
        const merged = mergeDocuments(inputs.value.base, ours, inputs.value.theirs);
        if (!merged.isOk) return Result.err({ kind: "failed", message: merged.error.kind });
        // Chained: a choice for a conflict another choice creates (a dangling reference) applies too;
        // choices for paths the merge no longer has (the head moved) are dropped.
        const reapplied = reapplyResolutions(merged.value, choices);
        if (!reapplied.isOk) return Result.err({ kind: "failed", message: reapplied.error.kind });
        const resolved = Result.ok<MergeResult>(reapplied.value.result);
        // What the user validated and previewed must be what is pushed: another head, a choice that
        // no longer applies (accepted rebuild failures are not structural) or another merge = ask again.
        const dropped = reapplied.value.dropped.filter((x) => !x.path.endsWith("/rebuild"));
        const changed =
            expected !== undefined &&
            ((expected.headVersionId !== undefined && expected.headVersionId !== version.id) ||
                dropped.length > 0 ||
                (expected.merged !== undefined &&
                    resolved.value.conflicts.length === 0 &&
                    JSON.stringify(resolved.value.merged) !== expected.merged));
        if (changed || resolved.value.conflicts.length > 0) {
            conflict.result = resolved.value;
            conflict.theirs = sideOf(versionRef(version, []));
            this.emit(docId);
            return Result.err({ kind: changed ? "changed" : "unresolved", result: resolved.value });
        }
        let appliedAt: object | undefined;
        if (document) {
            const applied = applyMergeToDocument(document, resolved.value);
            if (!applied.isOk) return Result.err({ kind: "failed", message: applied.error.kind });
            appliedAt = document.history.position();
            document.version = version.id;
        }
        this.clearConflict(entry);
        if (pending) {
            const recorded = await this.recordMerge(
                docId,
                entry,
                version,
                resolved.value.merged,
                document && documentThumbnail(this.app, document),
            );
            if (document && recorded === "merged") document.markSaved(appliedAt);
            this.setState(docId, "dirty");
        } else {
            const manifest = await this.repository.manifestOf(version);
            await this.rebase(docId, version, manifest.isOk ? manifest.value.blobs : []);
            this.setState(docId, "clean", false);
        }
        this.emit(docId);
        this.schedulePass(docId, 0);
        return Result.ok(undefined);
    }

    /**
     * "Save mine as the latest version": this device's content goes on top of the head as a manual
     * version, nothing merged (the history keeps both).
     */
    async keepMine(docId: string): Promise<Result<void, DocumentRepositoryError>> {
        const entry = this.entry(docId);
        entry.lastMerge = undefined;
        const head = await this.repository.fetchHead(docId);
        if (!head.isOk) return Result.err(head.error);
        const version = head.value.version;
        if (!version) return Result.err({ kind: "notFound", id: docId });
        const manifest = await this.repository.manifestOf(version);
        const document = this.openDocument(docId);
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            current.baseVersion = versionRef(version, manifest.isOk ? manifest.value.blobs : []);
            current.mergeParent = undefined;
            current.pendingKind = "manual";
            this.fold(current);
            await this.options.store.put(current);
        });
        this.clearConflict(entry);
        this.setState(docId, "dirty");
        if (document) {
            document.version = version.id;
            const saved = await document.save("manual");
            if (!saved.isOk) return Result.err(saved.error);
        } else {
            this.schedulePass(docId, 0);
        }
        await this.run(docId);
        return Result.ok(undefined);
    }

    /** "Open latest": this device's pending changes are dropped (the caller reopens the head). */
    async discardLocal(docId: string): Promise<void> {
        this.repository.loadFreshOnNextOpen(docId);
        const entry = this.entry(docId);
        entry.lastMerge = undefined;
        this.clearConflict(entry);
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            current.localDirty = false;
            current.localSnapshot = undefined;
            current.pendingKind = undefined;
            current.pendingLabel = undefined;
            current.pendingSince = undefined;
            current.mergeParent = undefined;
            this.fold(current);
            current.nextKind = undefined;
            current.nextLabel = undefined;
            await this.options.store.put(current);
        });
        this.setState(docId, "clean", false);
        this.emit(docId);
    }

    // ---- Undo merge (CLOUD-13) ---------------------------------------------------------------

    /** The clean merge last applied to the open document, while "Undo merge" can take it back. */
    lastMergeOf(docId: string): AppliedMerge | undefined {
        const last = this.entries.get(docId)?.lastMerge;
        const document = this.openDocument(docId);
        if (!last || !document || document.history.position() !== last.appliedAt) return undefined;
        return { docId, before: last.before, result: last.result, theirs: last.theirs };
    }

    /**
     * "Undo merge": the open document gets its content from before the clean merge back (one undo
     * step), and the sync stands where it stood before the merge — based on the same version,
     * this device's changes pending (or unsaved) again, the merge (pushed or not) now being
     * "theirs". It then waits in `conflict` (`undone`): pushing this device's content on top would
     * silently revert the other device's changes, and merging again by itself would loop. The user
     * merges again (`resolve`), keeps their content as a copy, or opens the latest. Refused once
     * the document was edited after the merge (`edited`).
     */
    async undoMerge(
        docId: string,
    ): Promise<
        Result<
            void,
            { kind: "unavailable" } | { kind: "edited" } | { kind: "busy" } | DocumentRepositoryError
        >
    > {
        const entry = this.entries.get(docId);
        const document = this.openDocument(docId);
        const last = entry?.lastMerge;
        if (!entry || !last || !document) return Result.err({ kind: "unavailable" });
        if (this.app.executingCommand) return Result.err({ kind: "busy" });
        // An edit session (the sketch editor) commits and closes first: edits it held count as edits.
        EditSessions.endAll(document);
        if (document.history.position() !== last.appliedAt) return Result.err({ kind: "edited" });
        const release = this.hold(docId);
        entry.resolving++;
        try {
            // A push of the merge in flight lands (or not) first; the hold keeps the next one back.
            while (entry.running) await entry.running;
            await document.settled();
            if (entry.lastMerge !== last) return Result.err({ kind: "unavailable" });
            if (document.history.position() !== last.appliedAt) return Result.err({ kind: "edited" });
            const saves = entry.saves;
            /** Unchanged since the checks: no edit, no save written or running. */
            const untouched = () =>
                document.history.position() === last.appliedAt &&
                entry.saves === saves &&
                entry.savesInFlight === 0 &&
                !this.app.executingCommand;
            let snapshot: LocalSnapshot | undefined;
            if (last.local === "pending") {
                const prepared = await this.repository.prepare(
                    last.before,
                    documentThumbnail(this.app, document),
                );
                if (!prepared.isOk) return Result.err(prepared.error);
                const { bytes, ...rest } = prepared.value;
                try {
                    await Promise.all(
                        [...bytes].map(([sha, blob]) => this.repository.cache.putStrict(sha, blob)),
                    );
                } catch (error) {
                    return Result.err(storageError(docId, error));
                }
                snapshot = { ...rest, savedAt: this.now() };
            }
            let previous: SyncRecord | undefined;
            const written = await this.withRecord(docId, async () => {
                const current = await this.record(docId);
                if (!current) return true;
                if (!untouched()) return false;
                previous = structuredClone(current);
                current.baseVersion = last.base;
                current.mergeParent = undefined;
                // A merge push that landed unanswered is "theirs" now, not this device's base.
                current.unconfirmed = undefined;
                this.fold(current);
                current.nextKind = undefined;
                current.nextLabel = undefined;
                if (snapshot) {
                    current.localSnapshot = snapshot;
                    current.localDirty = true;
                    current.pendingKind = last.pendingKind ?? "auto";
                    current.pendingLabel = last.pendingLabel;
                    current.pendingSince ??= this.now();
                }
                current.updatedAt = this.now();
                await this.options.store.put(current);
                return true;
            });
            if (!written) return Result.err({ kind: "edited" });
            // Synchronous from the check to the replacement: no save serializes in between.
            if (!untouched()) {
                // Edited or saved meanwhile: the record goes back.
                await this.restoreRecord(docId, previous, snapshot);
                return Result.err({ kind: "edited" });
            }
            const replaced = document.replaceContent(last.before, UNDO_MERGE_HISTORY_NAME);
            if (!replaced.isOk) {
                await this.restoreRecord(docId, previous, snapshot);
                return Result.err({ kind: "failed", message: replaced.error.kind });
            }
            document.version = last.base?.id;
            // Saved as it was: the pending snapshot holds it; unsaved edits stay unsaved.
            if (snapshot) document.markSaved();
            entry.lastMerge = undefined;
            const head = await this.repository.fetchHead(docId);
            const headVersion = head.isOk ? head.value.version : undefined;
            const record = await this.record(docId);
            if (headVersion) {
                const inputs = await this.mergeInputs(record, headVersion, false);
                const result =
                    inputs.isOk && inputs.value.base
                        ? mergeDocuments(inputs.value.base, document.serialize(), inputs.value.theirs)
                        : undefined;
                this.enterConflict(
                    docId,
                    entry,
                    record,
                    headVersion,
                    result?.isOk ? result.value : last.result,
                    last.local,
                    true,
                );
            } else {
                // Offline: the merge it undid stands as it was merged against.
                this.enterConflictWith(docId, entry, record, last.theirs, last.result, last.local, true);
            }
            return Result.ok(undefined);
        } finally {
            entry.resolving--;
            release();
        }
    }

    /**
     * An undone "Undo merge": the record's base and kind as they were. A save written meanwhile is
     * kept (it holds the merge and the edits after it); only this undo's snapshot is taken back.
     */
    private async restoreRecord(docId: string, previous: SyncRecord | undefined, snapshot?: LocalSnapshot) {
        if (!previous) return;
        await this.withRecord(docId, async () => {
            const current = await this.record(docId);
            if (!current) return;
            current.baseVersion = previous.baseVersion;
            current.mergeParent = previous.mergeParent;
            current.unconfirmed = previous.unconfirmed;
            if (current.pendingKind) {
                // Core's `combineSaves`: a label only stays with the kind it was saved with.
                const joined = combinePending(
                    previous.pendingKind,
                    previous.pendingLabel,
                    current.pendingKind,
                    current.pendingLabel,
                );
                current.pendingKind = joined.kind;
                current.pendingLabel = joined.label;
            } else current.pendingLabel = current.pendingLabel ?? previous.pendingLabel;
            if (snapshot && current.localSnapshot?.manifestSha256 === snapshot.manifestSha256) {
                current.localSnapshot = previous.localSnapshot;
                current.localDirty = previous.localDirty;
                current.pendingKind = previous.pendingKind;
                current.pendingLabel = previous.pendingLabel;
                current.pendingSince = previous.pendingSince;
            }
            current.updatedAt = this.now();
            await this.options.store.put(current);
        });
    }

    // ---- Triggers ----------------------------------------------------------------------------

    private readonly onEvent = (event: CloudEvent) => {
        if (event.type !== "document.updated" || !event.headVersionId) return;
        if (event.clientId && event.clientId === this.repository.clientId) return;
        const id = event.documentId;
        if (!this.entries.has(id) && !this.openDocument(id)) return;
        this.requestPull(id);
    };

    /** (Re)connected, back online, window focus: every open document's head is checked again. */
    readonly refreshAll = () => {
        if (this.stopped) return;
        // Closed documents with pending changes another tab left (or that were read-only here).
        void this.resumePending();
        for (const document of this.app.documents) {
            if (document.repository === this.repository) this.requestPull(document.id, 0);
        }
        for (const [id, entry] of this.entries) {
            if (entry.backgroundLock || entry.state === "offline" || entry.state === "dirty") {
                entry.attempt = 0;
                this.schedulePass(id, 0);
            }
        }
    };

    private readonly onVisibilityChange = () => {
        if (globalThis.document?.visibilityState === "visible") this.refreshAll();
    };

    private readonly onAccountChanged = (property: string | number | symbol) => {
        if (property !== "status" || !this.repository.account.isSignedIn) return;
        // Signed in again (an expired session): what waited for it goes on.
        for (const [id, entry] of this.entries) {
            if (entry.state === "error" || entry.state === "offline") {
                entry.attempt = 0;
                this.schedulePass(id, 0);
            }
        }
    };

    private readonly onAppChanged = (property: string | number | symbol) => {
        if (property === "executingCommand") this.resumeIdle();
    };

    private readonly resumeIdle = () => {
        if (this.activity.isBusy(this.app)) return;
        let waiting = false;
        for (const [id, entry] of this.entries) {
            if (!entry.waitingIdle) continue;
            waiting = true;
            entry.pullRequested = true;
            this.schedulePass(id, 0);
        }
        if (!waiting) this.stopIdlePoll();
    };

    private startIdlePoll() {
        this.idlePoll ??= setInterval(this.resumeIdle, this.options.idleCheckMs ?? 1000);
    }

    private stopIdlePoll() {
        clearInterval(this.idlePoll);
        this.idlePoll = undefined;
    }

    // ---- Cache -------------------------------------------------------------------------------

    /** The blob cache kept under its cap, never losing what a pending save needs. */
    private scheduleEviction() {
        if (this.evictTimer || this.stopped) return;
        this.evictTimer = setTimeout(() => {
            this.evictTimer = undefined;
            void this.evict();
        }, 5000);
    }

    async evict(): Promise<number> {
        const keep = new Set<string>();
        for (const record of await this.options.store.all()) {
            for (const sha of retainedBlobs(record)) keep.add(sha);
        }
        return this.repository.cache.evict(this.options.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT, keep);
    }
}
