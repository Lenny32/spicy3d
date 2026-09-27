// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentPage,
    type DocumentRepositoryError,
    type IDocument,
    type IDocumentRepository,
    type LoadedDocument,
    Result,
    type SaveOutcome,
} from "@spicy3d/core";

const REFUSED: DocumentRepositoryError = { kind: "readOnly", reason: "preview" };

/**
 * Where the live preview of a merge being resolved "lives": nowhere, like a history preview — it
 * is read-only (autosave skips it), refuses every save and knows no documents, so the preview can
 * never be pushed or overwrite anything. It remembers which cloud document it previews.
 */
export class MergePreviewRepository implements IDocumentRepository {
    readonly kind = "cloud";

    constructor(readonly documentId: string) {}

    isReadOnly(): boolean {
        return true;
    }

    async list(): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        return Result.ok({ items: [] });
    }

    async load(id: string): Promise<Result<LoadedDocument, DocumentRepositoryError>> {
        return Result.err({ kind: "notFound", id });
    }

    async save(): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        return Result.err(REFUSED);
    }

    async delete(): Promise<Result<void, DocumentRepositoryError>> {
        return Result.err(REFUSED);
    }
}

/** The merge preview `document` is, if it is one. */
export function mergePreviewOf(document: IDocument | undefined): MergePreviewRepository | undefined {
    const repository = document?.repository;
    return repository instanceof MergePreviewRepository ? repository : undefined;
}
