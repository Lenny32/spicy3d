// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The bridge's protocol logic, free of any I/O so it can be tested without sockets or stdio.
 *
 * The MCP server itself runs in the browser tab (packages/ai/src/mcp). This side only relays
 * JSON-RPC between the MCP client (stdio) and the tab (WebSocket), plus three things a plain pipe
 * cannot do:
 * - answer the client while no tab is connected, so the client does not fail at startup and the
 *   model can hand the user the pairing link (the `spicy3d_connect` tool);
 * - replay the client's `initialize` handshake to a tab that connects (or reconnects) later;
 * - fail requests that were in flight when the tab went away, instead of leaving them hanging.
 *
 * @typedef {{ jsonrpc: string, id?: string | number | null, method?: string, params?: any, result?: any, error?: any }} Message
 * @typedef {{ send(message: Message): void, close(code?: number, reason?: string): void }} TabPeer
 */

export const CONNECT_TOOL = "spicy3d_connect";
export const REPLAY_ID_PREFIX = "spicy3d-bridge-init-";

/** JSON-RPC server error the bridge uses for "no tab to answer this". */
export const TAB_UNAVAILABLE = -32000;

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/** @param {Message} m */
const isRequest = (m) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
/** @param {Message} m */
const isNotification = (m) => typeof m.method === "string" && (m.id === undefined || m.id === null);
/** @param {string | number | null | undefined} id */
const idKey = (id) => JSON.stringify(id);

/**
 * The link that opens Spicy3D paired with this bridge.
 * @param {string} appUrl
 * @param {number} port
 * @param {string} token
 */
export function pairingUrl(appUrl, port, token) {
    const url = new URL(appUrl);
    url.searchParams.set("mcp", `ws://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`);
    return url.toString();
}

export class BridgeCore {
    /**
     * @param {{ sendToClient(message: Message): void, pairingUrl: string, version?: string, log?(text: string): void }} options
     */
    constructor(options) {
        this.options = options;
        /** @type {Message | undefined} the client's initialize request, replayed to every new tab */
        this.clientInit = undefined;
        this.clientInitialized = false;
        /** @type {TabPeer | undefined} */
        this.tab = undefined;
        this.tabInitialized = false;
        /** @type {string | undefined} */
        this.replayId = undefined;
        this.replaySeq = 0;
        /** @type {Map<string, string | number>} client requests the current tab still owes an answer */
        this.pendingFromClient = new Map();
        /** @type {Set<string>} tab requests (elicitation) the client still owes an answer */
        this.pendingFromTab = new Set();
    }

    get connected() {
        return this.tab !== undefined;
    }

    /** @param {Message} message */
    handleClientMessage(message) {
        if (isRequest(message)) {
            if (message.method === "initialize") this.clientInit = message;
            if (this.tab) {
                this.pendingFromClient.set(idKey(message.id), /** @type {string | number} */ (message.id));
                this.tab.send(message);
            } else {
                this.options.sendToClient(this.offlineResponse(message));
            }
            return;
        }
        if (isNotification(message)) {
            if (message.method === "notifications/initialized") {
                this.clientInitialized = true;
                // During a replay, it goes out once the tab has answered the replayed initialize.
                if (!this.replayId) this.sendInitializedToTab();
                return;
            }
            this.tab?.send(message);
            return;
        }
        // A response to a request the tab made.
        const key = idKey(message.id);
        if (this.tab && this.pendingFromTab.delete(key)) this.tab.send(message);
    }

    /** @param {TabPeer} tab */
    attachTab(tab) {
        const previous = this.tab;
        if (previous) {
            this.detachTab(previous, "a newer Spicy3D tab connected");
            previous.close(4000, "replaced by a newer tab");
        }
        this.tab = tab;
        this.tabInitialized = false;
        this.options.log?.("tab connected");
        if (!this.clientInit) return; // the client's own initialize will reach the tab directly
        this.replayId = `${REPLAY_ID_PREFIX}${++this.replaySeq}`;
        tab.send({ jsonrpc: "2.0", id: this.replayId, method: "initialize", params: this.clientInit.params });
    }

