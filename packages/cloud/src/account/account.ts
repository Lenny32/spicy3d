// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, Observable, Result } from "@spicy3d/core";
import type { ApiSchema } from "../api";
import type { ApiClient, CloudClient, CloudReply } from "../client";
import type { CloudError } from "../problem";
import { CloudDeviceSettings } from "./deviceSettings";

export type AccountUser = ApiSchema<"MeResponse">;
export type AccountSession = ApiSchema<"SessionResponse">;
export type AccessToken = ApiSchema<"AccessTokenResponse">;
export type CreatedAccessToken = ApiSchema<"CreatedAccessTokenResponse">;
export type CreateAccessTokenRequest = ApiSchema<"CreateAccessTokenRequest">;
export type SignUpRequest = ApiSchema<"SignUpRequest">;

/**
 * - `unknown`: not asked yet (startup), or the server couldn't be reached to ask.
 * - `signedOut`: no session; the app is local-only.
 * - `signedIn`: `user` is set.
 * - `expired`: the session ended while signed in (expiry, sign-out elsewhere, password reset);
 *   `user` is kept so the re-login dialog knows whose session it was, and nothing is discarded.
 */
export type AccountStatus = "unknown" | "signedOut" | "signedIn" | "expired";

/** Why the account was signed out on this device. */
export type SignOutReason =
    /** The user signed out (or revoked this device's session). */
    | "signOut"
    /** The user gave up re-signing in after the session expired. */
    | "expired"
    /** The account was deleted: every cloud copy goes, whatever the setting. */
    | "deleted"
    /**
     * Another user signed in on this device (another tab, an email link of theirs): the previous
     * user's cloud copies go, whatever the setting, so the new user never sees them.
     */
    | "switchUser";

export interface SignOutEvent {
    reason: SignOutReason;
    /**
     * Whether cached copies of cloud documents must be removed from this device: always after a
     * deletion, otherwise unless the user keeps offline copies. Local documents are never touched.
     */
    removeCachedDocuments: boolean;
}

/** Stops sync, removes cached cloud documents… (CLOUD-06 registers them); must not throw. */
export type SignOutHandler = (event: SignOutEvent) => void | Promise<void>;

/**
 * Asked to get the user signed in again after the session expired, e.g. by opening the re-login
 * dialog. It ends by `signIn` succeeding or by `cancelReauthentication()`.
 */
export type ReauthenticationHandler = (account: Account) => void;

export type SignUpOutcome =
    /** Signed in straight away (no email verification required). */
    | { status: "signedIn"; user: AccountUser }
    /**
     * The server requires a verified email: a link was sent (the same answer is given for an
     * address that is already registered, so nothing leaks). Not signed in.
     */
    | { status: "verificationRequired" };

export type EmailChangeOutcome =
    /** The server can't send email: the change applied at once, unverified. */
    | { status: "applied"; user: AccountUser }
    /** A confirmation link was sent to the new address; nothing changes until it is opened. */
    | { status: "confirmationSent" };

export interface ExportedData {
    data: Blob;
    fileName: string;
}

type Send<D> = (api: ApiClient) => Promise<{ data?: D; error?: unknown; response: Response }>;

function isUnauthorized(error: CloudError): boolean {
    return error.kind === "problem" && error.status === 401;
}

function map<T, U>(result: Result<T, CloudError>, f: (value: T) => U): Result<U, CloudError> {
    return result.isOk ? Result.ok(f(result.value)) : Result.err(result.error);
}

const done = () => undefined;

/** The export's name as the server gives it (`spicy3d-export-2026-09-27T140500Z.zip`), in UTC. */
export function exportFileName(now = new Date()): string {
    const iso = now.toISOString().replace(/\.\d+Z$/, "Z");
    return `spicy3d-export-${iso.replace(/:/g, "")}.zip`;
}

/**
 * The signed-in user of the cloud and every account operation. Observable (`status`, `user`) so the
 * account menu, the cloud repository (CLOUD-06), autosave settings (CLOUD-07) and remote MCP
 * (CLOUD-14) can follow sign-in and sign-out.
 *
 * Calls that need the session go through {@link call}: when the session has expired it asks the
 * {@link ReauthenticationHandler} to get the user signed in again and then retries once, so a pending
 * save survives an expiry without losing anything.
 */
