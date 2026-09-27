// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { remoteMcpState } from "@spicy3d/ai";
import { defaultSettings, saveMcpSettings } from "@spicy3d/ai/src/mcp/settings";
import type { ConfigResponse } from "../src/api";
import { CloudConnection } from "../src/cloud";
import { startCloudMcp } from "../src/mcp";
import { FakeServer, json, problem, TestRequest, USER } from "./_helpers/fakeServer";

function config(mcp: boolean): ConfigResponse {
    return {
        version: "0.0.2",
        apiVersion: 1,
        features: { signup: true, emailVerification: false, email: true, mcp },
        mcp: mcp ? { endpoint: "https://spicy.lan/mcp", pageSocket: "wss://spicy.lan/ws/mcp-page" } : null,
    } as unknown as ConfigResponse;
}

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

beforeEach(() => {
    // Remote access off: the link is handed over without opening a page socket.
    saveMcpSettings({ ...defaultSettings(), remoteEnabled: false });
});

afterEach(() => {
    localStorage.clear();
    remoteMcpState.update({ link: undefined, signIn: undefined, status: "unavailable", agents: [] });
});

describe("startCloudMcp", () => {
    test("hands over the relay's link while signed in, and takes it away on sign-out", async () => {
        const server = new FakeServer();
        const connection = new CloudConnection(config(true), server.client());
        const stop = startCloudMcp(connection);
        expect(remoteMcpState.current.link).toBeUndefined();

        server.on("GET /api/me", json(200, USER));
        await connection.account.refresh();

        const link = remoteMcpState.current.link;
        expect(link).toMatchObject({
            endpoint: "https://spicy.lan/mcp",
            pageSocket: "wss://spicy.lan/ws/mcp-page",
            userName: "Ada Lovelace",
        });
        expect(link?.deviceName()).toBe(connection.account.deviceSettings.effectiveDeviceName);
        expect(remoteMcpState.current.status).toBe("idle");

        server.on("GET /api/me", problem(401, "unauthorized"));
        await connection.account.refresh();
        expect(remoteMcpState.current.link).toBeUndefined();
        stop();
    });

    test("signing out forgets the tab's pairing decisions (CLOUD-17)", async () => {
        const server = new FakeServer();
        server.on("GET /api/me", json(200, USER));
        const connection = new CloudConnection(config(true), server.client());
        await connection.account.refresh();
        const stop = startCloudMcp(connection);
        sessionStorage.setItem("spicy3d.mcp.tabInstance", "tab-1");
        sessionStorage.setItem(
            "spicy3d.mcp.pairing",
            JSON.stringify({ instance: "tab-1", decisions: [["session-1", "allow"]], blockedTokens: [] }),
        );

        server.on("POST /api/auth/logout", json(204));
        await connection.account.signOut();

        expect(remoteMcpState.current.link).toBeUndefined();
        expect(sessionStorage.getItem("spicy3d.mcp.pairing")).toBeNull();
        // The tab keeps its identity; only the decisions go.
        expect(sessionStorage.getItem("spicy3d.mcp.tabInstance")).toBe("tab-1");
        stop();
        sessionStorage.clear();
    });

    test("the same user refreshing keeps the same link (no reconnect)", async () => {
        const server = new FakeServer();
        server.on("GET /api/me", json(200, USER));
        const connection = new CloudConnection(config(true), server.client());
        await connection.account.refresh();
        const stop = startCloudMcp(connection);
        const first = remoteMcpState.current.link;

        await connection.account.refresh();

        expect(first).not.toBeUndefined();
        expect(remoteMcpState.current.link).toBe(first);
        stop();
        expect(remoteMcpState.current.link).toBeUndefined();
    });

    test("signed out, the MCP panel is offered the sign-in; signing in replaces it with the link", async () => {
        const server = new FakeServer();
        server.on("GET /api/me", problem(401, "unauthorized"));
        const connection = new CloudConnection(config(true), server.client());
        const stop = startCloudMcp(connection);
        await connection.account.refresh();
        expect(connection.account.status).toBe("signedOut");
        expect(remoteMcpState.current.signIn).toBeTypeOf("function");
        expect(remoteMcpState.current.link).toBeUndefined();

        server.on("GET /api/me", json(200, USER));
        await connection.account.refresh();

        expect(remoteMcpState.current.signIn).toBeUndefined();
        expect(remoteMcpState.current.link).not.toBeUndefined();
        stop();
        expect(remoteMcpState.current.signIn).toBeUndefined();
        expect(remoteMcpState.current.link).toBeUndefined();
    });

    test("does nothing when the server has the relay off", async () => {
        const server = new FakeServer();
        server.on("GET /api/me", json(200, USER));
        const connection = new CloudConnection(config(false), server.client());
        await connection.account.refresh();

        startCloudMcp(connection);

        expect(remoteMcpState.current.link).toBeUndefined();
        expect(remoteMcpState.current.signIn).toBeUndefined();
    });
});
