// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PerformanceTrace } from "@spicy3d/core/src/performanceTrace";
import type { WorkerNativeEvent } from "./workerProtocol";

interface IProfileClient {
    readonly pendingRequests: number;
    readonly pendingNative: number;
    drain(): Promise<void>;
}

/** Cumulative profiled work only. A reset requires a disabled, drained capture and changes the epoch. */
export const workerProfile = new (class {
    private readonly clients = new Set<IProfileClient>();
    private readonly page = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    private resetId = 0;
    private mode: "main" | "hybrid" = "main";
    private telemetryComplete = true;
    private booleanCount = 0;
    private historyCount = 0;
    private meshCount = 0;
    private meshBufferCount = 0;
    private dropped = 0;

    install(hybrid: boolean): void {
        this.mode = hybrid ? "hybrid" : "main";
        Object.assign(globalThis, {
            Spicy3DWorkerProfile: {
                settled: () => this.settled(),
                snapshot: () => this.snapshot(),
                reset: () => this.reset(),
            },
        });
    }

    add(client: IProfileClient): void {
        this.clients.add(client);
    }
    remove(client: IProfileClient, incomplete: boolean): void {
        this.clients.delete(client);
        if (incomplete) this.telemetryComplete = false;
    }

    record(events: WorkerNativeEvent[] | undefined, capture: number): void {
        if (!events?.length) return;
        const current = capture === PerformanceTrace.captureId;
        for (const event of events) {
            if (event.stage === "worker.kernel.operation" && event.details.boolean) this.booleanCount++;
            else if (event.stage === "worker.kernel.historyConversion") this.historyCount++;
            else if (event.stage === "worker.mesh.kernel") this.meshCount++;
            else if (event.stage === "worker.mesh.buffers") this.meshBufferCount++;
            if (current) PerformanceTrace.record(event.stage, event.started, event.durationMs, event.details);
        }
        if (!current) {
            // Never attribute a late reply to a newer capture (or silently lose its executed work).
            this.dropped += events.length;
            this.telemetryComplete = false;
        }
    }

    private async settled(): Promise<void> {
        await Promise.all([...this.clients].map((client) => client.drain()));
    }

    snapshot() {
        return {
            schemaVersion: 1,
            mode: this.mode,
            epoch: `${this.page}:${this.resetId}`,
            telemetryComplete: this.telemetryComplete,
            dropped: this.dropped,
            pendingRequests: [...this.clients].reduce((sum, client) => sum + client.pendingRequests, 0),
            pendingNative: [...this.clients].reduce((sum, client) => sum + client.pendingNative, 0),
            booleanCount: this.booleanCount,
            historyCount: this.historyCount,
            meshCount: this.meshCount,
            meshBufferCount: this.meshBufferCount,
        };
    }

    reset(): boolean {
        if (PerformanceTrace.enabled) return false;
        for (const client of this.clients) if (client.pendingNative > 0) return false;
        this.resetId++;
        this.telemetryComplete = true;
        this.dropped = 0;
        this.booleanCount = this.historyCount = this.meshCount = this.meshBufferCount = 0;
        return true;
    }
})();