    /**
     * @param {TabPeer} tab
     * @param {Message} message
     */
    handleTabMessage(tab, message) {
        if (tab !== this.tab) return;
        if (isRequest(message)) {
            this.pendingFromTab.add(idKey(message.id));
            this.options.sendToClient(message);
            return;
        }
        if (isNotification(message)) {
            this.options.sendToClient(message);
            return;
        }
        if (this.replayId !== undefined && message.id === this.replayId) {
            this.replayId = undefined;
            if (message.error) {
                this.options.log?.(`tab refused the replayed initialize: ${JSON.stringify(message.error)}`);
                return;
            }
            if (this.clientInitialized) this.sendInitializedToTab();
            this.notifyListsChanged();
            return;
        }
        const key = idKey(message.id);
        if (!this.pendingFromClient.delete(key)) return;
        this.options.sendToClient(message);
    }

    sendInitializedToTab() {
        if (!this.tab || this.tabInitialized) return;
        this.tabInitialized = true;
        this.tab.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    }

    /**
     * @param {TabPeer} tab
     * @param {string} [reason]
     */
    detachTab(tab, reason = "the Spicy3D tab disconnected") {
        if (tab !== this.tab) return;
        this.tab = undefined;
        this.tabInitialized = false;
        this.replayId = undefined;
        this.pendingFromTab.clear();
        for (const id of this.pendingFromClient.values()) {
            this.options.sendToClient({
                jsonrpc: "2.0",
                id,
                error: {
                    code: TAB_UNAVAILABLE,
                    message: `${reason} before answering. ${this.reconnectHint()}`,
                },
            });
        }
        this.pendingFromClient.clear();
        this.options.log?.(`tab detached: ${reason}`);
        this.notifyListsChanged();
    }

    notifyListsChanged() {
        if (!this.clientInitialized) return;
        this.options.sendToClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        this.options.sendToClient({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    }

    reconnectHint() {
        return `Ask the user to open Spicy3D, open the MCP panel and press Connect (or to open this link in their browser: ${this.options.pairingUrl}).`;
    }

    /**
     * What the client gets while no tab is connected.
     * @param {Message} request
     * @returns {Message}
     */
    offlineResponse(request) {
        const reply = (/** @type {any} */ result) => ({
            jsonrpc: /** @type {const} */ ("2.0"),
            id: request.id,
            result,
        });
        switch (request.method) {
            case "initialize":
                return reply(this.initializeResult(request.params?.protocolVersion));
            case "ping":
                return reply({});
            case "tools/list":
                return reply({ tools: [this.connectTool()] });
            case "resources/list":
                return reply({ resources: [] });
            case "resources/templates/list":
                return reply({ resourceTemplates: [] });
            case "tools/call": {
                const isConnect = request.params?.name === CONNECT_TOOL;
                const text = isConnect
                    ? `No Spicy3D tab is connected yet. ${this.reconnectHint()}\nOnce it loads, the Spicy3D tools appear in the tool list.`
                    : `No Spicy3D tab is connected. ${this.reconnectHint()}`;
                return reply({ content: [{ type: "text", text }], ...(!isConnect && { isError: true }) });
            }
            default:
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: TAB_UNAVAILABLE,
                        message: `No Spicy3D tab is connected. ${this.reconnectHint()}`,
                    },
                };
        }
    }

    /** @param {unknown} requested */
    initializeResult(requested) {
        const protocolVersion =
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : FALLBACK_PROTOCOL_VERSION;
        return {
            protocolVersion,
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
            serverInfo: { name: "spicy3d", version: this.options.version ?? "0.0.0" },
            instructions: `This server drives the user's open Spicy3D tab (a browser CAD). No tab is connected yet: call ${CONNECT_TOOL} to get the link the user must open. Once the tab connects, the modeling tools appear; call get_usage_guide before the first modeling call.`,
        };
    }

    connectTool() {
        return {
            name: CONNECT_TOOL,
            description:
                "Get the link that opens Spicy3D in the user's browser, paired with this server. Call it when the user wants to model in Spicy3D and no Spicy3D tools are listed yet.",
            inputSchema: { type: "object", properties: {} },
        };
    }
}
