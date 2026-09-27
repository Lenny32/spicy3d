// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import { ObjectStorage, Observable } from "./foundation";
import type { I18nKeys } from "./i18n";

/** The autosave intervals offered, in minutes; `0` = off. */
export const AUTOSAVE_INTERVALS = [0, 1, 2, 5, 10, 15, 30] as const;
export type AutosaveInterval = (typeof AUTOSAVE_INTERVALS)[number];
export const DEFAULT_AUTOSAVE_INTERVAL: AutosaveInterval = 5;

export function isAutosaveInterval(value: unknown): value is AutosaveInterval {
    return AUTOSAVE_INTERVALS.includes(value as AutosaveInterval);
}

/** The label of an interval in a setting's drop-down. */
export function autosaveIntervalLabel(interval: AutosaveInterval): [I18nKeys, ...unknown[]] {
    return interval === 0 ? ["autosave.interval.off"] : ["autosave.interval.minutes{0}", interval];
}

/**
 * Where the interval is kept instead of this browser while signed in (the cloud module: the user's
 * server settings, so it follows them across devices).
 */
export interface IAutosaveSettingsStore {
    /** The user chose `interval` (already cached as pending, see `AutosaveAccountCache`): send it. */
    save(interval: AutosaveInterval): void;
}

/**
 * The signed-in user's interval, cached in this browser so it applies from startup even when the
 * server can't be reached (the cloud module isn't even loaded then). Removed on sign-out.
 */
export interface AutosaveAccountCache {
    userId: string;
    intervalMinutes: AutosaveInterval;
    /** Changed here and not yet accepted by the server: sent on the next refresh. */
    pending?: boolean;
}

interface StoredAutosaveSettings {
    intervalMinutes?: unknown;
}

/**
 * The autosave interval (`autosave.intervalMinutes`). Signed out it lives in `localStorage`
 * (`spicy3d.settings.autosave`). Signed in, the cloud attaches an {@link IAutosaveSettingsStore}:
 * the account's value applies, changes go to the server, and the account's value is cached
 * (`spicy3d.settings.autosave.account`) for the next startup; signing out (`detach`) forgets it and
 * brings the local value back. Observable (`intervalMinutes`).
 */
export class AutosaveSettings extends Observable {
    static readonly current: AutosaveSettings = new AutosaveSettings();
    static readonly STORAGE_KEY = "autosave";
    static readonly ACCOUNT_STORAGE_KEY = "autosave.account";

    private store?: IAutosaveSettingsStore;

    constructor(private readonly storage: ObjectStorage = new ObjectStorage("spicy3d", "settings")) {
        super();
        this.setPrivateValue(
            "intervalMinutes",
            this.accountCache?.intervalMinutes ?? this.localIntervalMinutes,
        );
    }

    get intervalMinutes(): AutosaveInterval {
        return this.getPrivateValue("intervalMinutes", DEFAULT_AUTOSAVE_INTERVAL);
    }
    /**
     * The user's choice: for the account while one is attached or cached (sent to the server, now
     * or on the next refresh), for this browser otherwise.
     */
    set intervalMinutes(value: AutosaveInterval) {
        if (!isAutosaveInterval(value)) return;
        this.setProperty("intervalMinutes", value);
        const account = this.accountCache;
        if (account) {
            this.writeAccount({ userId: account.userId, intervalMinutes: value, pending: true });
            this.store?.save(value);
        } else {
            this.storage.setValue(AutosaveSettings.STORAGE_KEY, { intervalMinutes: value });
        }
    }

    /** The value kept in this browser (the signed-out one). */
    get localIntervalMinutes(): AutosaveInterval {
        const stored = this.read<StoredAutosaveSettings>(AutosaveSettings.STORAGE_KEY);
        const value = stored?.intervalMinutes;
        return isAutosaveInterval(value) ? value : DEFAULT_AUTOSAVE_INTERVAL;
    }

    get accountCache(): AutosaveAccountCache | undefined {
        const cached = this.read<Partial<AutosaveAccountCache>>(AutosaveSettings.ACCOUNT_STORAGE_KEY);
        if (typeof cached?.userId !== "string" || !isAutosaveInterval(cached.intervalMinutes))
            return undefined;
        return {
            userId: cached.userId,
            intervalMinutes: cached.intervalMinutes,
            pending: cached.pending === true,
        };
    }

