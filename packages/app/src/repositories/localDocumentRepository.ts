// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Constants,
    type DocumentListQuery,
    type DocumentMeta,
    type DocumentPage,
    type DocumentRepositoryError,
    type IDocumentRepository,
    type IStorage,
    type LoadedDocument,
    type RecentDocumentDTO,
    Result,
    type SaveOutcome,
    type SaveRequest,
    type Serialized,
    type StoredDocumentInfo,
} from "@spicy3d/core";

const DEFAULT_PAGE_SIZE = 50;
/** Stops reading if a storage keeps returning pages (it never should). */
const MAX_STORAGE_PAGES = 10_000;

/**
 * Documents in the browser's IndexedDB (`spicy3d-db`): the serialized document in the
 * `documents` table, its listing entry (name, date, thumbnail) in `recents`. The only code
 * that touches document storage directly.
 */
export class LocalDocumentRepository implements IDocumentRepository {
    readonly kind = "local";

    constructor(
        readonly storage: IStorage,
        private readonly now: () => number = Date.now,
    ) {}

    async list(query: DocumentListQuery = {}): Promise<Result<DocumentPage, DocumentRepositoryError>> {
        return this.attempt(async () => {
            const search = query.search?.trim().toLowerCase();
            const all = (await this.readAllRecents())
                .filter((x) => !search || x.name.toLowerCase().includes(search))
                .sort((a, b) => b.date - a.date);
            const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
            const limit = Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE);
            const items = all.slice(offset, offset + limit).map(toMeta);
            const next = offset + limit;
            return Result.ok(next < all.length ? { items, nextCursor: String(next) } : { items });
        });
    }

    async load(id: string): Promise<Result<LoadedDocument, DocumentRepositoryError>> {
        return this.attempt(async () => {
            const data = (await this.storage.get(Constants.DBName, Constants.DocumentTable, id)) as
                | Serialized
                | undefined;
            return data === undefined ? Result.err({ kind: "notFound", id }) : Result.ok({ data });
        });
    }

    async save(request: SaveRequest): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
        return this.attempt(async () => {
            const updatedAt = this.now();
            await this.storage.put(Constants.DBName, Constants.DocumentTable, request.id, request.data);
            const recent: RecentDocumentDTO = {
                id: request.id,
                name: request.name,
                date: updatedAt,
                image: request.thumbnail ?? "",
            };
            await this.storage.put(Constants.DBName, Constants.RecentTable, request.id, recent);
            return Result.ok({ status: "saved", updatedAt });
        });
    }

    async stat(id: string): Promise<Result<StoredDocumentInfo | undefined, DocumentRepositoryError>> {
        return this.attempt(async () => {
            const recent = (await this.storage.get(Constants.DBName, Constants.RecentTable, id)) as
                | RecentDocumentDTO
                | undefined;
            if (recent) return Result.ok({ name: recent.name });
            const data = await this.storage.get(Constants.DBName, Constants.DocumentTable, id);
            return Result.ok(data === undefined ? undefined : { name: (data as Serialized)["name"] });
        });
    }

    async delete(id: string): Promise<Result<void, DocumentRepositoryError>> {
        return this.attempt(async () => {
            await Promise.all([
                this.storage.delete(Constants.DBName, Constants.DocumentTable, id),
                this.storage.delete(Constants.DBName, Constants.RecentTable, id),
            ]);
            return Result.ok(undefined);
        });
    }

    private async readAllRecents(): Promise<RecentDocumentDTO[]> {
        const all: RecentDocumentDTO[] = [];
        for (let page = 0; page < MAX_STORAGE_PAGES; page++) {
            const items: RecentDocumentDTO[] = await this.storage.page(
                Constants.DBName,
                Constants.RecentTable,
                page,
            );
            if (items.length === 0) break;
            all.push(...items);
        }
        return all;
    }

    private async attempt<T>(
        action: () => Promise<Result<T, DocumentRepositoryError>>,
    ): Promise<Result<T, DocumentRepositoryError>> {
        try {
            return await action();
        } catch (error) {
            return Result.err(toRepositoryError(error));
        }
    }
}

function toMeta(recent: RecentDocumentDTO): DocumentMeta {
    return {
        id: recent.id,
        name: recent.name,
        updatedAt: recent.date,
        thumbnail: recent.image || undefined,
        location: "local",
    };
}

function toRepositoryError(error: unknown): DocumentRepositoryError {
    // IndexedDB rejects with the request's error event; the DOMException is on its target.
    const cause = (error as { target?: { error?: unknown } } | undefined)?.target?.error ?? error;
    if (cause instanceof DOMException && cause.name === "QuotaExceededError") return { kind: "quota" };
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: "failed", message };
}
