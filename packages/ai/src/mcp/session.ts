// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Logger, redactSecrets } from "@spicy3d/core";
import { createMcpServer, type McpServerOptions } from "./server";
import type { McpStatus } from "./state";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

export interface McpSessionOptions extends Pick<McpServerOptions, "onToolCall"> {
    /** More options for every server this session creates. */
    serverOptions?: Omit<McpServerOptions, "onToolCall">;
    onStatus?: (status: McpStatus) => void;
    /** The transport of each connection attempt (remoteSession.ts: the relay's page socket). */
    createTransport: (url: URL) => Transport;
    /** Test seam; defaults to `createMcpServer`. */
    createServer?: (options: McpServerOptions) => Server;
    /** Called once a connection is up, with the transport it runs on. */
    onConnected?: (transport: Transport) => void;
    /** Asked when a connection ends: false stops reconnecting (e.g. the relay said "signed out"). */
    canRetry?: (transport: Transport) => boolean | Promise<boolean>;
    /** Retry delays in milliseconds: attempt 0, 1, … (default: 1 s doubling, capped at 10 s). */
    retryDelay?: (attempt: number) => number;
}

/**
 * Keeps this tab connected to the server's relay (remoteSession.ts): one MCP server per WebSocket
 * connection, and a reconnect with capped backoff whenever the relay is not reachable yet or drops
 * the connection (a server restart, a network change).
 */
export class McpSession {
    private closed = false;
    private attempt = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private server?: Server;
    private transport?: Transport;
    private _status: McpStatus = "connecting";

    constructor(
        readonly url: URL,
        private readonly options: McpSessionOptions,
    ) {}

    get status(): McpStatus {
        return this._status;
    }

    start(): this {
        void this.connect();
        return this;
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.timer);
        const server = this.server;
        this.server = undefined;
        this.transport = undefined;
        void server?.close();
    }

    /** Whether the session gave up (closed, or `canRetry` said no). */
    get stopped(): boolean {
        return this.closed;
    }

    private setStatus(status: McpStatus) {
        if (this._status === status) return;
        this._status = status;
        this.options.onStatus?.(status);
    }

    private async connect(): Promise<void> {
        if (this.closed) return;
        this.timer = undefined;
        const server = (this.options.createServer ?? createMcpServer)({
            onToolCall: this.options.onToolCall,
            ...this.options.serverOptions,
        });
        const transport = this.options.createTransport(this.url);
        this.server = server;
        this.transport = transport;
        // A failed connect fires both onclose and the rejection below; both land in retry(),
        // which ignores a server that is no longer the current one.
        server.onclose = () => this.retry(server);
        try {
            await server.connect(transport);
        } catch (err) {
            Logger.debug(
                `[mcp] relay not reachable at ${this.url.host}: ${redactSecrets(String((err as Error)?.message ?? err))}`,
            );
            this.retry(server);
            return;
        }
        if (this.server !== server) return;
        this.attempt = 0;
        this.setStatus("connected");
        Logger.info(`[mcp] connected to ${this.url.host}`);
        this.options.onConnected?.(transport);
    }

    private retry(server: Server) {
        if (this.closed || this.server !== server) return;
        const transport = this.transport;
        this.server = undefined;
        this.transport = undefined;
        this.setStatus("offline");
        const verdict = transport && this.options.canRetry ? this.options.canRetry(transport) : true;
        if (verdict === true) this.schedule();
        else if (verdict === false) this.closed = true;
        else {
            void verdict
                .catch(() => false)
                .then((retry) => {
                    if (this.closed || this.server !== undefined || this.timer !== undefined) return;
                    if (retry) this.schedule();
                    else this.closed = true;
                });
        }
    }

    private schedule() {
        const delay =
            this.options.retryDelay?.(this.attempt) ??
            Math.min(MIN_RETRY_MS * 2 ** this.attempt, MAX_RETRY_MS);
        this.attempt++;
        this.timer = setTimeout(() => void this.connect(), delay);
    }
}
