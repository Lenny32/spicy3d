// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createMcpPanel } from "../src/mcp/panel";
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
