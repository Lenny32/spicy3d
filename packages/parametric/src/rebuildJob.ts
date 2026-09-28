// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AutosaveHolds, DocumentRebuilds, type IDocument, type IShape, type Result } from "@spicy3d/core";

/** A yield is BEFORE a kernel cache miss. Hits run through synchronously. */
export type RebuildSteps = Generator<number, Result<IShape>, void>;

/** Owns a suspended replay and its timer; cancellation runs the replay's disposal finally. */
export class RebuildJob {
    readonly settled: Promise<void>;
    private resolve!: () => void;
    private timer?: ReturnType<typeof setTimeout>;
    private done = false;
    private readonly release: () => void;
    private readonly releaseAutosave = AutosaveHolds.hold("rebuild");

    constructor(
        document: IDocument,
        private readonly steps: RebuildSteps,
        private readonly advance: () => IteratorResult<number, Result<IShape>>,
        private readonly complete: (result: Result<IShape>) => void,
        private readonly progress: (index: number) => void,
        private readonly failed: (error: unknown) => void,
        private readonly isCurrent: () => boolean,
        private readonly superseded: () => void,
    ) {
        this.settled = new Promise((resolve) => {
            this.resolve = resolve;
        });
        this.release = DocumentRebuilds.add(document, this);
    }

    start(index: number): void {
        this.progress(index);
        if (!this.done) this.timer = setTimeout(() => this.tick(), 0);
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
        while (!this.done) {
            clearTimeout(this.timer);
            this.tick();
        }
    }

    cancel(): void {
        if (this.done) return;
        try {
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
