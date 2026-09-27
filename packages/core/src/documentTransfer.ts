// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "./application";
import type { IDocument } from "./document";
import {
    type DocumentMeta,
    type DocumentRepositoryError,
    type IDocumentRepository,
    Id,
    Logger,
    Result,
    type SaveOutcome,
} from "./foundation";

export interface TransferOptions {
    /** Keep the document where it was too (a copy) instead of moving it. */
    keepSource: boolean;
}

/** The view image of an open document, when one of its views can render (for the thumbnail). */
export function documentThumbnail(app: IApplication, document: IDocument): string | undefined {
    const view =
        app.activeView?.document === document
            ? app.activeView
            : app.views.find((x) => x.document === document);
    return view?.toImage();
}

/**
 * Moves (or copies) a listed document to `target`, keeping its id: "Save to cloud" of a local
 * document, "Move to this device" of a cloud one. An open document is saved from memory (its
 * unsaved changes included) and from then on saves to `target`; otherwise the stored data is copied.
 * The source copy is removed only once the target saved it.
 */
export async function transferDocument(
    app: IApplication,
    meta: DocumentMeta,
    target: IDocumentRepository,
    options: TransferOptions,
): Promise<Result<SaveOutcome, DocumentRepositoryError>> {
    const source = app.repositories.get(meta.location);
    if (!source) return Result.err({ kind: "unauthorized" });
    const open = [...app.documents].find((x) => x.id === meta.id && x.repository === source);

    let saved: Result<SaveOutcome, DocumentRepositoryError>;
    if (open) {
        const previous = { repository: open.repository, version: open.version };
        open.repository = target;
        open.version = undefined;
        saved = await open.save("manual");
        if (!saved.isOk || saved.value.status !== "saved") {
            open.repository = previous.repository;
            open.version = previous.version;
        }
    } else {
        const loaded = await source.load(meta.id);
        if (!loaded.isOk) return Result.err(loaded.error);
        saved = await target.save({
            id: meta.id,
            name: meta.name,
            data: loaded.value.data,
            kind: "manual",
            thumbnail: meta.thumbnail,
        });
    }
    if (!saved.isOk || saved.value.status !== "saved" || options.keepSource) return saved;

    const removed = await source.delete(meta.id);
    if (!removed.isOk) {
        Logger.warn(`document: moved ${meta.id}, but removing the source failed (${removed.error.kind})`);
    }
    return saved;
}

/** A copy of an open document under a new id, saved to `target`; resolves the copy's id. */
export async function saveDocumentCopy(
    app: IApplication,
    document: IDocument,
    target: IDocumentRepository,
    name: string = document.name,
): Promise<Result<{ id: string; outcome: SaveOutcome }, DocumentRepositoryError>> {
    const id = Id.generate();
    const saved = await target.save({
        id,
        name,
        data: { ...document.serialize(), id, name },
        kind: "manual",
        thumbnail: documentThumbnail(app, document),
    });
    return saved.isOk ? Result.ok({ id, outcome: saved.value }) : Result.err(saved.error);
}