    get hasStore(): boolean {
        return this.store !== undefined;
    }

    /**
     * Signed in as `userId`: the setting goes to `store`. It starts at that user's cached value, or
     * at the local one for a user not cached here. Returns the detach function (signed out), which
     * forgets the cached value and brings the local one back.
     */
    attach(store: IAutosaveSettingsStore, userId: string): () => void {
        this.store = store;
        let cached = this.accountCache;
        if (cached?.userId !== userId) {
            cached = { userId, intervalMinutes: this.localIntervalMinutes };
            this.writeAccount(cached);
        }
        this.setProperty("intervalMinutes", cached.intervalMinutes);
        return () => {
            if (this.store === store) this.forgetAccount();
        };
    }

    /**
     * Signed out (or the cached user turned out not to be signed in any more): the store is
     * detached, the account's cached value forgotten and the local value applies again.
     */
    forgetAccount(): void {
        this.store = undefined;
        this.storage.remove(AutosaveSettings.ACCOUNT_STORAGE_KEY);
        this.setProperty("intervalMinutes", this.localIntervalMinutes);
    }

    /** The server's value (it may come from another device): applied and cached, not sent back. */
    applyStoreValue(value: AutosaveInterval): void {
        const account = this.accountCache;
        if (!this.store || !account || !isAutosaveInterval(value)) return;
        this.writeAccount({ userId: account.userId, intervalMinutes: value });
        this.setProperty("intervalMinutes", value);
    }

    private writeAccount(cache: AutosaveAccountCache) {
        this.storage.setValue(AutosaveSettings.ACCOUNT_STORAGE_KEY, cache);
    }

    private read<T>(key: string): T | undefined {
        try {
            return this.storage.value<T>(key, undefined);
        } catch {
            return undefined;
        }
    }
}

/**
 * Something the user is in the middle of that no autosave may interrupt (a sketch session, a drag,
 * resolving a conflict). Commands and open dialogs are checked by the autosave service itself.
 */
export class AutosaveHolds {
    private static readonly holds = new Set<symbol>();
    private static readonly releaseListeners = new Set<() => void>();

    /** Holds autosave until the returned function is called (idempotent). */
    static hold(reason: string): () => void {
        const token = Symbol(reason);
        AutosaveHolds.holds.add(token);
        return () => {
            if (!AutosaveHolds.holds.delete(token)) return;
            if (AutosaveHolds.holds.size === 0) {
                for (const listener of [...AutosaveHolds.releaseListeners]) listener();
            }
        };
    }

    static get isHeld(): boolean {
        return AutosaveHolds.holds.size > 0;
    }

    /** Called whenever the last hold is released; returns the unsubscribe function. */
    static onReleased(listener: () => void): () => void {
        AutosaveHolds.releaseListeners.add(listener);
        return () => AutosaveHolds.releaseListeners.delete(listener);
    }
}

/** Whether an opened `.spicy` file is written back by autosave: unavailable without a writable file. */
export type FileAutosaveState = "unavailable" | "off" | "on";

/** The per-file opt-in for writing autosaves back to the `.spicy` file a document was opened from. */
export interface IFileAutosave {
    state(document: IDocument): FileAutosaveState;
    /** Resolves whether it is now on (turning it on asks the browser for write access). */
    set(document: IDocument, enabled: boolean): Promise<boolean>;
}

/**
 * What the autosave service tells the UI: when each document was last autosaved (cleared by a save
 * of another kind), and the per-file opt-in (registered by the app).
 */
export class AutosaveStatus {
    static readonly current: AutosaveStatus = new AutosaveStatus();

    fileAutosave: IFileAutosave | undefined;
    private readonly autosaved = new WeakMap<IDocument, number>();
    private readonly listeners = new Set<(document: IDocument) => void>();

    /** Epoch milliseconds of the last autosave, while it is the document's last save. */
    lastAutosavedAt(document: IDocument): number | undefined {
        return this.autosaved.get(document);
    }

    recordAutosave(document: IDocument, at: number): void {
        this.autosaved.set(document, at);
        this.changed(document);
    }

    clear(document: IDocument): void {
        if (this.autosaved.delete(document)) this.changed(document);
    }

    changed(document: IDocument): void {
        for (const listener of [...this.listeners]) listener(document);
    }

    /** Returns the unsubscribe function. */
    onChanged(listener: (document: IDocument) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
