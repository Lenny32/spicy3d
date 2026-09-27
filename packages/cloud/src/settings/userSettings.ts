// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AutosaveInterval,
    AutosaveSettings,
    DEFAULT_AUTOSAVE_INTERVAL,
    type IAutosaveSettingsStore,
    isAutosaveInterval,
    Logger,
    type Result,
} from "@spicy3d/core";
import type { Account } from "../account/account";
import type { ApiSchema } from "../api";
import { type CloudReply, ifMatch } from "../client";
import type { CloudError } from "../problem";

export type UserSettings = ApiSchema<"UserSettings">;

/** The ETag of settings the user never saved (SpicySrv `SettingsEndpoints.DefaultsETag`). */
export const DEFAULT_SETTINGS_ETAG = "0";

/** Refreshes on tab focus at most this often. */
const REFRESH_ON_FOCUS_MS = 10_000;

/** The interval of the server's settings: `enabled: false` = off; absent = the defaults. */
export function intervalOf(settings: UserSettings | undefined): AutosaveInterval {
    const autosave = settings?.autosave;
    if (autosave?.enabled === false) return 0;
    // `integer | string` in the spec (SpicySrv#8).
    const minutes = Number(autosave?.intervalMinutes ?? DEFAULT_AUTOSAVE_INTERVAL);
    return isAutosaveInterval(minutes) && minutes !== 0 ? minutes : DEFAULT_AUTOSAVE_INTERVAL;
}

/**
 * `settings` with the interval set. The server rejects unknown keys and resets absent ones to their
 * defaults, so every other key of the fetched document is sent back as it was. Off keeps the last
 * interval (the server has no "off" interval: `enabled` says it).
 */
export function withInterval(settings: UserSettings | undefined, interval: AutosaveInterval): UserSettings {
    const previous = Number(settings?.autosave?.intervalMinutes);
    const minutes = interval !== 0 ? interval : isAutosaveInterval(previous) && previous !== 0 ? previous : 5;
    return {
        ...settings,
        autosave: { ...settings?.autosave, enabled: interval !== 0, intervalMinutes: minutes },
    };
}

export interface CloudUserSettingsOptions {
    settings?: AutosaveSettings;
}

/**
 * The signed-in user's settings on the server (`GET/PUT /api/me/settings`, SRV-06) — today the
 * autosave interval, so it follows the user across devices. Attached to {@link AutosaveSettings}
 * while signed in: on sign-in the server's value wins, or, when the user never saved any settings
 * (ETag `"0"`), this device's value is uploaded; a change made here is cached as pending and sent
 * with `If-Match` (412: another device changed them meanwhile → fetched again and re-applied, the
 * change made here being the latest). The value is re-read on sign-in, when the tab comes back, when
 * the network returns and when the account settings open, so a change on another device shows up.
 * (The server's `settings.updated` event will make it immediate with the real-time channel, CLOUD-10.)
 */
export class CloudUserSettings implements IAutosaveSettingsStore {
    readonly settings: AutosaveSettings;
    private detach?: () => void;
    private attachedUser?: string;
    private queue: Promise<void> = Promise.resolve();
    private lastRefresh = Number.NEGATIVE_INFINITY;
    /** The last settings document the server answered, sent back with the change. */
    private server?: { data: UserSettings; etag?: string };

    constructor(
        readonly account: Account,
        options: CloudUserSettingsOptions = {},
    ) {
        this.settings = options.settings ?? AutosaveSettings.current;
        account.onPropertyChanged(this.onAccountChanged);
        globalThis.document?.addEventListener("visibilitychange", this.onVisible);
        globalThis.addEventListener?.("online", this.onOnline);
        this.sync();
    }

    dispose(): void {
        this.account.removePropertyChanged(this.onAccountChanged);
        globalThis.document?.removeEventListener("visibilitychange", this.onVisible);
        globalThis.removeEventListener?.("online", this.onOnline);
        // Not a sign-out: the cached value stays for the next startup.
        this.detach = undefined;
    }

    /** Resolves once every queued request has run. */
    settled(): Promise<void> {
        return this.queue;
    }

    private readonly onAccountChanged = (property: string | number | symbol) => {
        if (property === "status" || property === "user") this.sync();
    };

