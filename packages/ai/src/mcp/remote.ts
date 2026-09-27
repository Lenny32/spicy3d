// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Remote MCP (CLOUD-14), the eager SDK-free half: the link the cloud module hands over while the
// user is signed in to a server with the MCP relay, the state the panel and the agent badge show,
// and the client configs. The page socket session itself lives in the lazy half (remoteSession.ts).

import { Logger } from "@spicy3d/core";
import { ensureAgentBadge } from "./agentBadge";
import { forgetPairingDecisions } from "./pairing";
import { type RemoteMcpLink, type RemoteMcpStatus, remoteMcpState } from "./remoteState";
import { loadMcpSettings, type McpSettings, saveMcpSettings } from "./settings";

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
    // Signed out, or straight to another user: no Allow of the previous link outlives it (CLOUD-17).
    // Forgotten now and again once the old session is closed (its gate could still save a decision).
    if (previous) forgetPairingDecisions();
    if (!link) {
        if (previous) {
            void loadController().then((c) => {
                c.disconnectMcpRemote("unavailable");
                forgetPairingDecisions();
            });
        }
        return;
    }
    if (loadMcpSettings().remoteEnabled) connectRemote(link);
    else remoteMcpState.update({ status: "idle" });
}

/**
 * Called by the cloud module while its server offers the relay but nobody is signed in, with what
 * opens its sign-in dialog (the panel's Sign in button); `undefined` otherwise.
 */
export function setRemoteMcpSignIn(signIn: (() => void) | undefined): void {
    if (remoteMcpState.current.signIn !== signIn) remoteMcpState.update({ signIn });
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

/** The agent runs on the machine this browser runs on, so the browser's OS is the agent's. */
export function isWindowsClient(): boolean {
    return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * Claude Code over Streamable HTTP. The token comes from the `SPICY3D_TOKEN` variable the shell
 * expands, so it never lands in the shell history.
 */
export function remoteClaudeCodeCommand(endpoint: string, windows = isWindowsClient()): string {
    const variable = windows ? "$env:SPICY3D_TOKEN" : "$SPICY3D_TOKEN";
    return `claude mcp add --transport http spicy3d ${endpoint} --header "Authorization: Bearer ${variable}"`;
}

/** Cursor, VS Code (under "servers") and other clients that speak Streamable HTTP. */
export function remoteJsonConfig(endpoint: string, token = TOKEN_PLACEHOLDER): string {
    const server = { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } };
    return JSON.stringify({ mcpServers: { spicy3d: server } }, null, 2);
}

/** Every config for `endpoint`, in the order the panel and the token dialog show them. */
export function remoteClientConfigs(
    endpoint: string,
    token = TOKEN_PLACEHOLDER,
): { kind: "claudeCode" | "http"; text: string }[] {
    return [
        { kind: "claudeCode", text: remoteClaudeCodeCommand(endpoint) },
        { kind: "http", text: remoteJsonConfig(endpoint, token) },
    ];
}
