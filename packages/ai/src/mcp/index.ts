// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The lazily loaded half of MCP support: everything here pulls in the SDK. Import it with a
// dynamic import() only — settings.ts, state.ts and the panel are the eager, SDK-free half.

import { Logger, redactUrl } from "@spicy3d/core";
import { RemoteMcpSession } from "./remoteSession";
import { type RemoteMcpLink, type RemoteMcpStatus, remoteMcpState } from "./remoteState";
import { McpSession } from "./session";
import { parseBridgeUrl } from "./settings";
import { mcpState } from "./state";

export { RemoteMcpSession } from "./remoteSession";
export { createMcpServer } from "./server";
export { McpSession } from "./session";

let session: McpSession | undefined;

/** The bridge address as shown in the UI: the token is a secret and stays out of it. */
function displayUrl(url: URL): string {
    const base = `${url.protocol}//${url.host}${url.pathname}`;
    return url.searchParams.has("token") ? `${base}?token=•••` : base;
}

/**
 * Expose this tab as an MCP server through the local bridge at `rawUrl`, replacing any session
 * already running. Returns false when the URL is refused (not a ws:// loopback address).
 */
export function connectMcpBridge(rawUrl: string): boolean {
    const url = parseBridgeUrl(rawUrl);
    if (!url) {
        Logger.warn(
            `[mcp] refusing bridge ${redactUrl(rawUrl)}: only ws:// URLs on 127.0.0.1/localhost are accepted`,
        );
        return false;
    }
    disconnectMcpBridge();
    mcpState.update({ status: "connecting", bridge: displayUrl(url), calls: [] });
    session = new McpSession(url, {
        onStatus: (status) => mcpState.update({ status }),
        onToolCall: (name, isError) => mcpState.recordCall(name, isError),
    }).start();
    return true;
}

export function disconnectMcpBridge(): void {
    session?.close();
    session = undefined;
    mcpState.update({ status: "idle", bridge: undefined });
}

let remote: RemoteMcpSession | undefined;

/**
 * Expose this tab to the user's MCP clients through the server's relay (`link.pageSocket`),
 * replacing a remote session already running. Independent of the local bridge session.
 */
export function connectMcpRemote(link: RemoteMcpLink): void {
    if (remote?.link === link && !remote.stopped) return;
    remote?.close();
    remote = new RemoteMcpSession(link, { state: remoteMcpState }).start();
}

/** Leave the relay; `status` says why (`idle`: turned off, `unavailable`: signed out). */
export function disconnectMcpRemote(status: Extract<RemoteMcpStatus, "idle" | "unavailable">): void {
    remote?.close();
    remote = undefined;
    remoteMcpState.update({ status, agents: [], tabId: undefined });
}

export function disconnectRemoteAgent(agentId: string): void {
    remote?.disconnectAgent(agentId);
}
