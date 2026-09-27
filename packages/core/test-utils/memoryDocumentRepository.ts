// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentMeta,
    type DocumentPage,
    type DocumentRepositoryError,
    type IDocumentRepository,
    type LoadedDocument,
    Result,
    type SaveOutcome,
    type SaveRequest,
} from "../src";

/** An in-memory `IDocumentRepository` that records every save, for tests. */
export class MemoryDocumentRepository implements IDocumentRepository {
    readonly kind = "local";
    readonly saves: SaveRequest[] = [];
    readonly documents = new Map<string, SaveRequest>();
    /** When set, every operation fails with it. */
    failWith: DocumentRepositoryError | undefined;

    async list(): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        if (this.failWith) return Result.err(this.failWith);
        const items: DocumentMeta[] = [...this.documents.values()].map((x) => ({
            id: x.id,
            name: x.name,
            updatedAt: 0,
            thumbnail: x.thumbnail,
            location: "local",
        }));
        return Result.ok({ items });
    }

    async load(id: string): Promise<Result<LoadedDocument, DocumentRepositoryError>> {
        if (this.failWith) return Result.err(this.failWith);
        const stored = this.documents.get(id);
        return stored ? Result.ok({ data: stored.data }) : Result.err({ kind: "notFound", id });
    }

    async save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        if (this.failWith) return Result.err(this.failWith);
        this.saves.push(request);
        this.documents.set(request.id, request);
        return Result.ok({ status: "saved", updatedAt: this.saves.length });
    }

    async delete(id: string): Promise<Result<void, DocumentRepositoryError>> {
        if (this.failWith) return Result.err(this.failWith);
        this.documents.delete(id);
        return Result.ok(undefined);
    }
}
