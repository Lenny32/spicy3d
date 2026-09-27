// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Logger } from "@spicy3d/core";
import { setImageByteBudget } from "../tools/imageEncoding";
import {
    CLOSE_POLICY_VIOLATION,
    PageSocketTransport,
    RelayTransport,
    type TabInfo,
    UNNAMED_CLIENT,
} from "./pageTransport";
import { PairingGate } from "./pairing";
import type { RemoteAgent, RemoteMcpLink, RemoteMcpState } from "./remoteState";
import type { McpServerOptions } from "./server";
import { McpSession } from "./session";
import { currentTabInfo, watchTabInfo } from "./tabInfo";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
/** Room for the JSON-RPC envelope and the text part around a screenshot's base64. */
const ENVELOPE_BYTES = 64 * 1024;

/** Capped exponential backoff with ±25 % jitter, so a server restart is not met by every tab at once. */
export function relayRetryDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(MIN_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
    return Math.round(base * (0.75 + random() * 0.5));
}

export interface RemoteMcpSessionOptions {
    state: RemoteMcpState;
    gate?: PairingGate;
    /** Test seams. */
    createSocket?: (url: URL) => WebSocket;
    createServer?: (options: McpServerOptions) => Server;
    watchTab?: (onChange: (info: TabInfo) => void) => () => void;
    tabInfo?: (deviceName: string) => TabInfo;
}

/**
 * This tab as an MCP server behind the server's relay (SRV-09): connects to `/ws/mcp-page` with the
 * session cookie, registers the tab (document, device, focus) and keeps it up to date, shows which
 * sessions target it, and reconnects with backoff — except after a 1008 close (signed out or
 * session revoked), which waits for the next sign-in instead.
 */
export class RemoteMcpSession {
    readonly gate: PairingGate;
    private readonly session: McpSession;
    private relay?: RelayTransport;
    private unwatch?: () => void;
    /** Client info from the requests' `_meta`, for sessions the relay listed before their initialize. */
    private readonly seen = new Map<string, RemoteAgent>();

    constructor(
        readonly link: RemoteMcpLink,
        private readonly options: RemoteMcpSessionOptions,
    ) {
        this.gate = options.gate ?? new PairingGate();
        this.gate.onDecided = () => this.onAgents(this.options.state.current.agents);
        const state = options.state;
        this.session = new McpSession(new URL(link.pageSocket), {
            onStatus: (status) => state.update({ status }),
            onToolCall: (name, isError) => state.recordCall(name, isError),
            createServer: options.createServer,
            createTransport: (url) =>
                new RelayTransport(new PageSocketTransport(url, options.createSocket), {
                    gate: this.gate,
                    onWelcome: ({ tabId, maxMessageBytes }) => {
                        state.update({ tabId });
                        if (maxMessageBytes) setImageByteBudget(maxMessageBytes - ENVELOPE_BYTES);
                    },
                    onAgents: (agents) => this.onAgents(agents),
                    onAgentSeen: (agent) => this.onAgentSeen(agent),
                }),
            onConnected: (transport) => this.onConnected(transport as RelayTransport),
            canRetry: (transport) => this.canRetry(transport as RelayTransport),
            retryDelay: (attempt) => relayRetryDelay(attempt),
        });
    }

    start(): this {
        this.options.state.update({ status: "connecting", agents: [], tabId: undefined });
        this.session.start();
        return this;
    }

    /** Closed, or given up after the relay said the session ended (1008). */
    get stopped(): boolean {
        return this.session.stopped;
    }

    close(): void {
        this.unwatch?.();
        this.unwatch = undefined;
        this.relay = undefined;
        this.session.close();
        setImageByteBudget(undefined);
    }

    /** "Disconnect agent": the relay ends that session; asking again if it comes back is right. */
    disconnectAgent(agentId: string): void {
        this.gate.forget(agentId);
        const agents = this.options.state.current.agents.filter((a) => a.id !== agentId);
        this.options.state.update({ agents });
        void this.relay
            ?.disconnectAgent(agentId)
            .catch((err) => Logger.warn(`[mcp] disconnect failed: ${err}`));
    }

    private onConnected(relay: RelayTransport) {
        this.relay = relay;
        this.send((this.options.tabInfo ?? currentTabInfo)(this.link.deviceName()));
        this.unwatch ??= (this.options.watchTab ?? watchTabInfo)((info) => this.send(info));
    }

    private send(info: TabInfo) {
        void this.relay?.sendTab(info).catch((err) => Logger.debug(`[mcp] tab update not sent: ${err}`));
    }

    private onAgents(agents: RemoteAgent[]) {
        const ids = new Set(agents.map((a) => a.id));
        // A session that moved away (or ended) should not leave its prompt open here.
        for (const previous of this.options.state.current.agents) {
            if (!ids.has(previous.id) && this.gate.decisionOf(previous.id) === undefined) {
                this.gate.forget(previous.id);
            }
        }
        this.options.state.update({
            agents: agents.map((agent) => {
                const named =
                    agent.clientName === UNNAMED_CLIENT ? (this.seen.get(agent.id) ?? agent) : agent;
                return { ...named, pairing: this.gate.decisionOf(agent.id) };
            }),
        });
    }

    private onAgentSeen(agent: RemoteAgent) {
        if (agent.clientName === UNNAMED_CLIENT || this.seen.get(agent.id)?.clientName === agent.clientName)
            return;
        this.seen.set(agent.id, agent);
        const listed = this.options.state.current.agents;
        if (listed.some((a) => a.id === agent.id && a.clientName === UNNAMED_CLIENT)) this.onAgents(listed);
    }

    private canRetry(relay: RelayTransport): boolean {
        if (this.relay === relay) this.relay = undefined;
        this.options.state.update({ agents: [] });
        const code = (relay.inner as PageSocketTransport).closeCode;
        if (code === CLOSE_POLICY_VIOLATION) {
            Logger.info("[mcp] the relay closed this tab's connection (signed out or session ended)");
            this.unwatch?.();
            this.unwatch = undefined;
            return false;
        }
        return true;
    }
}
