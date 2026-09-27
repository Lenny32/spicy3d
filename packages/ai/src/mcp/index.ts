// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The lazily loaded half of MCP support: everything here pulls in the SDK. Import it with a
// dynamic import() only — settings.ts, state.ts, remote.ts and the panel are the eager, SDK-free half.

import { forgetPairingDecisions } from "./pairing";
import { RemoteMcpSession } from "./remoteSession";
import { type RemoteMcpLink, type RemoteMcpStatus, remoteMcpState } from "./remoteState";

export { RemoteMcpSession } from "./remoteSession";
export { createMcpServer } from "./server";
export { McpSession } from "./session";

let remote: RemoteMcpSession | undefined;

/**
 * Expose this tab to the user's MCP clients through the server's relay (`link.pageSocket`),
 * replacing a remote session already running.
 */
export function connectMcpRemote(link: RemoteMcpLink): void {
    if (remote?.link === link && !remote.stopped) return;
    const previous = remote;
    previous?.close();
    // Another link (another user): the closed session's decisions must not carry over (CLOUD-17).
    if (previous && previous.link !== link) forgetPairingDecisions();
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
