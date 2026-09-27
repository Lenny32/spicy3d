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
    PubSub,
    Result,
    type SaveOutcome,
    type StoredDocumentInfo,
} from "./foundation";
import type { Serialized } from "./serialize";
import { DOCUMENT_THUMBNAIL_MAX_SIZE } from "./visual/view";

/** What to do when the target already has a document with the id being moved. */
export type ExistingDocumentChoice = "replace" | "keepBoth" | "cancel";

export interface ExistingDocument {
    /** The name of the document already there (the moved one's when unknown). */
    name: string;
    /** `false` while a document with that id is open: replacing is then not offered. */
    canReplace: boolean;
}

export interface TransferOptions {
    /** Keep the document where it was too: the copy then gets a new id. */
    keepSource: boolean;
    /**
     * Asked when the target already has a document with the id (e.g. a copy kept earlier) or one
     * with it is open. Without it, both are kept (the moved one gets a new id): never overwritten.
     */
    resolveExisting?: (existing: ExistingDocument) => Promise<ExistingDocumentChoice>;
}

export type TransferOutcome = SaveOutcome | { status: "cancelled" };

/** The view image of an open document, when one of its views can render (for the thumbnail). */
export function documentThumbnail(app: IApplication, document: IDocument): string | undefined {
    const view =
        app.activeView?.document === document
            ? app.activeView
            : app.views.find((x) => x.document === document);
    return view?.toImage(DOCUMENT_THUMBNAIL_MAX_SIZE);
}

async function existingIn(
    target: IDocumentRepository,
    id: string,
): Promise<Result<StoredDocumentInfo | undefined, DocumentRepositoryError>> {
    if (target.stat) return target.stat(id);
    const loaded = await target.load(id);
    if (loaded.isOk) return Result.ok({ name: loaded.value.data["name"], version: loaded.value.version });
    return loaded.error.kind === "notFound" ? Result.ok(undefined) : Result.err(loaded.error);
}

/**
 * Moves (or copies) a listed document to `target`: "Save to cloud" of a local document, "Move to
 * this device" of a cloud one. A move keeps the id, unless the target already has a document with
 * it (or one with it is open) and the user keeps both; a copy always gets a new id, so the two
 * never overwrite each other. An open document is saved from memory (its unsaved changes
 * included) and from then on saves to `target` (`documentRepositoryChanged` tells who holds edit
 * locks). The source copy is removed only once the target saved it.
 */
export async function transferDocument(
    app: IApplication,
    meta: DocumentMeta,
    target: IDocumentRepository,
    options: TransferOptions,
): Promise<Result<TransferOutcome, DocumentRepositoryError>> {
    const source = app.repositories.get(meta.location);
    if (!source) return Result.err({ kind: "unauthorized" });
    const open = [...app.documents].find((x) => x.id === meta.id && x.repository === source);
    const openElsewhere = [...app.documents].some((x) => x.id === meta.id && x !== open);

    let id = meta.id;
    let base: string | undefined;
    if (options.keepSource) {
        id = Id.generate();
    } else {
        const existing = await existingIn(target, meta.id);
        if (!existing.isOk) return Result.err(existing.error);
        if (existing.value || openElsewhere) {
            const canReplace = !openElsewhere;
            const asked = options.resolveExisting
                ? await options.resolveExisting({ name: existing.value?.name ?? meta.name, canReplace })
                : "keepBoth";
            if (asked === "cancel") return Result.ok({ status: "cancelled" });
            if (asked === "replace" && canReplace && existing.value) {
                base = existing.value.version;
                if (existing.value.trashed && target.restore) {
                    const restored = await target.restore(meta.id);
                    if (!restored.isOk) return Result.err(restored.error);
                }
            } else {
                id = Id.generate();
            }
        }
    }

    let saved: Result<SaveOutcome, DocumentRepositoryError>;
    if (open && id === meta.id) {
        const previous = { repository: open.repository, version: open.version };
        open.repository = target;
        open.version = base;
        saved = await open.save("manual");
        if (!saved.isOk || saved.value.status !== "saved") {
            open.repository = previous.repository;
            open.version = previous.version;
        } else {
            PubSub.default.pub("documentRepositoryChanged", open, previous.repository);
        }
    } else {
        let data: Serialized;
        if (open) {
            data = open.serialize();
        } else {
            const loaded = await source.load(meta.id);
            if (!loaded.isOk) return Result.err(loaded.error);
            data = loaded.value.data;
        }
        saved = await target.save({
            id,
            name: meta.name,
            data: { ...data, id, name: meta.name },
            kind: "manual",
            thumbnail: open ? documentThumbnail(app, open) : meta.thumbnail,
            baseVersion: base,
        });
    }
    if (!saved.isOk || saved.value.status !== "saved" || options.keepSource) return saved;

    const removed = await source.delete(meta.id);
    if (!removed.isOk) {
        Logger.warn(`document: moved ${meta.id}, but removing the source failed (${removed.error.kind})`);
    }
    if (open && id !== meta.id) {
        // Moved under a new id: the open copy is saved there, reopen it as that document.
        await open.close({ discardChanges: true });
        await app.openDocument(id, target);
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
