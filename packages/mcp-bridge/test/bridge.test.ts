// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BridgeCore, CONNECT_TOOL, pairingUrl, REPLAY_ID_PREFIX, TAB_UNAVAILABLE } from "../src/bridge.mjs";

interface Message {
    jsonrpc: string;
    id?: string | number | null;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
}

const INIT: Message = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
};
const INITIALIZED: Message = { jsonrpc: "2.0", method: "notifications/initialized" };

function setup() {
    const toClient: Message[] = [];
    const core = new BridgeCore({
        pairingUrl: "http://localhost:8080/?mcp=x",
        version: "9.9.9",
        sendToClient: (m: Message) => toClient.push(m),
    });
    return { core, toClient };
}

function fakeTab() {
    const received: Message[] = [];
    const closed: [number | undefined, string | undefined][] = [];
    return {
        received,
        closed,
        send: (m: Message) => received.push(m),
        close: (code?: number, reason?: string) => closed.push([code, reason]),
    };
}

describe("pairingUrl", () => {
    test("puts the bridge address and token into ?mcp=", () => {
        const url = new URL(pairingUrl("http://localhost:8080/?plugin=a.js", 7777, "t0k"));
        expect(url.searchParams.get("mcp")).toBe("ws://127.0.0.1:7777/?token=t0k");
        expect(url.searchParams.get("plugin")).toBe("a.js");
    });

    test("leaves the token out in no-token mode", () => {
        const url = new URL(pairingUrl("http://localhost:8080/", 7777, ""));
        expect(url.searchParams.get("mcp")).toBe("ws://127.0.0.1:7777/");
    });
});

describe("BridgeCore without a tab", () => {
    test("answers initialize itself, echoing a supported protocol version", () => {
        const { core, toClient } = setup();

        core.handleClientMessage(INIT);

        expect(toClient).toEqual([
            {
                jsonrpc: "2.0",
                id: 0,
                result: expect.objectContaining({
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
                    serverInfo: { name: "spicy3d", version: "9.9.9" },
                }),
            },
        ]);
    });

    test("lists only the connect tool, which returns the pairing link", () => {
        const { core, toClient } = setup();

        core.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        core.handleClientMessage({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: CONNECT_TOOL },
        });
        core.handleClientMessage({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "run_program" },
        });

        expect(toClient[0].result.tools.map((t: { name: string }) => t.name)).toEqual([CONNECT_TOOL]);
        expect(toClient[1].result.content[0].text).toContain("http://localhost:8080/?mcp=x");
        expect(toClient[1].result.isError).toBeUndefined();
        expect(toClient[2].result.isError).toBe(true);
    });

    test("fails other requests with a hint instead of hanging", () => {
        const { core, toClient } = setup();

        core.handleClientMessage({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "x" } });

        expect(toClient[0].error.code).toBe(TAB_UNAVAILABLE);
        expect(toClient[0].error.message).toContain("http://localhost:8080/?mcp=x");
    });
});

describe("BridgeCore with a tab", () => {
    test("relays both ways once the tab is there first", () => {
        const { core, toClient } = setup();
        const tab = fakeTab();
        core.attachTab(tab);

        core.handleClientMessage(INIT);
        core.handleTabMessage(tab, { jsonrpc: "2.0", id: 0, result: { from: "tab" } });
        core.handleClientMessage(INITIALIZED);

        expect(tab.received).toEqual([INIT, INITIALIZED]);
        expect(toClient).toEqual([{ jsonrpc: "2.0", id: 0, result: { from: "tab" } }]);
    });

    test("replays the handshake to a tab that connects later and announces the new tools", () => {
        const { core, toClient } = setup();
        core.handleClientMessage(INIT);
        core.handleClientMessage(INITIALIZED);
        toClient.length = 0;
        const tab = fakeTab();

        core.attachTab(tab);
        const replay = tab.received[0];
        core.handleTabMessage(tab, { jsonrpc: "2.0", id: replay.id, result: {} });

        expect(replay).toEqual({
            jsonrpc: "2.0",
            id: `${REPLAY_ID_PREFIX}1`,
            method: "initialize",
            params: INIT.params,
        });
        expect(tab.received[1]).toEqual(INITIALIZED);
        expect(toClient.map((m) => m.method)).toEqual([
            "notifications/tools/list_changed",
            "notifications/resources/list_changed",
        ]);
    });

    test("holds the client's initialized notification until the replay is answered", () => {
        const { core } = setup();
        core.handleClientMessage(INIT);
        const tab = fakeTab();
        core.attachTab(tab);

        core.handleClientMessage(INITIALIZED);
        expect(tab.received.map((m) => m.method)).toEqual(["initialize"]);
        core.handleTabMessage(tab, { jsonrpc: "2.0", id: tab.received[0].id, result: {} });

        expect(tab.received.map((m) => m.method)).toEqual(["initialize", "notifications/initialized"]);
    });

    test("fails in-flight requests when the tab goes away", () => {
        const { core, toClient } = setup();
        const tab = fakeTab();
        core.attachTab(tab);
        core.handleClientMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } });

        core.detachTab(tab);
        core.handleTabMessage(tab, { jsonrpc: "2.0", id: 7, result: { late: true } });

        expect(toClient).toEqual([
            { jsonrpc: "2.0", id: 7, error: expect.objectContaining({ code: TAB_UNAVAILABLE }) },
        ]);
        expect(core.connected).toBe(false);
    });

    test("routes elicitation answers only to the tab that asked", () => {
        const { core, toClient } = setup();
        const first = fakeTab();
        core.attachTab(first);
        core.handleTabMessage(first, { jsonrpc: "2.0", id: 0, method: "elicitation/create", params: {} });
        expect(toClient.at(-1)?.method).toBe("elicitation/create");

        const second = fakeTab();
        core.attachTab(second);
        core.handleClientMessage({ jsonrpc: "2.0", id: 0, result: { action: "accept" } });

        expect(first.closed).toEqual([[4000, "replaced by a newer tab"]]);
        expect(second.received).toEqual([]);
    });

    test("ignores messages from a replaced tab", () => {
        const { core, toClient } = setup();
        const first = fakeTab();
        core.attachTab(first);
        core.attachTab(fakeTab());

        core.handleTabMessage(first, { jsonrpc: "2.0", method: "notifications/message", params: {} });

        expect(toClient).toEqual([]);
    });
});
