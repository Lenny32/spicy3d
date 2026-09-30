// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PerformanceTrace } from "@spicy3d/core/src/performanceTrace";
import { workerProfile } from "./workerProfile";
import type {
    KernelFailure,
    KernelMessage,
    KernelOperation,
    KernelOperations,
    KernelRequest,
    KernelResponse,
    KernelResult,
} from "./workerProtocol";

export interface IKernelWorkerTransport {
    postMessage(message: KernelMessage): void;
    addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
    removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
    terminate(): void;
}

type Pending = { complete: (result: KernelResult<unknown>) => void };

/** Explicitly async RPC. Handles belong to this session and must be released or the client disposed. */
export class KernelWorkerClient {
    private nextId = 0;
    private readonly pending = new Map<number, Pending>();
    private readonly native = new Set<number>();
    private readonly deadlines = new Map<number, ReturnType<typeof setTimeout>>();
    private captures?: Map<number, number>;
    private nativeFailure?: KernelFailure;
    private readonly failureHandlers = new Set<(failure: KernelFailure) => void>();
    get pendingRequests(): number {
        return this.pending.size;
    }
    get pendingNative(): number {
        return this.native.size;
    }
    private closed = false;
    private initialized = false;
    private readonly onMessage: EventListener = (event) => {
        const message: unknown = (event as MessageEvent).data;
        if (!isKernelResponse(message)) {
            this.close({ code: "kernel", message: "Invalid geometry worker response" });
            return;
        }
        if (message.type === "initialized") {
            this.initialized = true;
            return;
        }
        if (message.type === "fatal") {
            this.close({ code: message.code ?? "kernel", message: message.message });
            return;
        }
        this.initialized = true;
        if (!this.native.delete(message.id)) {
            this.close({ code: "kernel", message: "Unexpected geometry worker response id" });
            return;
        }
        const deadline = this.deadlines.get(message.id);
        if (deadline !== undefined) clearTimeout(deadline);
        this.deadlines.delete(message.id);
        // This precedes resolving promises, including for cancelled callers and profiling barriers.
        const capture = this.captures?.get(message.id);
        this.captures?.delete(message.id);
        if (capture !== undefined) workerProfile.record(message.events, capture);
        else if (message.events?.length) {
            this.close({ code: "kernel", message: "Unrequested geometry worker telemetry" });
            return;
        }
        const pending = this.pending.get(message.id);
        // Cancellation can race a completed native call. Its handles stay owned by the host until accepted.
        try {
            this.worker.postMessage({ type: pending ? "accept" : "cancel", id: message.id });
            pending?.complete(message.result);
            if (!message.result.ok) this.reportNativeFailure(message.result.error);
        } catch {
            this.onConnectionError();
        }
    };
    private readonly onError: EventListener = () =>
        this.close({
            code: this.initialized ? "kernel" : "unavailable",
            message: this.initialized
                ? "Geometry worker connection failed"
                : "Geometry worker initialization failed",
        });
    private readonly onConnectionError = () =>
        this.close({
            code: "kernel",
            message: "Geometry worker connection failed",
        });

