// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { telemetryMessage, telemetryStack } from "./telemetryPrivacy";

/**
 * The few operations traced (never every function). A name is all a span carries besides its
 * duration and outcome: no file names, model data or values.
 */
export type TelemetryOperation =
    | "document.open"
    | "document.save"
    | "file.import"
    | "file.export"
    | "body.rebuild";

export type TelemetryLogLevel = "warn" | "error";
export type TelemetryLogSource = "logger" | "uncaught" | "promise" | "app";

/** One log record, redacted by `Telemetry.log` (`telemetryMessage`/`telemetryStack`). */
export interface TelemetryLogRecord {
    readonly level: TelemetryLogLevel;
    readonly source: TelemetryLogSource;
    readonly message: string;
    readonly stack?: string;
    /** Epoch milliseconds. */
    readonly time: number;
}

/** One finished operation. Times are epoch milliseconds. */
export interface TelemetrySpanRecord {
    readonly name: TelemetryOperation;
    readonly start: number;
    readonly end: number;
    readonly failed: boolean;
}

/** Receives what is sent (the OTel exporters); attached only while telemetry is active. */
export interface ITelemetrySink {
    log(record: TelemetryLogRecord): void;
    span(record: TelemetrySpanRecord): void;
}

/** A started operation; `end` records it once (later calls are ignored). */
export interface TelemetrySpan {
    end(failed?: boolean): void;
}

const NO_SPAN: TelemetrySpan = { end: () => {} };

function now(): number {
    return performance.timeOrigin + performance.now();
}

/**
 * The app's side of the optional telemetry. Without a sink (telemetry off, the default) every call
 * is a no-op without clock reads; a sink is attached by `TelemetryController` once the user turned
 * telemetry on with a collector URL.
 */
export class Telemetry {
    private static sink: ITelemetrySink | undefined;

    static get active(): boolean {
        return Telemetry.sink !== undefined;
    }

    /** Attaches `sink` (replacing any other); returns the detach function. */
    static attach(sink: ITelemetrySink): () => void {
        Telemetry.sink = sink;
        return () => {
            if (Telemetry.sink === sink) Telemetry.sink = undefined;
        };
    }

    /** Sends `record` with its text redacted: what leaves the browser always goes through here. */
    static log(record: Omit<TelemetryLogRecord, "time">): void {
        const sink = Telemetry.sink;
        if (!sink) return;
        try {
            sink.log({
                level: record.level,
                source: record.source,
                message: telemetryMessage(record.message),
                stack: record.stack ? telemetryStack(record.stack) : undefined,
                time: Date.now(),
            });
        } catch {
            // Telemetry never breaks the app.
        }
    }

    /** Starts `name`; the span is recorded when ended, if telemetry is still on then. */
    static start(name: TelemetryOperation): TelemetrySpan {
        if (!Telemetry.sink) return NO_SPAN;
        const start = now();
        let ended = false;
        return {
            end: (failed = false) => {
                if (ended) return;
                ended = true;
                const sink = Telemetry.sink;
                if (!sink) return;
                try {
                    sink.span({ name, start, end: now(), failed });
                } catch {
                    // Telemetry never breaks the app.
                }
            },
        };
    }

    /** Runs `run` inside a span `name`; a throw or rejection marks it failed and is rethrown. */
    static async trace<T>(name: TelemetryOperation, run: () => Promise<T>): Promise<T> {
        const span = Telemetry.start(name);
        try {
            const result = await run();
            span.end(isFailedResult(result));
            return result;
        } catch (error) {
            span.end(true);
            throw error;
        }
    }
}

/** A `Result` that is an error (duck-typed, so any `Result` from the app counts). */
function isFailedResult(value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { isOk?: unknown }).isOk === false;
}
