// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Remote MCP (CLOUD-14), the eager SDK-free half: the link the cloud module hands over while the
// user is signed in to a server with the MCP relay, the state the panel and the agent badge show,
// and the client configs. The page socket session itself lives in the lazy half (remoteSession.ts).

import { Logger } from "@spicy3d/core";
import { ensureAgentBadge } from "./agentBadge";
import { type RemoteMcpLink, type RemoteMcpStatus, remoteMcpState } from "./remoteState";
import {
    loadMcpSettings,
    type McpSettings,
    resolveBridgeCommand,
    saveMcpSettings,
    splitCommand,
} from "./settings";

export * from "./remoteState";

/** The SDK half, loaded only once a link is there and remote access is on. */
const loadController = () => import("./index");

/**
 * Called by the cloud module when remote MCP becomes reachable (signed in, `features.mcp`) or not
 * any more. With the link and the setting on, this tab connects to the relay; without, it leaves.
 */
export function setRemoteMcpLink(link: RemoteMcpLink | undefined): void {
    const previous = remoteMcpState.current.link;
    if (previous === link) return;
    remoteMcpState.update({ link });
    if (link) ensureAgentBadge();
    if (!link) {
        if (previous) void loadController().then((c) => c.disconnectMcpRemote("unavailable"));
        return;
    }
    if (loadMcpSettings().remoteEnabled) connectRemote(link);
    else remoteMcpState.update({ status: "idle" });
}

/** The panel's switch: connect now (and on later sign-ins) or leave and stay off. */
export function setRemoteMcpEnabled(enabled: boolean): void {
    const settings: McpSettings = { ...loadMcpSettings(), remoteEnabled: enabled };
    saveMcpSettings(settings);
    const link = remoteMcpState.current.link;
    if (!link) return;
    if (enabled) connectRemote(link);
    else void loadController().then((c) => c.disconnectMcpRemote("idle"));
}

/** "Disconnect agent": ends that MCP session on the relay. */
export function disconnectRemoteAgent(agentId: string): void {
    void loadController().then((c) => c.disconnectRemoteAgent(agentId));
}

function connectRemote(link: RemoteMcpLink) {
    remoteMcpState.update({ status: "connecting" });
    void loadController()
        .then((c) => c.connectMcpRemote(link))
        .catch((err) => {
            Logger.error(`[mcp] remote access failed to start: ${err}`);
            remoteMcpState.update({ status: "offline" });
        });
}

// ---- Client configs --------------------------------------------------------------------------

export const TOKEN_PLACEHOLDER = "<token>";

/** The server's base address, as `spicy3d-mcp-bridge --server` takes it. */
export function serverUrlOf(endpoint: string): string {
    return endpoint.replace(/\/mcp\/?$/, "");
}

/** Claude Code over Streamable HTTP: no bridge at all. */
export function remoteClaudeCodeCommand(endpoint: string, token = TOKEN_PLACEHOLDER): string {
    // Endpoint and token (base62) need no escaping inside double quotes in any shell.
    return `claude mcp add --transport http spicy3d ${endpoint} --header "Authorization: Bearer ${token}"`;
}

/** Cursor, VS Code (under "servers") and other clients that speak Streamable HTTP. */
export function remoteJsonConfig(endpoint: string, token = TOKEN_PLACEHOLDER): string {
    const server = { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } };
    return JSON.stringify({ mcpServers: { spicy3d: server } }, null, 2);
}

/** Clients that only start stdio servers: the bridge in `--server` mode, the token in its environment. */
export function remoteStdioConfig(
    endpoint: string,
    settings: McpSettings,
    appUrl: string,
    token = TOKEN_PLACEHOLDER,
): string {
    const [command, ...args] = splitCommand(resolveBridgeCommand(settings, appUrl));
    const server = {
        command,
        args: [...args, "--server", serverUrlOf(endpoint)],
        env: { SPICY3D_TOKEN: token },
    };
    return JSON.stringify({ mcpServers: { spicy3d: server } }, null, 2);
}

/** Every config for `endpoint`, in the order the panel and the token dialog show them. */
export function remoteClientConfigs(
    endpoint: string,
    token = TOKEN_PLACEHOLDER,
    settings: McpSettings = loadMcpSettings(),
    appUrl = `${location.origin}${location.pathname}`,
): { kind: "claudeCode" | "http" | "stdio"; text: string }[] {
    return [
        { kind: "claudeCode", text: remoteClaudeCodeCommand(endpoint, token) },
        { kind: "http", text: remoteJsonConfig(endpoint, token) },
        { kind: "stdio", text: remoteStdioConfig(endpoint, settings, appUrl, token) },
    ];
}
