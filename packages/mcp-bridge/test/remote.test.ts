// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mcpEndpointFor, RemoteProxy, readEventStream, SERVER_UNAVAILABLE } from "../src/remote.mjs";

interface Message {
    jsonrpc: string;
    id?: string | number | null;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
}

const ENDPOINT = "https://spicy.lan/mcp";
const INIT: Message = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } },
};
const INITIALIZED: Message = { jsonrpc: "2.0", method: "notifications/initialized" };

function stream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

function sse(...messages: Message[]): Response {
    const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
    return new Response(stream([body]), { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Seen {
    method: string;
    headers: Record<string, string>;
    body?: Message;
    redirect?: RequestRedirect;
    signal?: AbortSignal | null;
}

/** A minimal Streamable HTTP server: sessions, JSON or SSE answers, and a switch to expire them. */
function fakeServer(options: { answerAs?: "json" | "sse"; status?: number } = {}) {
    const seen: Seen[] = [];
    const sessions = new Set<string>();
    let next = 0;
    let streamBody: string[] | undefined;
    const fetch = async (_url: string | URL, init: RequestInit = {}): Promise<Response> => {
        const headers = Object.fromEntries(
            Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
                k.toLowerCase(),
                v,
            ]),
        );
        const body = init.body ? (JSON.parse(String(init.body)) as Message) : undefined;
        const method = init.method ?? "GET";
        seen.push({ method, headers, body, redirect: init.redirect, signal: init.signal });
        if (options.status)
            return new Response(JSON.stringify({ title: "nope" }), { status: options.status });
        const session = headers["mcp-session-id"];
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (method === "GET") {
            if (!session || !sessions.has(session)) return new Response(null, { status: 404 });
            return new Response(stream(streamBody ?? []), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        }
        if (body?.method === "initialize") {
            const id = `session-${++next}`;
            sessions.add(id);
            const answer = {
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: body.params.protocolVersion, capabilities: {}, serverInfo: {} },
            };
            return new Response(JSON.stringify(answer), {
                status: 200,
                headers: { "content-type": "application/json", "mcp-session-id": id },
            });
        }
        if (!session || !sessions.has(session)) return new Response(null, { status: 404 });
        if (body?.id === undefined || body.method === undefined) return new Response(null, { status: 202 });
        const answer = { jsonrpc: "2.0", id: body.id, result: { echo: body.method } };
        return options.answerAs === "json"
            ? new Response(JSON.stringify(answer), {
                  status: 200,
                  headers: { "content-type": "application/json" },
              })
            : sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }, answer);
    };
    return {
        fetch,
        seen,
        expireSessions: () => sessions.clear(),
        setStream: (chunks: string[]) => {
            streamBody = chunks;
        },
    };
}

function setup(server = fakeServer()) {
    const toClient: Message[] = [];
    const proxy = new RemoteProxy({
        endpoint: ENDPOINT,
        token: "spicy_pat_abc",
        sendToClient: (m: Message) => toClient.push(m),
        fetch: server.fetch,
        version: "9.9.9",
        setTimeout: () => undefined, // no stream reconnects in tests
    });
    return { proxy, toClient, server };
}

/** Lets the proxy's fetch chains run. */
async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("mcpEndpointFor", () => {
    test.each([
        ["https://spicy.lan", "https://spicy.lan/mcp"],
        ["https://spicy.lan/", "https://spicy.lan/mcp"],
        ["https://spicy.lan/mcp", "https://spicy.lan/mcp"],
        ["https://host/spicy/", "https://host/spicy/mcp"],
        ["http://localhost:5080?x=1", "http://localhost:5080/mcp"],
    ])("%s → %s", (server, endpoint) => {
        expect(mcpEndpointFor(server)).toBe(endpoint);
    });

    test.each([
        "http://127.0.0.1:5080",
        "http://[::1]:5080/mcp",
    ])("allows plain http to this machine: %s", (server) => {
        expect(mcpEndpointFor(server)).toMatch(/^http:\/\/.*\/mcp$/);
    });

    test("refuses plain http to another host: the token would travel in clear", () => {
        expect(() => mcpEndpointFor("http://spicy.lan")).toThrow("https");
    });

    test.each(["ftp://spicy.lan", "not a url"])("refuses %s", (server) => {
        expect(() => mcpEndpointFor(server)).toThrow("--server");
    });
});

describe("readEventStream", () => {
    test("joins data lines, skips comments and other events, across chunk and CRLF boundaries", async () => {
        const events: string[] = [];
        await readEventStream(
            stream([
                ": ping\r\n",
                'data: {"a":\r\ndata: 1}\r\n\r',
                "\nevent: other\ndata: x\n\n",
                "data: last",
            ]),
            (data) => events.push(data),
        );
        expect(events).toEqual(['{"a":\n1}', "last"]);
    });
});

describe("readEventStream CRLF", () => {
    test("a CRLF split across two chunks ends one line, not two", async () => {
        const events: string[] = [];
        await readEventStream(stream(["data: a\r", "\ndata: b\r", "\n\r", "\n"]), (data) =>
            events.push(data),
        );
        expect(events).toEqual(["a\nb"]);
    });
});

