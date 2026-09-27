// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AgentBadge } from "../src/mcp/agentBadge";
import { askPairing } from "../src/mcp/pairing";
import { createMcpPanel } from "../src/mcp/panel";
import { remoteMcpState } from "../src/mcp/remote";
import { loadMcpSettings } from "../src/mcp/settings";
import { mcpState } from "../src/mcp/state";

function checkboxes(panel: HTMLElement): HTMLInputElement[] {
    return Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function codeBlocks(panel: HTMLElement): string[] {
    return Array.from(panel.querySelectorAll("div"))
        .filter((d) => d.textContent?.startsWith("claude mcp add") || d.textContent?.startsWith("{\n"))
        .filter((d) => d.children.length === 0)
        .map((d) => d.textContent ?? "");
}

describe("McpPanel", () => {
    afterEach(() => {
        localStorage.clear();
        document.body.innerHTML = "";
        mcpState.update({ status: "idle", bridge: undefined, calls: [] });
    });

    test("shows the generated token in the setup snippets", () => {
        const panel = createMcpPanel();
        document.body.append(panel);
        const { token } = loadMcpSettings();

        const [command, json] = codeBlocks(panel);

        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(command).toContain(`SPICY3D_BRIDGE_TOKEN=${token}`);
        expect(JSON.parse(json).mcpServers.spicy3d.env.SPICY3D_BRIDGE_TOKEN).toBe(token);
    });

    test("turning the token off saves it, warns, and switches the bridge to no-token mode", () => {
        const panel = createMcpPanel();
        document.body.append(panel);
        const [requireToken] = checkboxes(panel);
        expect(requireToken.checked).toBe(true);

        requireToken.checked = false;
        requireToken.dispatchEvent(new Event("change"));

        expect(loadMcpSettings().requireToken).toBe(false);
        const warning = Array.from(panel.querySelectorAll<HTMLElement>("div")).find(
            (d) => d.textContent === "mcp.noTokenWarning",
        );
        expect(warning).not.toBeUndefined();
        expect(warning?.style.display).toBe("");
        const [command] = codeBlocks(panel);
        expect(command).toContain("--no-token");
        expect(command).not.toContain("SPICY3D_BRIDGE_TOKEN");
    });

    test("reflects the live connection state and recent calls", () => {
        const panel = createMcpPanel();
        document.body.append(panel);

        mcpState.update({ status: "connected", bridge: "ws://127.0.0.1:7777/?token=…" });
        mcpState.recordCall("run_program", false);

        expect(panel.textContent).toContain("mcp.status.connected");
        expect(panel.textContent).toContain("run_program");
        expect(panel.textContent).toContain("mcp.disconnect");
    });
});

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

describe("McpPanel through the server", () => {
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
        remoteMcpState.update({ link: undefined, status: "unavailable", agents: [], calls: [] });
        link.createToken.mockClear();
    });

    function remoteSnippets(panel: HTMLElement): string[] {
        return Array.from(panel.querySelectorAll<HTMLElement>("[data-remote]")).map(
            (d) => d.textContent ?? "",
        );
    }

    function modeButton(panel: HTMLElement, mode: string): HTMLButtonElement {
        const b = panel.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`);
        expect(b).not.toBeNull();
        return b as HTMLButtonElement;
    }

    test("without a signed-in server only the local bridge shows", () => {
        const panel = createMcpPanel();
        document.body.append(panel);

        expect(remoteSnippets(panel)).toEqual([]);
        expect(modeButton(panel, "remote").parentElement?.style.display).toBe("none");
    });

    test("with the relay, it opens on the server mode with the client configs", () => {
        remoteMcpState.update({ link, status: "connected" });
        const panel = createMcpPanel();
        document.body.append(panel);

        const [claude, json, stdio] = remoteSnippets(panel);
        expect(claude).toBe(
            'claude mcp add --transport http spicy3d https://spicy.lan/mcp --header "Authorization: Bearer $SPICY3D_TOKEN"',
        );
        expect(JSON.parse(json).mcpServers.spicy3d.url).toBe("https://spicy.lan/mcp");
        expect(JSON.parse(stdio).mcpServers.spicy3d.args).toEqual(["--server", "https://spicy.lan"]);
        expect(panel.textContent).toContain("mcp.remote.status.connected");
        expect(modeButton(panel, "remote").getAttribute("aria-pressed")).toBe("true");

        modeButton(panel, "local").click();
        expect(modeButton(panel, "local").getAttribute("aria-pressed")).toBe("true");
        const localCommand = codeBlocks(panel).find((c) => c.includes("SPICY3D_BRIDGE_TOKEN"));
        expect(localCommand).not.toBeUndefined();
    });

    test("lists the bound agents and creates a token from the panel", () => {
        remoteMcpState.update({ link, status: "connected" });
        const panel = createMcpPanel();
        document.body.append(panel);
        remoteMcpState.update({
            agents: [{ id: "a1", clientName: "claude-code", tokenName: "Laptop", pairing: "deny" }],
        });

        const agentText = Array.from(panel.querySelectorAll("span")).map((s) => s.textContent ?? "");
        expect(agentText.some((t) => t.startsWith("mcp.agent.denied") && t.includes("claude-code"))).toBe(
            true,
        );
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
        const box = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((b) =>
            b.parentElement?.textContent?.includes("mcp.remote.enabled"),
        );
        expect(box?.checked).toBe(true);

        (box as HTMLInputElement).checked = false;
        box?.dispatchEvent(new Event("change"));

        expect(loadMcpSettings().remoteEnabled).toBe(false);
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
