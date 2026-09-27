// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpSession } from "../src/mcp/session";
import { parseBridgeUrl } from "../src/mcp/settings";
import type { McpStatus } from "../src/mcp/state";

/** A transport whose start() fails the first `failures` times, as when the bridge is not up yet. */
function flakyTransports(failures: number) {
    let attempts = 0;
    const transports: Transport[] = [];
    const create = (): Transport => {
        const fail = attempts++ < failures;
        const transport: Transport = {
            start: async () => {
                if (fail) {
                    transport.onclose?.();
                    throw new Error("ECONNREFUSED");
                }
            },
            send: async () => {},
            close: async () => transport.onclose?.(),
        };
        transports.push(transport);
        return transport;
    };
    return { create, transports, attempts: () => attempts };
}

describe("parseBridgeUrl", () => {
    test.each([
        "ws://127.0.0.1:7777/?token=abc",
        "ws://localhost:7777/",
        "ws://[::1]:7777/",
    ])("accepts the loopback bridge %s", (raw) => {
        expect(parseBridgeUrl(raw)?.href).toBe(new URL(raw).href);
    });

    test.each([
        "wss://evil.example/?token=abc",
        "ws://evil.example:7777/",
        "ws://127.0.0.1.evil.example/",
        "http://127.0.0.1:7777/",
        "not a url",
    ])("refuses %s", (raw) => {
        expect(parseBridgeUrl(raw)).toBeUndefined();
    });
});

describe("McpSession", () => {
    afterEach(() => {
        rs.useRealTimers();
    });

    test("retries until the bridge is up, then reports connected", async () => {
        rs.useFakeTimers();
        const transports = flakyTransports(2);
        const statuses: McpStatus[] = [];
        const session = new McpSession(new URL("ws://127.0.0.1:7777/"), {
            onStatus: (s) => statuses.push(s),
            createTransport: transports.create,
        }).start();

        await rs.advanceTimersByTimeAsync(0);
        expect(session.status).toBe("offline");
        await rs.advanceTimersByTimeAsync(1000); // second attempt, fails
        await rs.advanceTimersByTimeAsync(2000); // third attempt, succeeds

        expect(transports.attempts()).toBe(3);
        expect(session.status).toBe("connected");
        expect(statuses).toEqual(["offline", "connected"]);
        session.close();
    });

    test("reconnects after the bridge drops the connection", async () => {
        rs.useFakeTimers();
        const transports = flakyTransports(0);
        const session = new McpSession(new URL("ws://127.0.0.1:7777/"), {
            createTransport: transports.create,
        }).start();
        await rs.advanceTimersByTimeAsync(0);
        expect(session.status).toBe("connected");

        transports.transports[0].onclose?.();
        expect(session.status).toBe("offline");
        await rs.advanceTimersByTimeAsync(1000);

        expect(transports.attempts()).toBe(2);
        expect(session.status).toBe("connected");
        session.close();
    });

    test("stops retrying once closed", async () => {
        rs.useFakeTimers();
        const transports = flakyTransports(10);
        const session = new McpSession(new URL("ws://127.0.0.1:7777/"), {
            createTransport: transports.create,
        }).start();
        await rs.advanceTimersByTimeAsync(0);

        session.close();
        await rs.advanceTimersByTimeAsync(60_000);

        expect(transports.attempts()).toBe(1);
    });
});
