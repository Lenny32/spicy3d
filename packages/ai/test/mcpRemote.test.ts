// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../src/llm/types";
import { PAIRING_DENIED, RELAY, RelayTransport } from "../src/mcp/pageTransport";
import {
    claimTabInstance,
    DENY_COOLDOWN_MS,
    type InstanceChannel,
    type PairingAnswer,
    PairingGate,
} from "../src/mcp/pairing";
import {
    type RemoteAgent,
    RemoteMcpState,
    remoteClaudeCodeCommand,
    remoteClientConfigs,
    remoteJsonConfig,
    remoteStdioConfig,
    serverUrlOf,
} from "../src/mcp/remote";
import { RemoteMcpSession, relayRetryDelay } from "../src/mcp/remoteSession";
import { createMcpServer, SerialQueue } from "../src/mcp/server";
import { defaultSettings } from "../src/mcp/settings";

type Message = JSONRPCMessage & {
    id?: string | number;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
};

const ENDPOINT = "https://spicy.lan/mcp";
const AGENT = { id: "a1", clientInfo: { name: "claude-code", version: "2.1" }, tokenName: "Laptop" };
const AGENT_2 = { id: "a2", clientInfo: { name: "cursor" }, tokenName: "Desk" };

function memoryStorage() {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
    };
}

/** A pairing gate whose prompt the test answers by hand. */
function manualGate(storage = memoryStorage(), instance = "tab-1", clock = { now: 0 }) {
    const asked: RemoteAgent[] = [];
    const answers: ((answer: PairingAnswer) => void)[] = [];
    const gate = new PairingGate({
        ask: (agent, signal) => {
            asked.push(agent);
            return new Promise((resolve) => {
                answers.push(resolve);
                signal.addEventListener("abort", () => resolve("deny"));
            });
        },
        storage,
        instance: Promise.resolve(instance),
        now: () => clock.now,
    });
    return {
        gate,
        asked,
        /** Answers prompt `index` once it is shown. */
        answer: async (answer: PairingAnswer, index = 0) => {
            for (let i = 0; i < 50 && !answers[index]; i++) await new Promise((r) => setTimeout(r, 0));
            answers[index](answer);
        },
        storage,
        clock,
    };
}

/** BroadcastChannels of several tabs in one test: every message reaches the other ends. */
function channelHub() {
    const ends: { listeners: Set<(event: { data: unknown }) => void> }[] = [];
    return (): InstanceChannel => {
        const end = { listeners: new Set<(event: { data: unknown }) => void>() };
        ends.push(end);
        return {
            postMessage: (data) => {
                for (const other of ends) {
                    if (other !== end)
                        for (const l of [...other.listeners]) queueMicrotask(() => l({ data }));
                }
            },
            addEventListener: (_type, listener) => end.listeners.add(listener),
            removeEventListener: (_type, listener) => end.listeners.delete(listener),
        };
    };
}

function fakeInner() {
    const sent: Message[] = [];
    const inner: Transport = {
        start: async () => {},
        send: async (message) => {
            sent.push(message as Message);
        },
        close: async () => inner.onclose?.(),
    };
    return { inner, sent, receive: (message: Message) => inner.onmessage?.(message) };
}

function call(id: string, name: string, agent: object | null = AGENT): Message {
    return {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {}, ...(agent && { _meta: { [RELAY.agentMetaKey]: agent } }) },
    };
}

