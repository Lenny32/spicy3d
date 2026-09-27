// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Logger } from "@spicy3d/core";
import { forgetCloudCaller } from "../tools/cloudTools";
import { imageBudgetFor } from "../tools/imageEncoding";
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
 * sessions target it, and reconnects with backoff. A 1008 close (signed out, session revoked, or
 * "not reading") first re-checks the web session: still signed in → reconnect, else stop (the next
 * sign-in starts a new session).
 */
export class RemoteMcpSession {
    readonly gate: PairingGate;
    private readonly session: McpSession;
    private relay?: RelayTransport;
    private unwatch?: () => void;
    /** Client info from the requests' `_meta`, for sessions the relay listed before their initialize. */
    private readonly seen = new Map<string, RemoteAgent>();
    /** Image budget of this relay's calls, from its `maxMessageBytes`. */
    private imageBudget?: number;
    /** Consecutive 1008 closes: their reconnects back off even though each connect succeeds. */
    private policyCloses = 0;

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
            serverOptions: { connection: "relay", imageByteBudget: () => this.imageBudget },
            createTransport: (url) =>
                new RelayTransport(new PageSocketTransport(url, options.createSocket), {
                    gate: this.gate,
                    onWelcome: ({ tabId, maxMessageBytes }) => {
                        state.update({ tabId });
                        if (maxMessageBytes) this.imageBudget = imageBudgetFor(maxMessageBytes);
                    },
                    onAgents: (agents) => this.onAgents(agents),
                    onAgentSeen: (agent) => this.onAgentSeen(agent),
                }),
            onConnected: (transport) => this.onConnected(transport as RelayTransport),
            canRetry: (transport) => this.canRetry(transport as RelayTransport),
            retryDelay: (attempt) => relayRetryDelay(Math.max(attempt, this.policyCloses)),
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
        // Open prompts belong to requests that can no longer be answered.
        this.gate.abortPending();
    }

    /** "Disconnect agent": the relay ends that session; asking again if it comes back is right. */
    disconnectAgent(agentId: string): void {
        this.gate.forget(agentId);
        forgetCloudCaller(agentId);
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
            // An ended session's open-document question has nobody left to answer to.
            if (!ids.has(previous.id)) forgetCloudCaller(previous.id);
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

    private canRetry(relay: RelayTransport): boolean | Promise<boolean> {
        if (this.relay === relay) this.relay = undefined;
        this.options.state.update({ agents: [] });
        // The relay failed every request of that socket: their prompts must not run them later.
        this.gate.abortPending();
        const code = (relay.inner as PageSocketTransport).closeCode;
        if (code !== CLOSE_POLICY_VIOLATION) {
            this.policyCloses = 0;
            return true;
        }
        this.policyCloses++;
        Logger.info("[mcp] the relay closed this tab's connection (1008); checking the session");
        return this.link.checkSession().then((signedIn) => {
            if (!signedIn) {
                Logger.info("[mcp] signed out: leaving the relay");
                this.unwatch?.();
                this.unwatch = undefined;
            }
            return signedIn;
        });
    }
}