    private sync() {
        const { status, user } = this.account;
        if (status === "signedIn" && user) {
            if (this.attachedUser === user.id) return;
            this.detach?.();
            this.detach = this.settings.attach(this, user.id);
            this.attachedUser = user.id;
            this.server = undefined;
            void this.refresh();
        } else if (status === "signedOut") {
            this.detach?.();
            this.detach = undefined;
            this.attachedUser = undefined;
            this.server = undefined;
        }
        // `unknown` (not asked yet, or offline) and `expired`: the cached value keeps applying.
    }

    private readonly onVisible = () => {
        if (globalThis.document?.visibilityState !== "visible") return;
        if (Date.now() - this.lastRefresh < REFRESH_ON_FOCUS_MS) return;
        void this.refresh();
    };

    private readonly onOnline = () => void this.refresh();

    /** `IAutosaveSettingsStore`: the user changed the interval here. */
    save(_interval: AutosaveInterval): void {
        void this.enqueue(() => this.push());
    }

    /** Reads the server's settings (and sends a pending change first). */
    refresh(): Promise<void> {
        this.lastRefresh = Date.now();
        return this.enqueue(() => this.pull());
    }

    private enqueue(run: () => Promise<void>): Promise<void> {
        const next = this.queue.then(run).catch((error) => {
            Logger.warn(`[cloud] settings: ${error}`);
        });
        this.queue = next;
        return next;
    }

    /** Signed in as the attached user, with the value cached for them. */
    private cache() {
        const cache = this.settings.accountCache;
        return this.account.isSignedIn && this.attachedUser && cache?.userId === this.attachedUser
            ? cache
            : undefined;
    }

    private async fetch(): Promise<boolean> {
        const result = await this.account.call((api) => api.GET("/api/me/settings"));
        if (!result.isOk) {
            Logger.info(`[cloud] settings not read: ${result.error.kind}`);
            return false;
        }
        this.server = { data: result.value.data, etag: result.value.etag };
        return true;
    }

    private async pull() {
        if (!this.cache() || !(await this.fetch())) return;
        const cache = this.cache();
        if (!cache || !this.server) return;
        if (cache.pending || this.server.etag === DEFAULT_SETTINGS_ETAG) {
            // A change made here (maybe offline), or an account without settings yet: this
            // device's value goes up.
            await this.push();
            return;
        }
        this.settings.applyStoreValue(intervalOf(this.server.data));
    }

    private async push() {
        const cache = this.cache();
        if (!cache?.pending && !(this.server?.etag === DEFAULT_SETTINGS_ETAG && cache)) return;
        if (!this.server && !(await this.fetch())) return;
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = this.cache();
            if (!current || !this.server) return;
            const result = await this.put(this.server, current.intervalMinutes);
            if (result.isOk) {
                this.server = { data: result.value.data, etag: result.value.etag };
                // Changed again meanwhile: that change is queued behind this one.
                if (this.cache()?.intervalMinutes === current.intervalMinutes) {
                    this.settings.applyStoreValue(intervalOf(result.value.data));
                }
                return;
            }
            const error = result.error;
            if (!(error.kind === "problem" && error.status === 412)) {
                // Offline or refused: stays pending (refused: the next refresh shows the server's).
                Logger.warn(`[cloud] settings not saved: ${describe(error)}`);
                if (error.kind === "problem" && error.status >= 400 && error.status < 500) {
                    this.settings.applyStoreValue(intervalOf(this.server.data));
                }
                return;
            }
            // Changed on another device since: fetch what it saved, then apply this change on top.
            if (!(await this.fetch())) return;
        }
    }

    private put(
        base: { data: UserSettings; etag?: string },
        interval: AutosaveInterval,
    ): Promise<Result<CloudReply<UserSettings>, CloudError>> {
        const body = withInterval(base.data, interval);
        return this.account.call((api) =>
            api.PUT("/api/me/settings", {
                params: { header: base.etag ? { "If-Match": ifMatch(base.etag) } : {} },
                body,
            }),
        );
    }
}

function describe(error: CloudError): string {
    return error.kind === "problem" ? `${error.status} ${error.problem.code ?? ""}`.trim() : error.kind;
}