export class Account extends Observable {
    private readonly signOutHandlers = new Set<SignOutHandler>();
    private reauthenticationHandler?: ReauthenticationHandler;
    private reauthentication?: { promise: Promise<boolean>; resolve: (signedIn: boolean) => void };

    constructor(
        readonly client: CloudClient,
        readonly deviceSettings: CloudDeviceSettings = new CloudDeviceSettings(),
    ) {
        super();
        this.setPrivateValue("status", "unknown");
        this.setPrivateValue("user", undefined);
    }

    get status(): AccountStatus {
        return this.getPrivateValue("status", "unknown");
    }

    get user(): AccountUser | undefined {
        return this.getPrivateValue("user", undefined);
    }

    get isSignedIn(): boolean {
        return this.status === "signedIn";
    }

    /** Registers what must happen on sign-out; returns the unregister function. */
    addSignOutHandler(handler: SignOutHandler): () => void {
        this.signOutHandlers.add(handler);
        return () => this.signOutHandlers.delete(handler);
    }

    setReauthenticationHandler(handler: ReauthenticationHandler | undefined): void {
        this.reauthenticationHandler = handler;
    }

    // ---- Session state -----------------------------------------------------------------------

    /** `GET /api/me`: who is signed in (at startup, and after anything that may have changed it). */
    async refresh(): Promise<Result<AccountUser | undefined, CloudError>> {
        const result = await this.client.call((api) => api.GET("/api/me"));
        if (result.isOk) {
            await this.setSignedIn(result.value.data);
            return Result.ok(result.value.data);
        }
        if (isUnauthorized(result.error)) {
            // No session any more (revoked, expired): never signed in again from the cache.
            this.deviceSettings.rememberUser(undefined);
            this.cachedSession = false;
            if (this.status === "signedIn") this.markExpired();
            else if (this.status !== "expired") this.setProperty("status", "signedOut");
            return Result.ok(undefined);
        }
        // The server is out of reach at startup: the user last confirmed here (within 30 days)
        // stays signed in, so their cached documents open and their pending saves wait — until
        // `confirmSession` asks the server once it can be reached.
        const cached = this.deviceSettings.lastUser();
        if (result.error.kind === "offline" && this.status === "unknown" && cached) {
            this.cachedSession = true;
            this.setProperty("user", cached);
            this.setProperty("status", "signedIn");
        }
        return Result.err(result.error);
    }

    /** Signed in from the cache at an offline start, not confirmed by the server yet. */
    get isUnconfirmed(): boolean {
        return this.cachedSession;
    }

    private cachedSession = false;
    private confirming?: Promise<boolean>;

    /**
     * Resolves whether the session is confirmed: right away unless signed in from the cache, else
     * after asking the server (`GET /api/me`). Offline: `false`, asked again next time. A 401 ends
     * the cached session (expired: the re-login dialog). Nothing is pushed before it answers.
     */
    confirmSession(): Promise<boolean> {
        if (!this.cachedSession) return Promise.resolve(this.isSignedIn);
        this.confirming ??= this.refresh()
            .then((result) => result.isOk && result.value !== undefined && this.isSignedIn)
            .finally(() => {
                this.confirming = undefined;
            });
        return this.confirming;
    }

    /**
     * Runs a request that needs the session. On a 401 while signed in, the session is marked
     * expired, the user is asked to sign in again, and the request is retried once afterwards.
     * The 401 is returned when the user doesn't sign in again.
     */
    async call<D>(send: Send<D>): Promise<Result<CloudReply<D>, CloudError>> {
        const first = await this.client.call(send);
        if (first.isOk || !isUnauthorized(first.error)) return first;
        if (this.status !== "signedIn" && this.status !== "expired") return first;
        return (await this.reauthenticate()) ? this.client.call(send) : first;
    }

    /**
     * Resolves `true` once the user is signed in again after an expiry (right away when signed in and
     * not expired), `false` if they give up. Concurrent callers share one prompt.
     */
    reauthenticate(): Promise<boolean> {
        if (this.status === "signedOut" || this.status === "unknown") return Promise.resolve(false);
        if (this.status === "signedIn") this.markExpired();
        if (this.reauthentication) return this.reauthentication.promise;

        let resolve!: (signedIn: boolean) => void;
        const promise = new Promise<boolean>((r) => {
            resolve = r;
        });
        this.reauthentication = { promise, resolve };
        if (this.reauthenticationHandler) {
            this.reauthenticationHandler(this);
        } else {
            Logger.warn("[cloud] session expired and nothing can ask the user to sign in again");
            void this.cancelReauthentication();
        }
        return promise;
    }

