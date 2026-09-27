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
import type { CloudVersion } from "../documents/repository";

const REFUSED: DocumentRepositoryError = { kind: "readOnly", reason: "preview" };

/**
 * Where a version previewed from the history "lives": nowhere. It is read-only (autosave skips it),
 * refuses every save (Ctrl+S answers "an older version, restore it or save it as a new document"),
 * and knows no documents — so a preview can never overwrite the head. It remembers which document
 * and version it shows.
 */
export class VersionPreviewRepository implements IDocumentRepository {
    readonly kind = "cloud";

    constructor(
        /** The cloud document the version belongs to. */
        readonly documentId: string,
        readonly version: CloudVersion,
    ) {}

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

/** The preview of a history version, when `document` is one. */
export function previewOf(document: IDocument | undefined): VersionPreviewRepository | undefined {
    const repository = document?.repository;
    return repository instanceof VersionPreviewRepository ? repository : undefined;
}
