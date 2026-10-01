// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AutosaveHolds, DocumentRebuilds, type IDocument, type IShape, type Result } from "@spicy3d/core";

/** A yield is BEFORE a kernel cache miss. Hits run through synchronously. */
export type RebuildPause =
    | number
    | { readonly ready: Promise<void>; readonly canFallback?: boolean; cancel(): void };
export type RebuildSteps = Generator<RebuildPause, Result<IShape>, void>;

/** Owns a suspended replay and its timer; cancellation runs the replay's disposal finally. */
export class RebuildJob {
    readonly settled: Promise<void>;
    featureIndex?: number;
    private resolve!: () => void;
    private timer?: ReturnType<typeof setTimeout>;
    private done = false;
    private waiting?: Exclude<RebuildPause, number>;
    private readonly release: () => void;
    private readonly releaseAutosave = AutosaveHolds.hold("rebuild");

    constructor(
        document: IDocument,
        private readonly steps: RebuildSteps,
        private readonly advance: () => IteratorResult<RebuildPause, Result<IShape>>,
        private readonly complete: (result: Result<IShape>) => void,
        private readonly progress: (index: number) => void,
        private readonly failed: (error: unknown) => void,
        private readonly isCurrent: () => boolean,
        private readonly superseded: () => void,
        private readonly forceSynchronous: () => void = () => {},
    ) {
        this.settled = new Promise((resolve) => {
            this.resolve = resolve;
        });
        this.release = DocumentRebuilds.add(document, this);
    }

    start(pause: RebuildPause): void {
        if (typeof pause === "number") {
            this.featureIndex = pause;
            this.progress(pause);
            if (!this.done) this.timer = setTimeout(() => this.tick(), 0);
        } else {
            this.waiting = pause;
            void pause.ready.then(
                () => {
                    if (this.done || this.waiting !== pause) return;
                    this.waiting = undefined;
                    this.tick();
                },
                (error) => {
                    if (this.done || this.waiting !== pause) return;
                    this.cancel();
                    this.failed(error);
                },
            );
        }
    }

    private tick(): void {
        if (this.done) return;
        try {
            if (!this.isCurrent()) {
                this.cancel();
                this.superseded();
                return;
            }
            const step = this.advance();
            if (step.done) {
                this.finish();
                this.complete(step.value);
            } else {
                this.start(step.value);
            }
        } catch (error) {
            this.cancel();
            this.failed(error);
        }
    }

    flush(): void {
        if (this.workerOnly) return;
        // Keep the generator's already-built prefix. Cancel only the in-flight operation, then
        // resume this same feature synchronously; later misses also stay local for this replay.
        this.forceSynchronous();
        this.waiting?.cancel();
        this.waiting = undefined;
        while (!this.done) {
            clearTimeout(this.timer);
            this.tick();
            if (this.workerOnly) return;
        }
    }

    private get workerOnly(): boolean {
        return this.waiting?.canFallback === false;
    }

    cancel(): void {
        if (this.done) return;
        try {
            this.waiting?.cancel();
            this.waiting = undefined;
            this.steps.return(undefined as never);
        } finally {
            this.finish();
        }
    }

    private finish(): void {
        this.done = true;
        clearTimeout(this.timer);
        this.release();
        this.releaseAutosave();
        this.resolve();
    }
}