    /** The user declined to sign in again: signed out on this device, open documents untouched. */
    async cancelReauthentication(): Promise<void> {
        if (this.status !== "expired") return;
        await this.finishSignOut("expired");
    }

    // ---- Sign up, in, out --------------------------------------------------------------------

    async signUp(request: SignUpRequest): Promise<Result<SignUpOutcome, CloudError>> {
        const result = await this.client.call((api) => api.POST("/api/auth/signup", { body: request }));
        if (!result.isOk) return Result.err(result.error);
        if (result.value.status === 201 && result.value.data) {
            await this.setSignedIn(result.value.data);
            return Result.ok({ status: "signedIn", user: result.value.data });
        }
        return Result.ok({ status: "verificationRequired" });
    }

    async signIn(email: string, password: string): Promise<Result<AccountUser, CloudError>> {
        const result = await this.client.call((api) =>
            api.POST("/api/auth/login", { body: { email, password } }),
        );
        if (!result.isOk) return Result.err(result.error);
        await this.setSignedIn(result.value.data);
        return Result.ok(result.value.data);
    }

    /** Ends the session on the server (best effort: offline still signs out here). */
    async signOut(): Promise<void> {
        const result = await this.client.call((api) => api.POST("/api/auth/logout"));
        if (!result.isOk) Logger.warn(`[cloud] sign-out request failed: ${result.error.kind}`);
        await this.finishSignOut("signOut");
    }

    // ---- Email links (anonymous) -------------------------------------------------------------

    async verifyEmail(userId: string, token: string): Promise<Result<void, CloudError>> {
        const result = await this.client.call((api) =>
            api.POST("/api/auth/verify-email", { body: { userId, token } }),
        );
        if (result.isOk && this.user?.id === userId) await this.refresh();
        return map(result, done);
    }

    /** Signed in but unverified: sends the verification email again. */
    async resendVerification(): Promise<Result<void, CloudError>> {
        return map(await this.call((api) => api.POST("/api/auth/resend-verification")), done);
    }

    async forgotPassword(email: string): Promise<Result<void, CloudError>> {
        return map(
            await this.client.call((api) => api.POST("/api/auth/forgot-password", { body: { email } })),
            done,
        );
    }

    /** Sets a new password from a reset link; the server signs every session out. */
    async resetPassword(
        userId: string,
        token: string,
        newPassword: string,
    ): Promise<Result<void, CloudError>> {
        const result = await this.client.call((api) =>
            api.POST("/api/auth/reset-password", { body: { userId, token, newPassword } }),
        );
        if (result.isOk && this.user?.id === userId) await this.finishSignOut("signOut");
        return map(result, done);
    }

    /** Applies an email change from its confirmation link; the server signs every session out. */
    async confirmEmailChange(
        userId: string,
        email: string,
        token: string,
    ): Promise<Result<void, CloudError>> {
        const result = await this.client.call((api) =>
            api.POST("/api/auth/confirm-email-change", { body: { userId, email, token } }),
        );
        if (result.isOk && this.user?.id === userId) await this.finishSignOut("signOut");
        return map(result, done);
    }

    // ---- Profile -----------------------------------------------------------------------------

    async updateDisplayName(displayName: string): Promise<Result<AccountUser, CloudError>> {
        const result = await this.call((api) => api.PATCH("/api/me", { body: { displayName } }));
        if (result.isOk) this.setProperty("user", result.value.data);
        return map(result, (reply) => reply.data);
    }

    /** Other sessions are signed out and every access token revoked; this one stays. */
    async changePassword(currentPassword: string, newPassword: string): Promise<Result<void, CloudError>> {
        return map(
            await this.call((api) =>
                api.POST("/api/me/change-password", { body: { currentPassword, newPassword } }),
            ),
            done,
        );
    }

