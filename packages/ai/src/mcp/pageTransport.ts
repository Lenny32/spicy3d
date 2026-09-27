// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The tab's side of SpicySrv's `/ws/mcp-page` (SRV-09, README "Page socket protocol"): one JSON-RPC
// message per text frame, the tab being the MCP server, plus `notifications/spicy3d/*` for the
// relay itself. Two layers: `PageSocketTransport` is the bare WebSocket, `RelayTransport` sits
// between it and the SDK server and handles the relay's notifications and the pairing prompt.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "@spicy3d/core";
import type { PairingGate } from "./pairing";
import type { RemoteAgent } from "./remoteState";

export const RELAY = {
    welcome: "notifications/spicy3d/welcome",
    agents: "notifications/spicy3d/agents",
    tab: "notifications/spicy3d/tab",
    disconnectAgent: "notifications/spicy3d/disconnect_agent",
    agentMetaKey: "spicy3d/agent",
} as const;

/** Close codes of the page socket that mean "don't reconnect": signed out / session revoked (1008). */
export const CLOSE_POLICY_VIOLATION = 1008;

const SOCKET_OPEN = 1; // WebSocket.OPEN

/** JSON-RPC error of a request the user refused in the pairing prompt. */
export const PAIRING_DENIED = -32005;

/** The handshake: answered even for a request that names no session. */
const HANDSHAKE = new Set(["initialize", "ping"]);

/** Requests that neither act on the tab nor read the document: they never wait for the prompt. */
const NO_PAIRING_NEEDED = new Set([
    ...HANDSHAKE,
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "prompts/list",
    "logging/setLevel",
]);

/** The tab's registration (`notifications/spicy3d/tab`); absent fields stay unchanged on the relay. */
export interface TabInfo {
    documentId?: string;
    documentName?: string;
    deviceName?: string;
    focused?: boolean;
}

type Message = JSONRPCMessage & { id?: string | number; method?: string; params?: Record<string, unknown> };

/**
 * A plain WebSocket to the relay. Unlike the SDK's WebSocketClientTransport it asks for no `mcp`
 * subprotocol (the relay accepts none, and a browser drops a handshake answered without the one it
 * asked for), and it keeps the close code, which tells a sign-out (1008) from a network blip.
 */
export class PageSocketTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T) => void;
    /** The close frame's code once closed; 1006 when the connection just broke. */
    closeCode?: number;

    private socket?: WebSocket;

    constructor(
        readonly url: URL,
        private readonly createSocket: (url: URL) => WebSocket = (u) => new WebSocket(u),
    ) {}

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = this.createSocket(this.url);
            this.socket = socket;
            let opened = false;
            socket.onopen = () => {
                opened = true;
                resolve();
            };
            socket.onerror = () => {
                const error = new Error(`page socket error (${this.url.host})`);
                if (!opened) reject(error);
                this.onerror?.(error);
            };
            socket.onclose = (event) => {
                this.closeCode = event.code;
                this.socket = undefined;
                if (!opened) reject(new Error(`page socket closed before opening (${event.code})`));
                this.onclose?.();
            };
            socket.onmessage = (event) => {
                if (typeof event.data !== "string") return;
                let message: JSONRPCMessage;
                try {
                    message = JSON.parse(event.data);
                } catch {
                    this.onerror?.(new Error("the relay sent invalid JSON"));
                    return;
                }
                this.onmessage?.(message);
            };
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.socket?.readyState !== SOCKET_OPEN) throw new Error("page socket not open");
        this.socket.send(JSON.stringify(message));
    }

    async close(): Promise<void> {
        this.socket?.close(1000);
    }
}

export interface RelayTransportOptions {
    gate: PairingGate;
    onWelcome?: (welcome: { tabId?: string; maxMessageBytes?: number }) => void;
    onAgents?: (agents: RemoteAgent[]) => void;
    /** A request named its session (`_meta`), with the client info the agent list may still lack. */
    onAgentSeen?: (agent: RemoteAgent) => void;
}

/** The name shown for a session whose client did not say who it is (yet). */
export const UNNAMED_CLIENT = "MCP client";

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseAgent(value: unknown): RemoteAgent | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as {
        id?: unknown;
        clientInfo?: { name?: unknown; version?: unknown };
        tokenName?: unknown;
    };
    const id = text(raw.id);
    if (!id) return undefined;
    return {
        id,
        clientName: text(raw.clientInfo?.name) ?? UNNAMED_CLIENT,
        clientVersion: text(raw.clientInfo?.version),
        tokenName: text(raw.tokenName),
    };
}

/**
 * Between the page socket and the SDK server: takes the relay's own notifications out of the
 * stream, sends the tab's registration, and holds back each request of a new MCP session until
 * the user answered the pairing prompt (requests of that session keep their order; a denial
 * answers them with an error, and they never reach the tools).
 */