describe("RemoteProxy", () => {
    test("never follows redirects (the token would go along), and bounds the DELETE on exit", async () => {
        const { proxy, server } = setup(fakeServer({ answerAs: "json" }));
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage(INITIALIZED);
        proxy.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        await settle();
        await proxy.close();

        expect(server.seen.length).toBeGreaterThan(3);
        for (const request of server.seen) expect(request.redirect).toBe("error");
        const del = server.seen.find((s) => s.method === "DELETE");
        expect(del?.signal).toBeInstanceOf(AbortSignal);
    });

    test("opens the session with the token, then sends its id and protocol version", async () => {
        const { proxy, toClient, server } = setup();
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage(INITIALIZED);
        proxy.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        await settle();

        const posts = server.seen.filter((s) => s.method === "POST");
        expect(posts.map((p) => p.body?.method)).toEqual([
            "initialize",
            "notifications/initialized",
            "tools/list",
        ]);
        expect(posts[0].headers["authorization"]).toBe("Bearer spicy_pat_abc");
        expect(posts[0].headers["mcp-session-id"]).toBeUndefined();
        expect(posts[2].headers["mcp-session-id"]).toBe("session-1");
        expect(posts[2].headers["mcp-protocol-version"]).toBe("2025-11-25");
        expect(posts[2].headers["accept"]).toBe("application/json, text/event-stream");
        // The SSE answer: the progress notification first, then the result.
        expect(toClient.map((m) => m.method ?? m.id)).toEqual([0, "notifications/progress", 1]);
        expect(toClient[2].result).toEqual({ echo: "tools/list" });
    });

    test("takes plain JSON answers too", async () => {
        const { proxy, toClient } = setup(fakeServer({ answerAs: "json" }));
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
        await settle();

        expect(toClient.map((m) => m.id)).toEqual([0, 1]);
        expect(toClient[1].result).toEqual({ echo: "tools/call" });
    });

    test("a session the server lost is re-created silently and the call retried once", async () => {
        const { proxy, toClient, server } = setup();
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage(INITIALIZED);
        await settle();
        server.expireSessions();
        toClient.length = 0;

        proxy.handleClientMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } });
        await settle();

        const posts = server.seen.filter((s) => s.method === "POST").map((p) => p.body?.method);
        expect(posts.slice(-4)).toEqual([
            "tools/call",
            "initialize",
            "notifications/initialized",
            "tools/call",
        ]);
        const replay = server.seen.filter((s) => s.body?.method === "initialize")[1];
        expect(replay.body?.params).toEqual(INIT.params);
        expect(String(replay.body?.id)).toMatch(/^spicy3d-bridge-reinit-/);
        // The client sees only its own answer, never the replayed initialize.
        expect(toClient.filter((m) => m.id !== undefined).map((m) => m.id)).toEqual([7]);
        expect(server.seen.filter((s) => s.method === "POST").at(-1)?.headers["mcp-session-id"]).toBe(
            "session-2",
        );
    });

    test.each([
        [401, "access token"],
        [403, "permission"],
        [429, "too many"],
        [500, "500"],
    ])("a %i fails the request with a JSON-RPC error saying why", async (status, text) => {
        const { proxy, toClient } = setup(fakeServer({ status }));
        proxy.handleClientMessage(INIT);
        await settle();

        expect(toClient).toHaveLength(1);
        expect(toClient[0].id).toBe(0);
        expect(toClient[0].error.code).toBe(SERVER_UNAVAILABLE);
        expect(toClient[0].error.message).toContain(text);
    });

    test("an unreachable server fails requests, and notifications stay silent", async () => {
        const toClient: Message[] = [];
        const proxy = new RemoteProxy({
            endpoint: ENDPOINT,
            token: "t",
            sendToClient: (m: Message) => toClient.push(m),
            fetch: async () => {
                throw new Error("ECONNREFUSED");
            },
        });
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage(INITIALIZED);
        await settle();

        expect(toClient).toHaveLength(1);
        expect(toClient[0].error.message).toContain("ECONNREFUSED");
    });

    test("after initialized, the GET stream brings the server's own notifications", async () => {
        const server = fakeServer();
        server.setStream([
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        ]);
        const { proxy, toClient } = setup(server);
        proxy.handleClientMessage(INIT);
        proxy.handleClientMessage(INITIALIZED);
        await settle();

        const get = server.seen.find((s) => s.method === "GET");
        expect(get?.headers["mcp-session-id"]).toBe("session-1");
        expect(get?.headers["accept"]).toBe("text/event-stream");
        expect(toClient.map((m) => m.method).filter(Boolean)).toEqual(["notifications/tools/list_changed"]);
    });

    test("close ends the session on the server", async () => {
        const { proxy, server } = setup(fakeServer({ answerAs: "json" }));
        proxy.handleClientMessage(INIT);
        await settle();
        await proxy.close();

        const del = server.seen.find((s) => s.method === "DELETE");
        expect(del?.headers["mcp-session-id"]).toBe("session-1");
    });
});
