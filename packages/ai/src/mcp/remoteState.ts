// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free: remote MCP's state as the panel and the agent badge see it (see remote.ts).

import { type McpToolCallRecord, SnapshotStore } from "./state";

/** What the cloud module provides while a signed-in user can reach the relay (SRV-09). */
export interface RemoteMcpLink {
    /** Streamable HTTP endpoint MCP clients connect to (`/api/config.mcp.endpoint`). */
    endpoint: string;
    /** The WebSocket this tab connects to (`/api/config.mcp.pageSocket`), same-origin cookie auth. */
    pageSocket: string;
    /** Who is signed in, shown in the panel. */
    userName: string;
    /** This device's name as the account settings define it, reported to the relay. */
    deviceName(): string;
    /** Opens the "create access token" dialog, MCP scopes preselected; its last step shows the configs. */
    createToken(): void;
}

/** `unavailable`: no link (signed out, no server or relay disabled); `idle`: the user turned it off. */
export type RemoteMcpStatus = "unavailable" | "idle" | "connecting" | "connected" | "offline";

/** An MCP session bound to this tab (`notifications/spicy3d/agents`). */
export interface RemoteAgent {
    id: string;
    clientName: string;
    clientVersion?: string;
    tokenName?: string;
    /** The user's answer to the pairing prompt, once given. */
    pairing?: "allow" | "deny";
}

export interface RemoteMcpSnapshot {
    link?: RemoteMcpLink;
    status: RemoteMcpStatus;
    /** The relay's id for this tab (`notifications/spicy3d/welcome`). */
    tabId?: string;
    /** The sessions whose calls come to this tab: this tab is their target. */
    agents: RemoteAgent[];
    calls: McpToolCallRecord[];
}

export class RemoteMcpState extends SnapshotStore<RemoteMcpSnapshot> {
    constructor() {
        super({ status: "unavailable", agents: [], calls: [] });
    }
}

export const remoteMcpState = new RemoteMcpState();
