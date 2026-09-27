// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free like settings.ts: the panel observes this store without loading the MCP SDK.

export type McpStatus = "connecting" | "connected" | "offline";
export type McpConnectionStatus = McpStatus | "idle";

export interface McpToolCallRecord {
    name: string;
    isError: boolean;
    time: number;
}

export interface McpStateSnapshot {
    status: McpConnectionStatus;
    /** The bridge the live session targets, token stripped; undefined while idle. */
    bridge?: string;
    calls: McpToolCallRecord[];
}

const MAX_CALLS = 8;

/** The live bridge session as the UI sees it; written by the controller, read by panel and badge. */
export class McpState {
    private snapshot: McpStateSnapshot = { status: "idle", calls: [] };
    private readonly listeners = new Set<(state: McpStateSnapshot) => void>();

    get current(): McpStateSnapshot {
        return this.snapshot;
    }

    /** Calls `listener` now and on every change; returns the unsubscribe. */
    subscribe(listener: (state: McpStateSnapshot) => void): () => void {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => this.listeners.delete(listener);
    }

    update(patch: Partial<McpStateSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const listener of this.listeners) listener(this.snapshot);
    }

    recordCall(name: string, isError: boolean): void {
        const calls = [{ name, isError, time: Date.now() }, ...this.snapshot.calls].slice(0, MAX_CALLS);
        this.update({ calls });
    }
}

export const mcpState = new McpState();