async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("remote client configs", () => {
    test("Claude Code gets the token from SPICY3D_TOKEN, never on the command line", () => {
        expect(remoteClaudeCodeCommand(ENDPOINT, false)).toBe(
            'claude mcp add --transport http spicy3d https://spicy.lan/mcp --header "Authorization: Bearer $SPICY3D_TOKEN"',
        );
        expect(remoteClaudeCodeCommand(ENDPOINT, true)).toContain(
            '"Authorization: Bearer $env:SPICY3D_TOKEN"',
        );
        const [claude] = remoteClientConfigs(
            ENDPOINT,
            "spicy_pat_x",
            defaultSettings(),
            "https://spicy.lan/",
        );
        expect(claude.text).not.toContain("spicy_pat_x");
    });

    test("the HTTP JSON config carries the URL and the header", () => {
        expect(JSON.parse(remoteJsonConfig(ENDPOINT, "tok")).mcpServers.spicy3d).toEqual({
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: "Bearer tok" },
        });
    });

    test("the stdio fallback runs the bridge in server mode with the token in its environment", () => {
        const settings = {
            ...defaultSettings(),
            runner: "executable" as const,
            executablePath: "/opt/bridge",
        };
        const server = JSON.parse(remoteStdioConfig(ENDPOINT, settings, "https://spicy.lan/", "tok"))
            .mcpServers.spicy3d;
        expect(server).toEqual({
            command: "/opt/bridge",
            args: ["--server", "https://spicy.lan"],
            env: { SPICY3D_TOKEN: "tok" },
        });
    });

    test("the file configs default to a <token> placeholder", () => {
        const configs = remoteClientConfigs(ENDPOINT, undefined, defaultSettings(), "https://spicy.lan/");
        expect(configs.map((c) => c.kind)).toEqual(["claudeCode", "http", "stdio"]);
        expect(configs[1].text).toContain("<token>");
        expect(configs[2].text).toContain("<token>");
    });

    test.each([
        ["https://spicy.lan/mcp", "https://spicy.lan"],
        ["https://host/app/mcp/", "https://host/app"],
    ])("serverUrlOf(%s) = %s", (endpoint, server) => {
        expect(serverUrlOf(endpoint)).toBe(server);
    });
});

describe("PairingGate", () => {
    test("asks once per session; concurrent requests share the question", async () => {
        const { gate, asked, answer } = manualGate();
        const agent: RemoteAgent = { id: "a1", clientName: "claude-code" };
        const first = gate.decide(agent);
        const second = gate.decide(agent);
        answer("allow");

        await expect(first).resolves.toBe("allow");
        await expect(second).resolves.toBe("allow");
        await expect(gate.decide(agent)).resolves.toBe("allow");
        expect(asked).toHaveLength(1);
    });

    test("remembers decisions in the tab's session storage, so a reload does not ask again", async () => {
        const storage = memoryStorage();
        const { gate, answer } = manualGate(storage);
        const decided = gate.decide({ id: "a1", clientName: "c" });
        answer("deny");
        await decided;

        const reloaded = manualGate(storage);
        await expect(reloaded.gate.decide({ id: "a1", clientName: "c" })).resolves.toBe("deny");
        expect(reloaded.asked).toHaveLength(0);
    });

    test("one prompt at a time: the next session is asked once the first is answered", async () => {
        const { gate, asked, answer } = manualGate();
        const first = gate.decide({ id: "a1", clientName: "c", tokenName: "Laptop" });
        const second = gate.decide({ id: "a2", clientName: "c", tokenName: "Desk" });
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1"]);

        answer("allow");
        await expect(first).resolves.toBe("allow");
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1", "a2"]);
        answer("allow", 1);
        await expect(second).resolves.toBe("allow");
    });

    test("after a Deny the token's new sessions are refused without a prompt until the cooldown ends", async () => {
        const { gate, asked, answer, clock } = manualGate();
        const denied = gate.decide({ id: "a1", clientName: "c", tokenName: "Laptop" });
        answer("deny");
        await expect(denied).resolves.toBe("deny");

        await expect(gate.decide({ id: "a2", clientName: "c", tokenName: "Laptop" })).resolves.toBe("deny");
        expect(asked).toHaveLength(1);
        // Not remembered: once the cooldown is over, that session may ask.
        expect(gate.decisionOf("a2")).toBeUndefined();

        clock.now += DENY_COOLDOWN_MS + 1;
        const later = gate.decide({ id: "a2", clientName: "c", tokenName: "Laptop" });
        await settle();
        expect(asked).toHaveLength(2);
        answer("allow", 1);
        await expect(later).resolves.toBe("allow");
    });

    test("Deny all from this token refuses its later sessions for good; other tokens still ask", async () => {
        const { gate, asked, answer, clock, storage } = manualGate();
        const denied = gate.decide({ id: "a1", clientName: "c", tokenName: "Laptop" });
        answer("denyToken");
        await expect(denied).resolves.toBe("deny");

        clock.now += DENY_COOLDOWN_MS * 100;
        await expect(gate.decide({ id: "a2", clientName: "c", tokenName: "Laptop" })).resolves.toBe("deny");
        const other = gate.decide({ id: "a3", clientName: "c", tokenName: "Desk" });
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1", "a3"]);
        answer("allow", 1);
        await expect(other).resolves.toBe("allow");

        // Survives a reload of the same tab.
        const reloaded = manualGate(storage);
        await expect(reloaded.gate.decide({ id: "a4", clientName: "c", tokenName: "Laptop" })).resolves.toBe(
            "deny",
        );
        expect(reloaded.asked).toHaveLength(0);
    });

    test("a duplicated tab (another instance) does not inherit the Allows", async () => {
        const storage = memoryStorage();
        const { gate, answer } = manualGate(storage, "tab-1");
        const decided = gate.decide({ id: "a1", clientName: "c" });
        answer("allow");
        await decided;

        const duplicate = manualGate(storage, "tab-2");
        const asked = duplicate.gate.decide({ id: "a1", clientName: "c" });
        await settle();
        expect(duplicate.asked).toHaveLength(1);
        duplicate.answer("deny");
        await expect(asked).resolves.toBe("deny");
    });

    test("abortPending closes every open and queued prompt without remembering anything", async () => {
        const { gate, asked } = manualGate();
        const first = gate.decide({ id: "a1", clientName: "c", tokenName: "A" });
        const second = gate.decide({ id: "a2", clientName: "c", tokenName: "B" });
        await settle();

        gate.abortPending();

        await expect(first).resolves.toBe("deny");
        await expect(second).resolves.toBe("deny");
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1"]);
        expect(gate.decisionOf("a1")).toBeUndefined();
        expect(gate.decisionOf("a2")).toBeUndefined();
    });

    test("forgetting a session closes its prompt as a denial that is not remembered", async () => {
        const { gate } = manualGate();
        const decided = gate.decide({ id: "a1", clientName: "c" });
        gate.forget("a1");

        await expect(decided).resolves.toBe("deny");
        expect(gate.decisionOf("a1")).toBeUndefined();
    });
});