    constructor(
        private readonly worker: IKernelWorkerTransport,
        private readonly deadlineMs = 90_000,
    ) {
        if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 90_000) {
            worker.terminate();
            throw new Error("Geometry worker deadline must be finite and between 1 and 90000 ms");
        }
        workerProfile.add(this);
        worker.addEventListener("message", this.onMessage);
        worker.addEventListener("error", this.onError);
        worker.addEventListener("messageerror", this.onConnectionError);
    }

    /** Includes failed late replies whose caller already cancelled; registration replays the latch. */
    addNativeFailureHandler(handler: (failure: KernelFailure) => void): () => void {
        if (this.nativeFailure) {
            handler(this.nativeFailure);
            return () => {};
        }
        this.failureHandlers.add(handler);
        return () => this.failureHandlers.delete(handler);
    }

    private reportNativeFailure(error: KernelFailure): void {
        if (error.code !== "kernel" || this.nativeFailure) return;
        this.nativeFailure = error;
        for (const handler of [...this.failureHandlers]) handler(error);
    }

    request<K extends KernelOperation>(
        operation: K,
        args: KernelOperations[K]["args"],
        signal?: AbortSignal,
    ): Promise<KernelResult<KernelOperations[K]["result"]>> {
        if (this.closed)
            return Promise.resolve({ ok: false, error: { code: "closed", message: "Worker closed" } });
        if (signal?.aborted) return Promise.resolve(this.cancelled());
        const id = ++this.nextId;
        const trace = PerformanceTrace.captureId;
        return new Promise((resolve) => {
            const deadline = setTimeout(
                () =>
                    this.close({
                        code: "timeout",
                        message: `Geometry worker operation timed out after ${this.deadlineMs} ms`,
                    }),
                this.deadlineMs,
            );
            const complete = (result: KernelResult<unknown>) => {
                signal?.removeEventListener("abort", cancel);
                this.pending.delete(id);
                resolve(result as KernelResult<KernelOperations[K]["result"]>);
            };
            const cancel = () => {
                complete(this.cancelled());
                try {
                    this.worker.postMessage({ type: "cancel", id });
                } catch {
                    this.onConnectionError();
                }
            };
            this.deadlines.set(id, deadline);
            this.pending.set(id, { complete });
            this.native.add(id);
            if (trace !== undefined) {
                this.captures ??= new Map();
                this.captures.set(id, trace);
            }
            signal?.addEventListener("abort", cancel, { once: true });
            try {
                this.worker.postMessage({ type: "request", id, operation, args, trace } as KernelRequest);
            } catch {
                this.onConnectionError();
            }
        });
    }

    private cancelled(): KernelResult<never> {
        return { ok: false, error: { code: "cancelled", message: "Worker request cancelled" } };
    }

    private close(error: KernelFailure): void {
        if (this.closed) return;
        this.closed = true;
        workerProfile.remove(this, (this.captures?.size ?? 0) > 0);
        this.captures?.clear();
        this.native.clear();
        for (const deadline of this.deadlines.values()) clearTimeout(deadline);
        this.deadlines.clear();
        this.worker.removeEventListener("message", this.onMessage);
        this.worker.removeEventListener("error", this.onError);
        this.worker.removeEventListener("messageerror", this.onConnectionError);
        this.worker.terminate();
        for (const pending of this.pending.values()) pending.complete({ ok: false, error });
        this.reportNativeFailure(error);
        this.failureHandlers.clear();
    }

    /** Terminates even an in-flight native call, releasing this worker's whole WASM heap. */
    dispose(): void {
        this.close({ code: "closed", message: "Worker closed" });
    }

    /** FIFO barrier also waits for cancelled-but-executing native work and its telemetry. */
    async drain(): Promise<void> {
        if (!this.closed) await this.request("ready", undefined);
    }
}

function isKernelResponse(value: unknown): value is KernelResponse {
    if (!value || typeof value !== "object" || !("type" in value)) return false;
    if (value.type === "initialized") return true;
    if (value.type === "fatal")
        return (
            "message" in value &&
            typeof value.message === "string" &&
            (!("code" in value) || value.code === "kernel" || value.code === "unavailable")
        );
    if (
        value.type !== "result" ||
        !("id" in value) ||
        !Number.isSafeInteger(value.id) ||
        typeof value.id !== "number" ||
        value.id <= 0 ||
        !("result" in value)
    )
        return false;
    if (
        "events" in value &&
        (!Array.isArray(value.events) ||
            !value.events.every(
                (event) =>
                    event &&
                    typeof event === "object" &&
                    [
                        "worker.kernel.operation",
                        "worker.kernel.historyConversion",
                        "worker.mesh.kernel",
                        "worker.mesh.buffers",
                        "worker.replica.import",
                        "worker.replica.verify",
                        "worker.replica.export",
                    ].includes(event.stage) &&
                    Number.isFinite(event.started) &&
                    Number.isFinite(event.durationMs) &&
                    event.durationMs >= 0 &&
                    event.details &&
                    typeof event.details.workerId === "string" &&
                    Number.isSafeInteger(event.details.eventId) &&
                    event.details.requestId === value.id &&
                    typeof event.details.boolean === "boolean",
            ))
    )
        return false;
    const result = value.result;
    if (!result || typeof result !== "object" || !("ok" in result)) return false;
    if (result.ok === true) return Object.hasOwn(result, "value");
    if (result.ok !== false || !("error" in result)) return false;
    const error = result.error;
    return (
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        ["cancelled", "closed", "kernel", "invalid", "unavailable", "timeout"].includes(error.code) &&
        "message" in error &&
        typeof error.message === "string"
    );
}
