// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// SDK-free like settings.ts: the panel observes these stores without loading the MCP SDK.

export type McpStatus = "connecting" | "connected" | "offline";

export interface McpToolCallRecord {
    name: string;
    isError: boolean;
    time: number;
}

const MAX_CALLS = 8;

/** A snapshot store: listeners get the whole state now and after every change. */
export class SnapshotStore<T extends { calls: McpToolCallRecord[] }> {
    private snapshot: T;
    private readonly listeners = new Set<(state: T) => void>();

    constructor(initial: T) {
        this.snapshot = initial;
    }

    get current(): T {
        return this.snapshot;
    }

    /** Calls `listener` now and on every change; returns the unsubscribe. */
    subscribe(listener: (state: T) => void): () => void {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => this.listeners.delete(listener);
    }

    update(patch: Partial<T>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const listener of this.listeners) listener(this.snapshot);
    }

    recordCall(name: string, isError: boolean): void {
        const calls = [{ name, isError, time: Date.now() }, ...this.snapshot.calls].slice(0, MAX_CALLS);
        this.update({ calls } as Partial<T>);
    }
}
