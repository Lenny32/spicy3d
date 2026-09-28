// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";

/** Runtime-only geometry work. Synchronous consumers use flush; load/save await settled. */
export interface IDocumentRebuild {
    readonly settled: Promise<void>;
    flush(): void;
}

export class DocumentRebuilds {
    private static readonly jobs = new WeakMap<IDocument, Set<IDocumentRebuild>>();
    private static readonly revisions = new WeakMap<IDocument, number>();

    /** Includes writes inside an open transaction, before the undo position changes. */
    static edited(document: IDocument): void {
        DocumentRebuilds.revisions.set(document, DocumentRebuilds.revision(document) + 1);
    }

    static revision(document: IDocument): number {
        return DocumentRebuilds.revisions.get(document) ?? 0;
    }

    static pending(document: IDocument): boolean {
        return (DocumentRebuilds.jobs.get(document)?.size ?? 0) > 0;
    }

    static add(document: IDocument, job: IDocumentRebuild): () => void {
        let jobs = DocumentRebuilds.jobs.get(document);
        if (!jobs) {
            jobs = new Set();
            DocumentRebuilds.jobs.set(document, jobs);
        }
        jobs.add(job);
        return () => jobs.delete(job);
    }

    static flush(document: IDocument): void {
        // Completing a source can enqueue its dependents.
        const jobs = DocumentRebuilds.jobs.get(document);
        while (jobs?.size) {
            for (const job of [...jobs]) job.flush();
        }
    }

    static async settled(document: IDocument): Promise<void> {
        const jobs = DocumentRebuilds.jobs.get(document);
        while (jobs?.size) {
            await Promise.all([...jobs].map((job) => job.settled));
        }
    }
}