    async changeEmail(
        newEmail: string,
        currentPassword: string,
    ): Promise<Result<EmailChangeOutcome, CloudError>> {
        const result = await this.call((api) =>
            api.POST("/api/me/change-email", { body: { newEmail, currentPassword } }),
        );
        if (!result.isOk) return Result.err(result.error);
        if (result.value.status === 202 || !result.value.data)
            return Result.ok({ status: "confirmationSent" });
        this.setProperty("user", result.value.data);
        return Result.ok({ status: "applied", user: result.value.data });
    }

    // ---- Sessions and access tokens ----------------------------------------------------------

    async listSessions(): Promise<Result<AccountSession[], CloudError>> {
        return map(await this.call((api) => api.GET("/api/me/sessions")), (reply) => reply.data);
    }

    /** Revoking this device's own session signs it out. */
    async revokeSession(session: Pick<AccountSession, "id" | "current">): Promise<Result<void, CloudError>> {
        const result = await this.call((api) =>
            api.DELETE("/api/me/sessions/{id}", { params: { path: { id: session.id } } }),
        );
        if (result.isOk && session.current) await this.finishSignOut("signOut");
        return map(result, done);
    }

    async listAccessTokens(): Promise<Result<AccessToken[], CloudError>> {
        return map(await this.call((api) => api.GET("/api/me/tokens")), (reply) => reply.data);
    }

    /** The answer holds the secret, which the server never shows again. */
    async createAccessToken(
        request: CreateAccessTokenRequest,
    ): Promise<Result<CreatedAccessToken, CloudError>> {
        return map(
            await this.call((api) => api.POST("/api/me/tokens", { body: request })),
            (reply) => reply.data,
        );
    }

    async revokeAccessToken(id: string): Promise<Result<void, CloudError>> {
        return map(
            await this.call((api) => api.DELETE("/api/me/tokens/{id}", { params: { path: { id } } })),
            done,
        );
    }

    // ---- Privacy -----------------------------------------------------------------------------

    /** The ZIP of everything the server stores for the account (once per hour, `429` otherwise). */
    async exportData(history: boolean): Promise<Result<ExportedData, CloudError>> {
        const result = await this.call((api) =>
            api.GET("/api/me/export", { params: { query: { history } }, parseAs: "blob" }),
        );
        return map(result, (reply) => ({ data: reply.data as Blob, fileName: exportFileName() }));
    }

    /**
     * Deletes the account and all its data on the server, then signs out here and removes every
     * cached cloud copy. Local documents are untouched.
     */
    async deleteAccount(currentPassword: string): Promise<Result<void, CloudError>> {
        const result = await this.call((api) => api.POST("/api/me/delete", { body: { currentPassword } }));
        if (result.isOk) await this.finishSignOut("deleted");
        return map(result, done);
    }

    // ---- Internals ---------------------------------------------------------------------------

    /**
     * The one place a user becomes signed in. Another user than the previous one (whatever the
     * status: signed in, expired with a re-login pending) first signs the previous one out —
     * handlers run, cloud copies are removed, a pending re-login answers `false` so nothing queued
     * for them is retried under the new session — and only then signs the new one in.
     */
    private async setSignedIn(user: AccountUser) {
        const previous = this.user;
        if (previous && previous.id !== user.id) await this.finishSignOut("switchUser");
        this.deviceSettings.rememberUser(user);
        this.cachedSession = false;
        this.setProperty("user", user);
        this.setProperty("status", "signedIn");
        this.settleReauthentication(true);
    }

    private markExpired() {
        this.setProperty("status", "expired");
    }

    private settleReauthentication(signedIn: boolean) {
        const pending = this.reauthentication;
        this.reauthentication = undefined;
        pending?.resolve(signedIn);
    }

    private async finishSignOut(reason: SignOutReason) {
        const wasSignedIn = this.user !== undefined;
        this.deviceSettings.rememberUser(undefined);
        this.cachedSession = false;
        this.setProperty("user", undefined);
        this.setProperty("status", "signedOut");
        this.settleReauthentication(false);
        if (!wasSignedIn) return;

        const event: SignOutEvent = {
            reason,
            removeCachedDocuments:
                reason === "deleted" || reason === "switchUser" || !this.deviceSettings.keepOfflineCopies,
        };
        for (const handler of [...this.signOutHandlers]) {
            try {
                await handler(event);
            } catch (error) {
                Logger.warn(`[cloud] sign-out handler failed: ${error}`);
            }
        }
    }
}