describe("claimTabInstance", () => {
    test("a reload keeps the instance id; a duplicated tab, whose original still answers, gets a new one", async () => {
        const hub = channelHub();
        const original = memoryStorage();
        const first = await claimTabInstance(original, hub(), 20);

        // Reload: same sessionStorage, nobody else holds the id.
        const reloadHub = channelHub();
        expect(await claimTabInstance(original, reloadHub(), 20)).toBe(first);

        // Duplicate: a copy of sessionStorage while the original tab is still open on the channel.
        const copy = memoryStorage();
        for (const [k, v] of original.data) copy.setItem(k, v);
        const duplicate = await claimTabInstance(copy, hub(), 20);
        expect(duplicate).not.toBe(first);
        expect(copy.data.get("spicy3d.mcp.tabInstance")).toBe(duplicate);
        expect(original.data.get("spicy3d.mcp.tabInstance")).toBe(first);
    });
});

describe("RelayTransport", () => {
    function setup() {
        const { gate, asked, answer } = manualGate();
        const { inner, sent, receive } = fakeInner();
        const welcome: unknown[] = [];
        const agents: RemoteAgent[][] = [];
        const relay = new RelayTransport(inner, {
            gate,
            onWelcome: (w) => welcome.push(w),
            onAgents: (a) => agents.push(a),
        });
        const delivered: Message[] = [];
        relay.onmessage = (m) => delivered.push(m as Message);
        return { relay, sent, receive, delivered, welcome, agents, asked, answer, gate };
    }

    test("takes the relay's own notifications out of the MCP stream", () => {
        const { receive, delivered, welcome, agents } = setup();
        receive({ jsonrpc: "2.0", method: RELAY.welcome, params: { tabId: "t1", maxMessageBytes: 1024 } });
        receive({ jsonrpc: "2.0", method: RELAY.agents, params: { agents: [AGENT, { nope: 1 }] } });
        receive({ jsonrpc: "2.0", method: "notifications/spicy3d/future" });

        expect(delivered).toEqual([]);
        expect(welcome).toEqual([{ tabId: "t1", maxMessageBytes: 1024 }]);
        expect(agents).toEqual([
            [{ id: "a1", clientName: "claude-code", clientVersion: "2.1", tokenName: "Laptop" }],
        ]);
    });

    test("listing and initialize never wait for the prompt", () => {
        const { receive, delivered, asked } = setup();
        receive({
            jsonrpc: "2.0",
            id: "s1",
            method: "initialize",
            params: { _meta: { [RELAY.agentMetaKey]: AGENT } },
        });
        receive({
            jsonrpc: "2.0",
            id: "s2",
            method: "tools/list",
            params: { _meta: { [RELAY.agentMetaKey]: AGENT } },
        });
        receive({ jsonrpc: "2.0", id: "s3", method: "ping" });

        expect(delivered.map((m) => m.id)).toEqual(["s1", "s2", "s3"]);
        expect(asked).toEqual([]);
    });

    test("fails closed: a request naming no session is refused, not run", async () => {
        const { receive, delivered, sent, asked } = setup();
        receive(call("s1", "extrude", null));
        receive({ jsonrpc: "2.0", id: "s2", method: "tools/list" });
        await settle();

        expect(delivered).toEqual([]);
        expect(asked).toEqual([]);
        expect(sent.map((m) => [m.id, m.error?.code])).toEqual([
            ["s1", PAIRING_DENIED],
            ["s2", PAIRING_DENIED],
        ]);
    });

    test("a call held by the prompt is dropped when its socket closes, even if the user then allows", async () => {
        const { relay, receive, delivered, sent, answer } = setup();
        receive(call("s1", "extrude"));
        await settle();

        await relay.close();
        answer("allow");
        await settle();

        expect(relay.isClosed).toBe(true);
        expect(delivered).toEqual([]);
        expect(sent).toEqual([]);
    });

    test("the first call of a session waits for Allow; its later calls keep their order", async () => {
        const { receive, delivered, asked, answer } = setup();
        receive(call("s1", "extrude"));
        receive(call("s2", "fillet"));
        await settle();
        expect(delivered).toEqual([]);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ id: "a1", clientName: "claude-code", tokenName: "Laptop" });

        answer("allow");
        await settle();
        receive(call("s3", "chamfer"));

        expect(delivered.map((m) => m.id)).toEqual(["s1", "s2", "s3"]);
    });

    test("Deny answers every call of that session with an error and never runs a tool", async () => {
        const { receive, delivered, sent, answer } = setup();
        receive(call("s1", "extrude"));
        await settle();
        answer("deny");
        await settle();
        receive(call("s2", "fillet"));
        await settle();

        expect(delivered).toEqual([]);
        expect(sent.map((m) => [m.id, m.error?.code])).toEqual([
            ["s1", PAIRING_DENIED],
            ["s2", PAIRING_DENIED],
        ]);
        expect(sent[0].error.message).toContain("Denied by the user");
    });

    test("each session is asked on its own, one prompt at a time", async () => {
        const { receive, asked, answer, delivered } = setup();
        receive(call("s1", "extrude", AGENT));
        receive(call("s2", "extrude", AGENT_2));
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1"]);

        answer("deny");
        await settle();
        expect(asked.map((a) => a.id)).toEqual(["a1", "a2"]);
        answer("allow", 1);
        await settle();
        expect(delivered.map((m) => m.id)).toEqual(["s2"]);
    });

    test("a held-back call the client cancelled is dropped after Allow", async () => {
        const { receive, delivered, answer } = setup();
        receive(call("s1", "extrude"));
        receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "s1" } });
        await settle();
        answer("allow");
        await settle();

        expect(delivered.map((m) => m.method)).toEqual(["notifications/cancelled"]);
    });

    test("registers the tab and disconnects agents with relay notifications", async () => {
        const { relay, sent } = setup();
        await relay.sendTab({
            documentId: "d1",
            documentName: "Bracket",
            deviceName: "Laptop",
            focused: true,
        });
        await relay.disconnectAgent("a1");

        expect(sent).toEqual([
            {
                jsonrpc: "2.0",
                method: RELAY.tab,
                params: { documentId: "d1", documentName: "Bracket", deviceName: "Laptop", focused: true },
            },
            { jsonrpc: "2.0", method: RELAY.disconnectAgent, params: { agentId: "a1" } },
        ]);
    });
});

