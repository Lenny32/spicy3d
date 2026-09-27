// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";

/**
 * Editing sessions open on a document (the sketch editor), so code about to replace the document's
 * content (a merge resolved or undone, CLOUD-13) can end them first — committing what they hold —
 * instead of swapping the nodes out from under them.
 */
export class EditSessions {
    private static readonly sessions = new Map<IDocument, Set<() => void>>();

    /** Registers a session of `document`; `end` closes it. Returns the unregister function. */
    static begin(document: IDocument, end: () => void): () => void {
        let set = EditSessions.sessions.get(document);
        if (!set) {
            set = new Set();
            EditSessions.sessions.set(document, set);
        }
        set.add(end);
        return () => {
            const current = EditSessions.sessions.get(document);
            if (!current?.delete(end)) return;
            if (current.size === 0) EditSessions.sessions.delete(document);
        };
    }

    static isActive(document: IDocument): boolean {
        return (EditSessions.sessions.get(document)?.size ?? 0) > 0;
    }

    /** Ends every session of `document` (each one commits and unregisters itself). */
    static endAll(document: IDocument): void {
        for (const end of [...(EditSessions.sessions.get(document) ?? [])]) end();
    }
}