export class RelayTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T) => void;

    /** Per session: the tail of its requests waiting for the prompt, so they stay in order. */
    private readonly waiting = new Map<string, Promise<void>>();
    /** Ids of the requests held back by the prompt, and those of them the client cancelled meanwhile. */
    private readonly held = new Set<string>();
    private readonly cancelled = new Set<string>();
    /**
     * Set once the socket is gone: a request still held by the prompt is then dropped, never run
     * (the relay already failed it, and a client retry arrives on the next connection).
     */
    private closed = false;

    constructor(
        readonly inner: Transport,
        private readonly options: RelayTransportOptions,
    ) {
        inner.onclose = () => {
            this.markClosed();
            this.onclose?.();
        };
        inner.onerror = (error) => this.onerror?.(error);
        inner.onmessage = (message) => this.receive(message as Message);
    }

    start(): Promise<void> {
        return this.inner.start();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return this.inner.send(message);
    }

    close(): Promise<void> {
        this.markClosed();
        return this.inner.close();
    }

    get isClosed(): boolean {
        return this.closed;
    }

    private markClosed() {
        this.closed = true;
        this.held.clear();
        this.cancelled.clear();
        this.waiting.clear();
    }

    /** Registers or updates this tab: document, device, focus. */
    sendTab(info: TabInfo): Promise<void> {
        return this.inner.send({ jsonrpc: "2.0", method: RELAY.tab, params: { ...info } });
    }

    /** "Disconnect agent": the relay ends that MCP session. */
    disconnectAgent(agentId: string): Promise<void> {
        return this.inner.send({ jsonrpc: "2.0", method: RELAY.disconnectAgent, params: { agentId } });
    }

    private receive(message: Message) {
        const { method } = message;
        if (method === RELAY.welcome) {
            const params = message.params ?? {};
            this.options.onWelcome?.({
                tabId: text(params["tabId"]),
                maxMessageBytes:
                    typeof params["maxMessageBytes"] === "number" ? params["maxMessageBytes"] : undefined,
            });
            return;
        }
        if (method === RELAY.agents) {
            const list = Array.isArray(message.params?.["agents"])
                ? (message.params["agents"] as unknown[])
                : [];
            this.options.onAgents?.(list.flatMap((a) => parseAgent(a) ?? []));
            return;
        }
        if (method?.startsWith("notifications/spicy3d/")) return; // unknown relay notifications are ignored
        if (method === "notifications/cancelled") {
            const requestId = message.params?.["requestId"];
            if (requestId !== undefined && this.held.has(String(requestId)))
                this.cancelled.add(String(requestId));
        }
        const isRequest = method !== undefined && message.id !== undefined;
        if (!isRequest) {
            this.deliver(message); // notifications, and answers to the tab's own requests
            return;
        }
        const agent = this.agentOf(message);
        if (agent) this.options.onAgentSeen?.(agent);
        if (HANDSHAKE.has(method) || (agent && NO_PAIRING_NEEDED.has(method))) {
            this.deliver(message);
            return;
        }
        // Fail closed: a request that names no session could never be paired.
        if (!agent) {
            this.refuse(message, 'The request names no MCP session (_meta["spicy3d/agent"]); refused.');
            return;
        }
        this.whenPaired(agent, message);
    }

    private agentOf(message: Message): RemoteAgent | undefined {
        const meta = message.params?.["_meta"] as Record<string, unknown> | undefined;
        return parseAgent(meta?.[RELAY.agentMetaKey]);
    }

    private whenPaired(agent: RemoteAgent, request: Message) {
        if (this.closed) return;
        const known = this.options.gate.decisionOf(agent.id);
        if (known && !this.waiting.has(agent.id)) {
            this.answerDecision(known, request);
            return;
        }
        this.held.add(String(request.id));
        const previous = this.waiting.get(agent.id) ?? Promise.resolve();
        const next = previous
            .then(() => this.options.gate.decide(agent))
            .then((decision) => this.answerDecision(decision, request));
        this.waiting.set(agent.id, next);
        void next.finally(() => {
            if (this.waiting.get(agent.id) === next) this.waiting.delete(agent.id);
        });
    }

    private answerDecision(decision: "allow" | "deny", request: Message) {
        // The socket it came on is gone: the relay has failed it already.
        if (this.closed) return;
        const id = String(request.id);
        this.held.delete(id);
        if (this.cancelled.delete(id)) return;
        if (decision === "allow") {
            this.deliver(request);
            return;
        }
        this.refuse(
            request,
            "Denied by the user: this MCP session may not control the Spicy3D tab. Ask the user to reconnect the client and press Allow in the tab.",
        );
    }

    private refuse(request: Message, message: string) {
        this.inner
            .send({
                jsonrpc: "2.0",
                id: request.id as string | number,
                error: { code: PAIRING_DENIED, message },
            })
            .catch((err) => Logger.debug(`[mcp] could not answer a refused request: ${err}`));
    }

    /** To the SDK server; a cancellation of a held-back request goes too (unknown ids are ignored). */
    private deliver(message: Message) {
        if (this.closed) return;
        this.onmessage?.(message);
    }
}
