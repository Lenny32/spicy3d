// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { WorkerKernel } from "./workerKernel";
import {
    type KernelHandle,
    type KernelMessage,
    type KernelRequest,
    type KernelResponse,
    kernelTransfers,
    type WorkerNativeEvent,
} from "./workerProtocol";

/** A task boundary between requests lets cancellation messages overtake queued native work. */
export class KernelWorkerHost {
    private readonly queue = new Map<number, KernelRequest>();
    private readonly unaccepted = new Map<number, KernelHandle[]>();
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;

    constructor(
        private readonly kernel: WorkerKernel,
        private readonly send: (response: KernelResponse, transfers: ArrayBuffer[]) => void,
    ) {}

    receive(message: KernelMessage): void {
        if (this.closed) return;
        if (message.type === "cancel") {
            const queued = this.queue.get(message.id);
            if (queued) {
                this.queue.delete(message.id);
                this.kernel.discardRequest(queued);
                this.send(
                    {
                        type: "result",
                        id: message.id,
                        result: {
                            ok: false,
                            error: { code: "cancelled", message: "Worker request cancelled" },
                        },
                    },
                    [],
                );
            }
            this.kernel.release(this.unaccepted.get(message.id) ?? []);
            this.unaccepted.delete(message.id);
        } else if (message.type === "accept") {
            this.unaccepted.delete(message.id);
        } else {
            this.queue.set(message.id, message);
            this.schedule();
        }
    }

    private schedule(): void {
        if (this.timer === undefined && this.queue.size) this.timer = setTimeout(() => this.run(), 0);
    }

    private run(): void {
        this.timer = undefined;
        const request = this.queue.values().next().value;
        if (!request || this.closed) return;
        this.queue.delete(request.id);
        const created: KernelHandle[] = [];
        let events: WorkerNativeEvent[] | undefined;
        try {
            const result = this.kernel.execute(request, created);
            if (result.ok) {
                if (created.length) this.unaccepted.set(request.id, created);
            } else this.kernel.release(created);
            events = this.kernel.takeEvents();
            this.send(
                { type: "result", id: request.id, result, ...(events && { events }) },
                kernelTransfers(result),
            );
        } catch (error) {
            if (error instanceof WebAssembly.RuntimeError) {
                // A trap can leave native ownership/allocator state inconsistent. Do not call into
                // the heap again, even to delete handles. The client terminates the entire worker.
                this.closed = true;
                this.queue.clear();
                this.unaccepted.clear();
                this.send({ type: "fatal", message: "Geometry worker native runtime failed" }, []);
                return;
            }
            this.kernel.release(created);
            this.unaccepted.delete(request.id);
            // If sending the successful reply failed, its native timings were already drained.
            // Preserve them on the error reply instead of silently reporting zero executed work.
            events ??= this.kernel.takeEvents();
            // No arbitrary native error text / document content crosses the logging boundary.
            this.send(
                {
                    type: "result",
                    id: request.id,
                    result: {
                        ok: false,
                        error: { code: "kernel", message: `Worker operation failed: ${request.operation}` },
                    },
                    ...(events && { events }),
                },
                [],
            );
        }
        this.schedule();
    }

    dispose(): void {
        this.closed = true;
        clearTimeout(this.timer);
        this.queue.clear();
        this.unaccepted.clear();
        this.kernel.dispose();
    }
}