/** A WebSocket stand-in the test drives as the relay would. */
class FakeSocket {
    static all: FakeSocket[] = [];
    readyState = 0;
    sent: Message[] = [];
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    onmessage?: (event: { data: unknown }) => void;

    constructor(readonly url: URL) {
        FakeSocket.all.push(this);
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    send(data: string) {
        this.sent.push(JSON.parse(data));
    }

    close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code });
    }

    deliver(message: Message) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

describe("RemoteMcpSession", () => {
    const link = {
        endpoint: ENDPOINT,
        pageSocket: "wss://spicy.lan/ws/mcp-page",
        userName: "Ada",
        deviceName: () => "Laptop",
        createToken: () => {},
        checkSession: rs.fn(async () => true),
    };
    const sessions: RemoteMcpSession[] = [];

    function tool(name: string, handler: Tool["handler"]): Tool {
        return { name, description: name, parameters: { type: "object", properties: {} }, handler };
    }

    function setup(tools: Tool[] = [tool("extrude", async () => '{"ok":true}')]) {
        FakeSocket.all = [];
        const state = new RemoteMcpState();
        const { gate, answer, asked } = manualGate();
        const tabChanges: ((info: object) => void)[] = [];
        const session = new RemoteMcpSession(link, {
            state,
            gate,
            createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
            createServer: (options) =>
                createMcpServer({ ...options, tools, instructions: "x", queue: new SerialQueue() }),
            tabInfo: (deviceName) => ({
                documentId: "d1",
                documentName: "Bracket",
                deviceName,
                focused: true,
            }),
            watchTab: (onChange) => {
                tabChanges.push(onChange);
                return () => {};
            },
        });
        sessions.push(session);
        return { session, state, answer, asked, tabChanges, gate };
    }

    afterEach(() => {
        for (const session of sessions.splice(0)) session.close();
        rs.useRealTimers();
        link.checkSession.mockReset();
        link.checkSession.mockImplementation(async () => true);
    });

    test("a reconnect never runs a call that was waiting for the prompt on the old socket", async () => {
        const { session, state, answer, asked } = setup();
        session.start();
        const socket = FakeSocket.all[0];
        socket.open();
        const meta = { [RELAY.agentMetaKey]: AGENT };
        socket.deliver({
            jsonrpc: "2.0",
            id: "s1",
            method: "tools/call",
            params: { name: "extrude", _meta: meta },
        });
        await settle();
        expect(asked).toHaveLength(1);
        expect(document.querySelector("dialog")).toBeNull(); // the test's gate shows no dialog

        socket.close(1006);
        await settle();
        answer("allow"); // too late: the prompt was closed with the socket
        await settle();

        expect(state.current.calls).toEqual([]);
        expect(socket.sent.find((m) => m.id === "s1")).toBeUndefined();
        session.close();
    });

    test("closing the session (sign-out) closes the prompt it was showing", async () => {
        const { session, gate } = setup();
        session.start();
        FakeSocket.all[0].open();
        const decided = gate.decide({ id: "a1", clientName: "c" });
        await settle();

        session.close();

        await expect(decided).resolves.toBe("deny");
        expect(gate.decisionOf("a1")).toBeUndefined();
    });

    test("a 1008 close with the web session still valid reconnects (after a backoff)", async () => {
        rs.useFakeTimers();
        const { session } = setup();
        session.start();
        FakeSocket.all[0].open();
        await rs.advanceTimersByTimeAsync(0);

        FakeSocket.all[0].close(1008);
        await rs.advanceTimersByTimeAsync(0);
        expect(link.checkSession).toHaveBeenCalledTimes(1);
        await rs.advanceTimersByTimeAsync(3000);

        expect(FakeSocket.all).toHaveLength(2);
        expect(session.stopped).toBe(false);
    });

    test("registers the tab, relays calls after Allow, and shows the bound agents", async () => {
        const { session, state, answer, asked, tabChanges } = setup();
        session.start();
        const socket = FakeSocket.all[0];
        expect(socket.url.href).toBe("wss://spicy.lan/ws/mcp-page");
        socket.open();
        await settle();

        expect(state.current.status).toBe("connected");
        expect(socket.sent[0]).toEqual({
            jsonrpc: "2.0",
            method: RELAY.tab,
            params: { documentId: "d1", documentName: "Bracket", deviceName: "Laptop", focused: true },
        });
        tabChanges[0]({ focused: true });
        expect(socket.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: RELAY.tab, params: { focused: true } });

        socket.deliver({
            jsonrpc: "2.0",
            method: RELAY.welcome,
            params: { tabId: "t1", maxMessageBytes: 1 << 20 },
        });
        socket.deliver({ jsonrpc: "2.0", method: RELAY.agents, params: { agents: [AGENT] } });
        const meta = { [RELAY.agentMetaKey]: AGENT };
        socket.deliver({
            jsonrpc: "2.0",
            id: "s1",
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: AGENT.clientInfo,
                _meta: meta,
            },
        });
        socket.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
        socket.deliver({
            jsonrpc: "2.0",
            id: "s2",
            method: "tools/call",
            params: { name: "extrude", _meta: meta },
        });
        await settle();

        expect(state.current.tabId).toBe("t1");
        expect(state.current.agents).toEqual([
            {
                id: "a1",
                clientName: "claude-code",
                clientVersion: "2.1",
                tokenName: "Laptop",
                pairing: undefined,
            },
        ]);
        expect(socket.sent.find((m) => m.id === "s1")?.result.serverInfo.name).toBe("spicy3d");
        expect(socket.sent.find((m) => m.id === "s2")).toBeUndefined();
        expect(asked).toHaveLength(1);

        answer("allow");
        await settle();
        expect(socket.sent.find((m) => m.id === "s2")?.result.content).toEqual([
            { type: "text", text: '{"ok":true}' },
        ]);
        expect(state.current.agents[0].pairing).toBe("allow");
        expect(state.current.calls.map((c) => c.name)).toEqual(["extrude"]);
        session.close();
    });

    test("Disconnect agent tells the relay and drops it from the badge", async () => {
        const { session, state } = setup();
        session.start();
        const socket = FakeSocket.all[0];
        socket.open();
        socket.deliver({ jsonrpc: "2.0", method: RELAY.agents, params: { agents: [AGENT, AGENT_2] } });
        await settle();

        session.disconnectAgent("a1");
        await settle();

        expect(socket.sent.at(-1)).toEqual({
            jsonrpc: "2.0",
            method: RELAY.disconnectAgent,
            params: { agentId: "a1" },
        });
        expect(state.current.agents.map((a) => a.id)).toEqual(["a2"]);
        session.close();
    });

    test("a session listed before its client said who it is gets the name from its requests", async () => {
        const { session, state } = setup();
        session.start();
        const socket = FakeSocket.all[0];
        socket.open();
        socket.deliver({
            jsonrpc: "2.0",
            method: RELAY.agents,
            params: { agents: [{ id: "a1", clientInfo: null }] },
        });
        await settle();
        expect(state.current.agents[0].clientName).toBe("MCP client");

        socket.deliver({
            jsonrpc: "2.0",
            id: "s1",
            method: "tools/list",
            params: { _meta: { [RELAY.agentMetaKey]: AGENT } },
        });
        await settle();

        expect(state.current.agents[0]).toMatchObject({
            id: "a1",
            clientName: "claude-code",
            tokenName: "Laptop",
        });
        session.close();
    });

    test("a dropped connection reconnects; a 1008 close (signed out) does not", async () => {
        rs.useFakeTimers();
        link.checkSession.mockImplementation(async () => false);
        const { session, state } = setup();
        session.start();
        FakeSocket.all[0].open();
        await rs.advanceTimersByTimeAsync(0);

        FakeSocket.all[0].close(1006);
        await rs.advanceTimersByTimeAsync(2000);
        expect(FakeSocket.all).toHaveLength(2);
        FakeSocket.all[1].open();
        await rs.advanceTimersByTimeAsync(0);
        expect(state.current.status).toBe("connected");

        FakeSocket.all[1].close(1008);
        await rs.advanceTimersByTimeAsync(60_000);
        expect(FakeSocket.all).toHaveLength(2);
        expect(state.current.status).toBe("offline");
        expect(session.stopped).toBe(true);
        session.close();
    });

    test("backoff grows, is capped and jittered", () => {
        expect(relayRetryDelay(0, () => 0.5)).toBe(1000);
        expect(relayRetryDelay(3, () => 0.5)).toBe(8000);
        expect(relayRetryDelay(20, () => 0.5)).toBe(30_000);
        expect(relayRetryDelay(0, () => 0)).toBe(750);
        expect(relayRetryDelay(0, () => 1)).toBe(1250);
    });
});
