// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * `--server` mode: a stdio ⇄ Streamable HTTP proxy to a Spicy3D server's `/mcp` endpoint (SRV-09),
 * for MCP clients that can only start stdio servers. The server relays the calls to the user's
 * signed-in browser tab; this side only speaks HTTP, with the personal access token.
 *
 * Kept free of process I/O (stdio is the caller's) and of dependencies: `fetch` is injectable, so
 * tests run without a network.
 *
 * @typedef {{ jsonrpc: string, id?: string | number | null, method?: string, params?: any, result?: any, error?: any }} Message
 * @typedef {(url: string | URL, init?: RequestInit) => Promise<Response>} FetchLike
 */

export const REINIT_ID_PREFIX = "spicy3d-bridge-reinit-";

/** JSON-RPC error: the server could not be reached or refused the request. */
export const SERVER_UNAVAILABLE = -32000;

const MIN_STREAM_RETRY_MS = 1000;
const MAX_STREAM_RETRY_MS = 30_000;

/** @param {Message} m */
const isRequest = (m) => typeof m.method === "string" && m.id !== undefined && m.id !== null;

/**
 * The `/mcp` endpoint for `--server`: the server's address (its `/mcp` is appended) or the
 * endpoint itself. Throws with a user-facing message.
 * @param {string} server
 */
export function mcpEndpointFor(server) {
    let url;
    try {
        url = new URL(server);
    } catch {
        throw new Error(`--server is not a valid URL: ${server}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`--server must be an http(s) address, got ${server}`);
    }
    url.search = "";
    url.hash = "";
    if (!/\/mcp\/?$/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
    }
    return url.toString();
}

/**
 * Server-sent events from a fetch body: calls `onEvent(data)` for each `message` event.
 * @param {ReadableStream<Uint8Array>} body
 * @param {(data: string) => void} onEvent
 */
export async function readEventStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @type {string[]} */
    let data = [];
    let event = "message";
    const line = (/** @type {string} */ text) => {
        if (text === "") {
            if (data.length > 0 && event === "message") onEvent(data.join("\n"));
            data = [];
            event = "message";
            return;
        }
        if (text.startsWith(":")) return;
        const colon = text.indexOf(":");
        const field = colon < 0 ? text : text.slice(0, colon);
        let value = colon < 0 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value || "message";
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.search(/\r\n|\r|\n/);
        while (newline >= 0) {
            const width = buffer.startsWith("\r\n", newline) ? 2 : 1;
            line(buffer.slice(0, newline));
            buffer = buffer.slice(newline + width);
            newline = buffer.search(/\r\n|\r|\n/);
        }
    }
    if (buffer) line(buffer);
    line("");
}

export class RemoteProxy {
    /**
     * @param {{
     *   endpoint: string,
     *   token: string,
     *   sendToClient(message: Message): void,
     *   log?(text: string): void,
     *   fetch?: FetchLike,
     *   version?: string,
     *   setTimeout?: (fn: () => void, ms: number) => unknown,
     * }} options
     */
    constructor(options) {
        this.options = options;
        this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        /** @type {string | undefined} */
        this.sessionId = undefined;
        /** @type {string | undefined} */
        this.protocolVersion = undefined;
        /** @type {Message | undefined} the client's initialize, replayed when the server lost the session */
        this.clientInit = undefined;
        this.clientInitialized = false;
        /** Resolves once the session exists (the client's initialize answered, or a re-initialize). */
        this.ready = Promise.resolve();
        this.reinitSeq = 0;
        /** @type {AbortController | undefined} the GET stream (server → client notifications) */
        this.stream = undefined;
        this.streamAttempt = 0;
        this.closed = false;
        /** @type {Promise<void> | undefined} */
        this.reinitializing = undefined;
    }

    /** @param {Message} message */
    handleClientMessage(message) {
        if (this.closed) return;
        if (isRequest(message) && message.method === "initialize") {
            this.clientInit = message;
            this.ready = this.initialize(message);
            return;
        }
        if (message.method === "notifications/initialized") this.clientInitialized = true;
        void this.ready.then(() => this.forward(message));
    }

    /** Ends the session on the server (`DELETE`), best effort. */
    async close() {
        this.closed = true;
        this.stream?.abort();
        if (!this.sessionId) return;
        try {
            await this.fetch(this.options.endpoint, { method: "DELETE", headers: this.headers() });
        } catch {
            // The server drops idle sessions anyway.
        }
    }

    /** @param {Record<string, string>} [extra] */
    headers(extra = {}) {
        /** @type {Record<string, string>} */
        const headers = {
            Authorization: `Bearer ${this.options.token}`,
            Accept: "application/json, text/event-stream",
            "User-Agent": `spicy3d-mcp-bridge/${this.options.version ?? "0.0.0"}`,
            ...extra,
        };
        if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
        if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
        return headers;
    }

    /**
     * The client's initialize: opens the session and learns its id and protocol version.
     * @param {Message} message
     */
    async initialize(message) {
        this.sessionId = undefined;
        this.protocolVersion = undefined;
        await this.post(message, { onMessage: (m) => this.onInitializeAnswer(m, message.id, true) });
    }

    /**
     * @param {Message} answer
     * @param {Message["id"]} id
     * @param {boolean} toClient
     */
    onInitializeAnswer(answer, id, toClient) {
        if (answer.id === id && answer.result?.protocolVersion) {
            this.protocolVersion = answer.result.protocolVersion;
        }
        if (toClient || answer.id !== id) this.options.sendToClient(answer);
    }

    /**
     * The server lost the session (restart, idle expiry): replay the client's initialize, silently.
     * Concurrent callers share one replay.
     */
    reinitialize() {
        this.reinitializing ??= (async () => {
            const init = this.clientInit;
            if (!init) return;
            this.options.log?.("session expired on the server; starting a new one");
            this.stream?.abort();
            this.stream = undefined;
            this.sessionId = undefined;
            this.protocolVersion = undefined;
            const id = `${REINIT_ID_PREFIX}${++this.reinitSeq}`;
            await this.post({ ...init, id }, { onMessage: (m) => this.onInitializeAnswer(m, id, false) });
            if (this.sessionId && this.clientInitialized) {
                await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, {});
                this.openStream();
            }
        })().finally(() => {
            this.reinitializing = undefined;
        });
        return this.reinitializing;
    }

    /** @param {Message} message */
    async forward(message) {
        const outcome = await this.post(message, { retryOnExpiry: true });
        if (outcome === "expired") {
            this.ready = this.reinitialize();
            await this.ready;
            await this.post(message, {});
        }
        if (message.method === "notifications/initialized") this.openStream();
    }

    /**
     * POSTs one message; answers arrive as JSON or on an SSE stream. Failures become JSON-RPC
     * errors for requests, so the client never waits forever.
     * @param {Message} message
     * @param {{ onMessage?: (m: Message) => void, retryOnExpiry?: boolean }} how
     * @returns {Promise<"ok" | "expired" | "failed">}
     */
    async post(message, how) {
        const deliver = how.onMessage ?? ((/** @type {Message} */ m) => this.options.sendToClient(m));
        let response;
        try {
            response = await this.fetch(this.options.endpoint, {
                method: "POST",
                headers: this.headers({ "Content-Type": "application/json" }),
                body: JSON.stringify(message),
            });
        } catch (err) {
            this.fail(
                message,
                `cannot reach ${this.options.endpoint}: ${/** @type {Error} */ (err).message}`,
            );
            return "failed";
        }
        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        if (response.status === 404 && this.sessionId && how.retryOnExpiry && this.clientInit) {
            await response.body?.cancel();
            return "expired";
        }
        if (response.status === 202 || response.status === 204) {
            await response.body?.cancel();
            return "ok";
        }
        if (!response.ok) {
            this.fail(message, await this.describeFailure(response));
            return "failed";
        }
        const type = response.headers.get("content-type") ?? "";
        try {
            if (type.includes("text/event-stream") && response.body) {
                await readEventStream(response.body, (data) => this.parseAndDeliver(data, deliver));
            } else {
                const text = await response.text();
                if (text.trim()) this.parseAndDeliver(text, deliver);
            }
        } catch (err) {
            this.fail(message, `the answer from the server broke off: ${/** @type {Error} */ (err).message}`);
            return "failed";
        }
        return "ok";
    }

    /**
     * @param {string} text
     * @param {(m: Message) => void} deliver
     */
    parseAndDeliver(text, deliver) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.options.log?.("dropped a malformed message from the server");
            return;
        }
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) deliver(message);
    }

    /** @param {Response} response */
    async describeFailure(response) {
        let detail = "";
        try {
            const body = await response.text();
            const json = JSON.parse(body);
            detail = json?.error?.message ?? json?.detail ?? json?.title ?? "";
        } catch {
            // No JSON body.
        }
        switch (response.status) {
            case 401:
                return "the server refused the access token (401): it is wrong, expired or revoked. Create a new one in Spicy3D (account settings > Access tokens) and set it as SPICY3D_TOKEN.";
            case 403:
                return `the access token lacks a permission (403)${detail ? `: ${detail}` : ""}. Create a token with "Edit the open model".`;
            case 429:
                return "too many requests or MCP sessions for this account (429); try again shortly.";
            default:
                return `the server answered ${response.status}${detail ? `: ${detail}` : ""}`;
        }
    }

    /**
     * @param {Message} message
     * @param {string} reason
     */
    fail(message, reason) {
        this.options.log?.(reason);
        if (!isRequest(message)) return;
        if (typeof message.id === "string" && message.id.startsWith(REINIT_ID_PREFIX)) return;
        this.options.sendToClient({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: SERVER_UNAVAILABLE, message: `Spicy3D server: ${reason}` },
        });
    }

    /** The GET stream for what the server sends on its own (tools/list_changed when a tab comes or goes). */
    openStream() {
        if (this.closed || this.stream || !this.sessionId) return;
        const controller = new AbortController();
        this.stream = controller;
        const sessionId = this.sessionId;
        void (async () => {
            let retry = true;
            try {
                const response = await this.fetch(this.options.endpoint, {
                    method: "GET",
                    headers: this.headers({ Accept: "text/event-stream" }),
                    signal: controller.signal,
                });
                if (response.status === 405) {
                    retry = false; // this server offers no stream; list changes arrive with answers only
                } else if (response.status === 404) {
                    retry = false;
                    if (this.sessionId === sessionId) this.ready = this.reinitialize();
                } else if (response.ok && response.body) {
                    this.streamAttempt = 0;
                    await readEventStream(response.body, (data) =>
                        this.parseAndDeliver(data, (m) => this.options.sendToClient(m)),
                    );
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    this.options.log?.(`notification stream lost: ${/** @type {Error} */ (err).message}`);
                }
            }
            if (this.stream === controller) this.stream = undefined;
            if (!retry || controller.signal.aborted || this.closed) return;
            const delay = Math.min(MIN_STREAM_RETRY_MS * 2 ** this.streamAttempt++, MAX_STREAM_RETRY_MS);
            (this.options.setTimeout ?? setTimeout)(() => this.openStream(), delay);
        })();
    }
}
