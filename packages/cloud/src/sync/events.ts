// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, trimTrailingSlashes } from "@spicy3d/core";
import type { Account } from "../account/account";

/**
 * The server's real-time events (`/ws/events`, SRV-07; not in the OpenAPI document, the contract is
 * SpicySrv's `docs/events.md`): one JSON object per text message. Hints, not a log: after every
 * (re)connect the client refetches what it shows. Unknown types and fields are ignored.
 */
export type CloudEvent =
    | {
          type: "document.updated";
          documentId: string;
          /** `null` for a rename. */
          headVersionId: string | null;
          kind: string | null;
          /** The saving tab's `clientId`: a tab skips its own saves. */
          clientId: string | null;
          at: string;
      }
    | { type: "document.deleted" | "document.restored"; documentId: string; at: string }
    | { type: "settings.updated" | "session.revoked" | "ping"; at: string };

/** The part of `WebSocket` used here. */
export interface SocketLike {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code: number; reason: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface EventsChannelOptions {
    /** `config.eventsSocket`: absolute (`wss://…/ws/events`), or relative to `baseUrl`. */
    url: string;
    /** The API's base URL (the client's), to resolve a relative `url`. */
    baseUrl: string;
    account: Account;
    createSocket?: SocketFactory;
    /** The server's heartbeat interval (`Events__HeartbeatSeconds`, default 30 s). */
    heartbeatMs?: number;
    /** Reconnect backoff: first delay and cap (default 1 s, 30 s), with jitter. */
    initialDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
}

/** Normal closure; a `1008` after `session.revoked` is final. */
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

/** The absolute WebSocket URL of `url` (`http(s)` → `ws(s)`). */
export function eventsSocketUrl(url: string, baseUrl: string): string {
    const resolved = new URL(url, `${trimTrailingSlashes(baseUrl)}/`);
    if (resolved.protocol === "http:") resolved.protocol = "ws:";
    else if (resolved.protocol === "https:") resolved.protocol = "wss:";
    return resolved.href;
}

function parse(data: unknown): CloudEvent | undefined {
    if (typeof data !== "string") return undefined;
    try {
        const value = JSON.parse(data) as { type?: unknown };
        return typeof value?.type === "string" ? (value as CloudEvent) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The events WebSocket while signed in. Reconnects with jittered exponential backoff (reset once a
 * message arrived), treats a connection silent for 2.5 heartbeats as dead, reconnects at once when
 * the browser comes back online, and stops for good on `session.revoked` (the account re-checks
 * its session; a new sign-in starts it again). Every (re)connect is announced (`onConnected`) so
 * the sync refetches the heads it shows.
 */
export class EventsChannel {
    private socket?: SocketLike;
    private running = false;
    private attempt = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private watchdog?: ReturnType<typeof setTimeout>;
    private revoked = false;
    private readonly eventListeners = new Set<(event: CloudEvent) => void>();
    private readonly connectedListeners = new Set<() => void>();
    private readonly url: string;
    private readonly createSocket: SocketFactory;
    private readonly heartbeatMs: number;
    private readonly initialDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly random: () => number;

    constructor(readonly options: EventsChannelOptions) {
        this.url = eventsSocketUrl(options.url, options.baseUrl);
        this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
        this.heartbeatMs = options.heartbeatMs ?? 30_000;
        this.initialDelayMs = options.initialDelayMs ?? 1000;
        this.maxDelayMs = options.maxDelayMs ?? 30_000;
        this.random = options.random ?? Math.random;
    }

    /** Whether a connection is open. */
    get connected(): boolean {
        return this.open;
    }

    private open = false;

    onEvent(listener: (event: CloudEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /** After every (re)connect: refetch, events missed meanwhile are not replayed. */
    onConnected(listener: () => void): () => void {
        this.connectedListeners.add(listener);
        return () => this.connectedListeners.delete(listener);
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.revoked = false;
        this.options.account.onPropertyChanged(this.onAccountChanged);
        globalThis.addEventListener?.("online", this.onOnline);
        this.connect();
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        this.options.account.removePropertyChanged(this.onAccountChanged);
        globalThis.removeEventListener?.("online", this.onOnline);
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.disconnect(CLOSE_NORMAL);
    }

    private readonly onAccountChanged = (property: string | number | symbol) => {
        if (property !== "status") return;
        if (this.options.account.isSignedIn) {
            // Signed in again after a revoked session or an expiry.
            this.revoked = false;
            if (!this.socket) this.reconnectNow();
        } else {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
            this.disconnect(CLOSE_NORMAL);
        }
    };

    private readonly onOnline = () => {
        if (!this.socket) this.reconnectNow();
    };

    private reconnectNow() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.attempt = 0;
        this.connect();
    }

    private connect() {
        if (!this.running || this.socket || this.revoked || !this.options.account.isSignedIn) return;
        let socket: SocketLike;
        try {
            socket = this.createSocket(this.url);
        } catch (error) {
            Logger.warn(`[cloud] events: cannot connect: ${error}`);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.open = true;
            this.armWatchdog();
            for (const listener of [...this.connectedListeners]) listener();
        };
        socket.onmessage = ({ data }) => {
            if (this.socket !== socket) return;
            // Any message proves the connection alive, and that it stays up.
            this.attempt = 0;
            this.armWatchdog();
            const event = parse(data);
            if (!event) return;
            if (event.type === "session.revoked") {
                this.revoked = true;
                return;
            }
            for (const listener of [...this.eventListeners]) listener(event);
        };
        socket.onerror = () => {
            // A close follows.
        };
        socket.onclose = ({ code }) => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.open = false;
            clearTimeout(this.watchdog);
            if (!this.running) return;
            if (this.revoked && code === CLOSE_POLICY) {
                // The session ended: the account checks it (an expiry asks to sign in again).
                void this.options.account.refresh();
                return;
            }
            this.scheduleReconnect();
        };
    }

    private disconnect(code: number) {
        const socket = this.socket;
        this.socket = undefined;
        this.open = false;
        clearTimeout(this.watchdog);
        if (!socket) return;
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try {
            socket.close(code);
        } catch {
            // Already closed.
        }
    }

    /** A connection that received nothing for 2.5 heartbeats is dead (the network went away). */
    private armWatchdog() {
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
            Logger.info("[cloud] events: no heartbeat, reconnecting");
            this.disconnect(CLOSE_NORMAL);
            this.scheduleReconnect();
        }, this.heartbeatMs * 2.5);
    }

    private scheduleReconnect() {
        if (!this.running || this.reconnectTimer) return;
        const cap = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** this.attempt);
        this.attempt++;
        const delay = cap / 2 + (this.random() * cap) / 2;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }
}
