// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectStorage } from "@spicy3d/core";
import { AgentBadge } from "../src/mcp/agentBadge";
import { askPairing } from "../src/mcp/pairing";
import { createMcpPanel } from "../src/mcp/panel";
import { remoteMcpState } from "../src/mcp/remote";
import { loadMcpSettings } from "../src/mcp/settings";

describe("AgentBadge", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        remoteMcpState.update({ status: "unavailable", agents: [] });
    });

    test("shows one chip per bound session while connected, none otherwise", () => {
        const badge = new AgentBadge();
        document.body.append(badge);
        expect(badge.children).toHaveLength(0);

        remoteMcpState.update({
            status: "connected",
            agents: [
                { id: "a1", clientName: "claude-code", tokenName: "Laptop" },
                { id: "a2", clientName: "cursor", pairing: "deny" },
            ],
        });
        const chips = Array.from(badge.querySelectorAll<HTMLElement>("[data-agent-id]"));
        expect(chips.map((c) => c.dataset["agentId"])).toEqual(["a1", "a2"]);
        expect(chips[0].textContent).toBe("claude-codemcp.agent.disconnect");
        expect(chips[0].title).toContain("Laptop");
        expect(chips[1].dataset["denied"]).toBe("");

        remoteMcpState.update({ status: "offline" });
        expect(badge.children).toHaveLength(0);
    });
});

describe("McpPanel", () => {
    const link = {
        endpoint: "https://spicy.lan/mcp",
        pageSocket: "wss://spicy.lan/ws/mcp-page",
        userName: "Ada",
        deviceName: () => "Laptop",
        createToken: rs.fn(() => {}),
        checkSession: async () => true,
    };

    afterEach(() => {
        localStorage.clear();
        document.body.innerHTML = "";
        remoteMcpState.update({
            link: undefined,
            signIn: undefined,
            status: "unavailable",
            agents: [],
            calls: [],
        });
        link.createToken.mockClear();
    });

    function remoteSnippets(panel: HTMLElement): string[] {
        return Array.from(panel.querySelectorAll<HTMLElement>("[data-remote]")).map(
            (d) => d.textContent ?? "",
        );
    }

    function signInButton(panel: HTMLElement): HTMLButtonElement | null {
        return panel.querySelector<HTMLButtonElement>("button[data-sign-in]");
    }

    function enabledBox(panel: HTMLElement): HTMLInputElement {
        const box = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((b) =>
            b.parentElement?.textContent?.includes("mcp.remote.enabled"),
        );
        expect(box).not.toBeUndefined();
        return box as HTMLInputElement;
    }

    test("without a server offering MCP it says so, with nothing to set up", () => {
        const panel = createMcpPanel();
        document.body.append(panel);

        expect(panel.textContent).toContain("mcp.remote.status.noServer");
        expect(panel.textContent).toContain("mcp.remote.noServer");
        expect(remoteSnippets(panel)).toEqual([]);
        expect(signInButton(panel)).toBeNull();
        expect(enabledBox(panel).parentElement?.style.display).toBe("none");
    });

    test("signed out of a server with MCP it offers the sign-in", () => {
        const signIn = rs.fn(() => {});
        remoteMcpState.update({ signIn });
        const panel = createMcpPanel();
        document.body.append(panel);

        expect(panel.textContent).toContain("mcp.remote.status.unavailable");
        expect(remoteSnippets(panel)).toEqual([]);
        const button = signInButton(panel);
        expect(button).not.toBeNull();
        button?.click();
        expect(signIn).toHaveBeenCalledTimes(1);
    });

    test("signing in replaces the sign-in with the client configs", () => {
        remoteMcpState.update({ signIn: () => {} });
        const panel = createMcpPanel();
        document.body.append(panel);
        expect(signInButton(panel)).not.toBeNull();

        remoteMcpState.update({ link, signIn: undefined, status: "connected" });

        expect(signInButton(panel)).toBeNull();
        const [claude, json, ...rest] = remoteSnippets(panel);
        expect(claude).toBe(
            'claude mcp add --transport http spicy3d https://spicy.lan/mcp --header "Authorization: Bearer $SPICY3D_TOKEN"',
        );
        expect(JSON.parse(json).mcpServers.spicy3d).toEqual({
            type: "http",
            url: "https://spicy.lan/mcp",
            headers: { Authorization: "Bearer <token>" },
        });
        expect(rest).toEqual([]);
        expect(panel.textContent).toContain("mcp.remote.status.connected");
        expect(panel.textContent).toContain("mcp.remote.signedInAsAda");
    });

    test("lists the bound agents and recent calls, and creates a token from the panel", () => {
        remoteMcpState.update({ link, status: "connected" });
        const panel = createMcpPanel();
        document.body.append(panel);
        remoteMcpState.update({
            agents: [{ id: "a1", clientName: "claude-code", tokenName: "Laptop", pairing: "deny" }],
        });
        remoteMcpState.recordCall("run_program", false);

        const agentText = Array.from(panel.querySelectorAll("span")).map((s) => s.textContent ?? "");
        expect(agentText.some((t) => t.startsWith("mcp.agent.denied") && t.includes("claude-code"))).toBe(
            true,
        );
        expect(agentText).toContain("run_program");
        const create = Array.from(panel.querySelectorAll("button")).find(
            (b) => b.textContent === "mcp.remote.createToken",
        );
        expect(create).not.toBeUndefined();
        create?.click();
        expect(link.createToken).toHaveBeenCalledTimes(1);
    });

    test("the switch turns remote access off and saves it", () => {
        remoteMcpState.update({ link, status: "connected" });
        const panel = createMcpPanel();
        document.body.append(panel);
        const box = enabledBox(panel);
        expect(box.checked).toBe(true);

        box.checked = false;
        box.dispatchEvent(new Event("change"));

        expect(loadMcpSettings().remoteEnabled).toBe(false);
    });

    test("settings saved by the local bridge lose its pairing token", () => {
        ObjectStorage.default.setValue("mcp.settings", {
            port: 7777,
            requireToken: true,
            token: "abc",
            remoteEnabled: false,
        });

        expect(loadMcpSettings()).toEqual({ remoteEnabled: false });
        expect(ObjectStorage.default.value("mcp.settings")).toEqual({ remoteEnabled: false });
    });
});

