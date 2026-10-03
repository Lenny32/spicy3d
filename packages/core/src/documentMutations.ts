// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import { History } from "./foundation/history";

export interface IDocumentMutationScope {
    /** Authority applies only to this synchronous turn, never across an await. */
    run<T>(action: () => T): T;
    release(): void;
    /** Work started under the scope can outlive it; such callbacks must check before `run`. */
    readonly released: boolean;
}

/** Runtime-only ownership while an atomic mutation yields to a worker. */
export class DocumentMutations {
    private static readonly owners = new WeakMap<IDocument, symbol>();
    private static readonly active = new WeakMap<IDocument, symbol>();
    private static readonly scopes = new WeakMap<IDocument, IDocumentMutationScope>();

    /** Capture explicit authority for resumed geometry callbacks during an owned write. */
    static captureScope(document: IDocument): IDocumentMutationScope | undefined {
        const owner = DocumentMutations.owners.get(document);
        return owner !== undefined && DocumentMutations.active.get(document) === owner
            ? DocumentMutations.scopes.get(document)
            : undefined;
    }

    static isHeld(document: IDocument): boolean {
        return DocumentMutations.owners.has(document);
    }

    static assertWritable(document: IDocument): void {
        const owner = DocumentMutations.owners.get(document);
        if (owner !== undefined && DocumentMutations.active.get(document) !== owner)
            throw new Error("A modeling program is running; wait for it to finish before editing");
    }

    static hold(document: IDocument): IDocumentMutationScope {
        if (DocumentMutations.owners.has(document)) throw new Error("A modeling program is already running");
        const owner = Symbol("document mutation");
        DocumentMutations.owners.set(document, owner);
        const releaseHistory = History.addMutationGuard(document.history, () =>
            DocumentMutations.assertWritable(document),
        );
        let released = false;
        const scope: IDocumentMutationScope = {
            run: <T>(action: () => T): T => {
                if (released) throw new Error("Document mutation scope was released");
                const previous = DocumentMutations.active.get(document);
                DocumentMutations.active.set(document, owner);
                try {
                    return action();
                } finally {
                    if (previous === undefined) DocumentMutations.active.delete(document);
                    else DocumentMutations.active.set(document, previous);
                }
            },
            get released() {
                return released;
            },
            release: () => {
                if (released) return;
                released = true;
                releaseHistory();
                DocumentMutations.owners.delete(document);
                DocumentMutations.scopes.delete(document);
            },
        };
        DocumentMutations.scopes.set(document, scope);
        return scope;
    }
}
