// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Logger } from "@spicy3d/core";
import type { Account } from "../src/account/account";
import { type CloudEvent, EventsChannel, eventsSocketUrl, type SocketLike } from "../src/sync/events";
import { FakeServer, json, signedInAccount } from "./_helpers/fakeServer";

/** Sockets the channel opened, driven by the test. */
class Sockets {
    readonly opened: TestSocket[] = [];
    readonly create = (url: string): SocketLike => {
        const socket = new TestSocket(url);
        this.opened.push(socket);
        return socket;
    };
    get last(): TestSocket {
        return this.opened.at(-1)!;
    }
}

class TestSocket implements SocketLike {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closedWith?: number;
    constructor(readonly url: string) {}
    close(code?: number) {
        this.closedWith = code;
    }
    open() {
        this.onopen?.({});
    }
    send(message: unknown) {
        this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
    }
    serverClose(code: number) {
        this.onclose?.({ code, reason: "" });
    }
}

let account: Account;
let server: FakeServer;
let sockets: Sockets;
let channel: EventsChannel;

beforeEach(async () => {
    rs.useFakeTimers();
    rs.spyOn(Logger, "info").mockImplementation(() => {});
    server = new FakeServer();
    account = await signedInAccount(server);
    sockets = new Sockets();
    channel = new EventsChannel({
        url: "wss://spicy.test/ws/events",
        baseUrl: "https://spicy.test",
        account,
        createSocket: sockets.create,
        heartbeatMs: 1000,
        initialDelayMs: 100,
        maxDelayMs: 800,
        random: () => 1,
    });
});

afterEach(() => {
    channel.stop();
    rs.useRealTimers();
    rs.restoreAllMocks();
});

describe("events channel", () => {
    test.each([
        ["wss://spicy.test/ws/events", "https://spicy.test", "wss://spicy.test/ws/events"],
        ["/ws/events", "https://spicy.test/app", "wss://spicy.test/ws/events"],
        ["ws/events", "http://lan.box:8080/app", "ws://lan.box:8080/app/ws/events"],
    ])("%s from %s → %s", (url, base, expected) => {
        expect(eventsSocketUrl(url, base)).toBe(expected);
    });

    test("delivers events, ignores unknown and malformed messages, announces every connect", () => {
        const events: CloudEvent[] = [];
        const connected = rs.fn(() => {});
        channel.onEvent((event) => events.push(event));
        channel.onConnected(connected);
        channel.start();
        sockets.last.open();

        sockets.last.send({
            type: "document.updated",
            documentId: "d",
            headVersionId: "v",
            kind: "auto",
            clientId: "c",
            at: "x",
        });
        sockets.last.send("not json");
        sockets.last.send({ noType: true });
        sockets.last.send({ type: "something.new", at: "x" });

        expect(connected).toHaveBeenCalledTimes(1);
        expect(events.map((x) => x.type)).toEqual(["document.updated", "something.new"]);
        expect(channel.connected).toBe(true);
    });

    test("reconnects with growing, capped backoff; a message resets it", async () => {
        channel.start();
        sockets.last.serverClose(1006);
        await rs.advanceTimersByTimeAsync(99);
        expect(sockets.opened.length).toBe(1);
        await rs.advanceTimersByTimeAsync(1);
        expect(sockets.opened.length).toBe(2);

        sockets.last.serverClose(1006);
        await rs.advanceTimersByTimeAsync(200);
        expect(sockets.opened.length).toBe(3);
        sockets.last.serverClose(1006);
        await rs.advanceTimersByTimeAsync(400);
        sockets.last.serverClose(1006);
        await rs.advanceTimersByTimeAsync(800);
        sockets.last.serverClose(1006);
        await rs.advanceTimersByTimeAsync(800);
        expect(sockets.opened.length).toBe(6);

        sockets.last.open();
        sockets.last.send({ type: "ping", at: "x" });
        sockets.last.serverClose(1001);
        await rs.advanceTimersByTimeAsync(100);
        expect(sockets.opened.length).toBe(7);
    });

    test("a connection silent for 2.5 heartbeats is closed and replaced; pings keep it", async () => {
        channel.start();
        sockets.last.open();
        await rs.advanceTimersByTimeAsync(2000);
        sockets.last.send({ type: "ping", at: "x" });
        await rs.advanceTimersByTimeAsync(2000);
        expect(sockets.opened.length).toBe(1);

        await rs.advanceTimersByTimeAsync(500);
        expect(sockets.opened[0].closedWith).toBe(1000);
        await rs.advanceTimersByTimeAsync(100);
        expect(sockets.opened.length).toBe(2);
    });

    test("session.revoked: no reconnect, the session is checked; a new sign-in reconnects", async () => {
        server.on("GET /api/me", json(401, { status: 401, code: "unauthorized" }));
        channel.start();
        sockets.last.open();
        sockets.last.send({ type: "session.revoked", at: "x" });
        sockets.last.serverClose(1008);
        await rs.advanceTimersByTimeAsync(5000);

        expect(sockets.opened.length).toBe(1);
        expect(server.calls).toContain("GET /api/me");
        expect(account.status).toBe("expired");

        server.on("POST /api/auth/login", json(200, account.user));
        await account.signIn("ada@example.test", "secret");
        expect(sockets.opened.length).toBe(2);
    });

    test("a 1008 without session.revoked (a protocol error) reconnects", async () => {
        channel.start();
        sockets.last.open();
        sockets.last.serverClose(1008);
        await rs.advanceTimersByTimeAsync(100);
        expect(sockets.opened.length).toBe(2);
    });

    test("back online reconnects at once; signed out closes and stays closed", async () => {
        channel.start();
        sockets.last.serverClose(1006);
        globalThis.dispatchEvent(new Event("online"));
        expect(sockets.opened.length).toBe(2);

        server.on("POST /api/auth/logout", json(204));
        await account.signOut();
        expect(sockets.opened[1].closedWith).toBe(1000);
        await rs.advanceTimersByTimeAsync(5000);
        expect(sockets.opened.length).toBe(2);
    });
});
