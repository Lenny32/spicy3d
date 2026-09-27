// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The lazily loaded half of MCP support: everything here pulls in the SDK. Import it with a
// dynamic import() only — settings.ts, state.ts and the panel are the eager, SDK-free half.

import { Logger } from "@spicy3d/core";
import { McpSession } from "./session";
import { parseBridgeUrl } from "./settings";
import { mcpState } from "./state";

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
        Logger.warn(`[mcp] refusing bridge ${rawUrl}: only ws:// URLs on 127.0.0.1/localhost are accepted`);
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
