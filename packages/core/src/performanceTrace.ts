// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Runtime-only profiling. Never stores model payloads, names, URLs or kernel handles. */
export type PerformanceDetails = {
    [key: string]: string | number | boolean | undefined;
};

export interface PerformanceSpan {
    readonly generation: number;
    readonly stage: string;
    readonly started: number;
    readonly details?: PerformanceDetails;
}

export interface PerformanceRecord {
    stage: string;
    started: number;
    durationMs: number;
    details?: PerformanceDetails;
}

/**
 * Explicitly opt in with `PerformanceTrace.enable()`. Call sites guard begin/end AND metadata
 * construction with `enabled`: the disabled path performs no clock reads or allocations.
 * Durations are inclusive, not additive across stages. Async spans use explicit tokens, never
 * a global stack, so interleaving jobs cannot acquire another job's parent/context.
 */
export class PerformanceTrace {
    private static active = false;
    private static generation = 0;
    private static limit = 100_000;
    private static records: PerformanceRecord[] | undefined;
    private static owners: WeakMap<object, PerformanceDetails> | undefined;
    private static dropped = 0;

    static get enabled(): boolean {
        return PerformanceTrace.active;
    }

    /** A fresh bounded capture; stale spans from a previous capture are ignored. */
    static enable(maxRecords = 100_000): void {
        PerformanceTrace.generation++;
        PerformanceTrace.limit = Number.isFinite(maxRecords) ? Math.max(1, Math.floor(maxRecords)) : 100_000;
        PerformanceTrace.records = [];
        PerformanceTrace.owners = new WeakMap();
        PerformanceTrace.dropped = 0;
        PerformanceTrace.active = true;
    }

    /** Retains the capture for snapshot(); releases shape ownership metadata. */
    static disable(): void {
        PerformanceTrace.active = false;
        PerformanceTrace.owners = undefined;
    }

    static begin(stage: string, details?: PerformanceDetails): PerformanceSpan | undefined {
        if (!PerformanceTrace.active) return undefined;
        return { generation: PerformanceTrace.generation, stage, started: performance.now(), details };
    }

    static end(span: PerformanceSpan | undefined, details?: PerformanceDetails): void {
        if (!PerformanceTrace.active || span === undefined || span.generation !== PerformanceTrace.generation)
            return;
        PerformanceTrace.record(
            span.stage,
            span.started,
            performance.now() - span.started,
            details === undefined ? span.details : { ...span.details, ...details },
        );
    }

    /** For external observers (event-loop gaps, long tasks, memory samples). Times are milliseconds. */
    static record(stage: string, started: number, durationMs: number, details?: PerformanceDetails): void {
        if (!PerformanceTrace.active) return;
        if (PerformanceTrace.records!.length >= PerformanceTrace.limit) {
            PerformanceTrace.dropped++;
            return;
        }
        PerformanceTrace.records!.push({ stage, started, durationMs, details });
    }

    /** Tag immediately before visual mesh access; never forces shape evaluation or meshing. */
    static tagShape(shape: object, details: PerformanceDetails): void {
        if (PerformanceTrace.active) PerformanceTrace.owners!.set(shape, details);
    }

    static shapeDetails(shape: object): PerformanceDetails | undefined {
        return PerformanceTrace.owners?.get(shape);
    }

    /** Copies records so a consumer cannot mutate the retained evidence. */
    static snapshot(): { records: PerformanceRecord[]; dropped: number } {
        return {
            records: (PerformanceTrace.records ?? []).map((record) => ({
                ...record,
                ...(record.details && { details: { ...record.details } }),
            })),
            dropped: PerformanceTrace.dropped,
        };
    }
}