describe("askPairing", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    function prompt() {
        const abort = new AbortController();
        const answer = askPairing({ id: "a1", clientName: "claude-code", tokenName: "Laptop" }, abort.signal);
        const dialog = document.querySelector<HTMLDialogElement>("dialog[data-agent-id]");
        expect(dialog).not.toBeNull();
        return { answer, abort, dialog: dialog as HTMLDialogElement };
    }

    test("shows the token name on its own and the client name as unverified", () => {
        const { dialog, abort } = prompt();
        const tokenName = Array.from(dialog.querySelectorAll("span")).find((s) => s.textContent === "Laptop");
        expect(tokenName).toBeInstanceOf(HTMLSpanElement);
        expect(dialog.textContent).toContain("mcp.pairing.clientclaude-code");
        abort.abort();
    });

    test("Deny all from this token answers denyToken", async () => {
        const { dialog, answer } = prompt();
        const button = dialog.querySelector<HTMLButtonElement>('button[data-action="denyToken"]');
        expect(button).not.toBeNull();
        button?.click();
        await expect(answer).resolves.toBe("denyToken");
        expect(document.querySelector("dialog")).toBeNull();
    });

    test("an aborted prompt closes as a denial", async () => {
        const { answer, abort } = prompt();
        abort.abort();
        await expect(answer).resolves.toBe("deny");
        expect(document.querySelector("dialog")).toBeNull();
    });
});
