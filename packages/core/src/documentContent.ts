// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import { type DocumentFormatError, DocumentMigrations } from "./documentFormat";
import { type IHistoryRecord, Result, Transaction } from "./foundation";
import type { Serialized } from "./serialize";
import { Serializer } from "./serialize";
import type { Act } from "./visual";

// Replacing an open document's content with another version of it — a merge result (CLOUD-12/13),
// a newer version pulled from another device (CLOUD-10) — in place: the document object, its views
// and cameras stay; only what differs changes (`ModelManager.applyContent`), as one undo step.

/** Makes the document's content (name, variables, settings, acts, user data, models) equal to `data` (migrated). */
export function applyDocumentContent(document: IDocument, data: Serialized): void {
    document.selection?.clearSelection?.();
    if (typeof data["name"] === "string" && document.name !== data["name"]) document.name = data["name"];
    document.variables.setItems(data["variables"] ?? []);
    document.settings.load(data["settings"]);
    const acts = (data["acts"] ?? []) as Serialized[];
    document.acts.clear();
    document.acts.push(...acts.map((act) => Serializer.deserializeObject(document, act) as Act));
    document.userData = structuredClone(data["userData"] ?? {});
    document.modelManager.applyContent(structuredClone(data["models"]));
}

/** Undoes / redoes a content replacement by applying the snapshot from before / after it. */
export class DocumentContentRecord implements IHistoryRecord {
    constructor(
        readonly document: IDocument,
        readonly name: string,
        private readonly before: Serialized,
        private readonly after: Serialized,
    ) {}

    undo(): void {
        applyDocumentContent(this.document, this.before);
    }

    redo(): void {
        applyDocumentContent(this.document, this.after);
    }

    dispose(): void {}
}

/**
 * Replaces the document's content with `stored` (any supported format: migrated first, never
 * modified) as one undoable step named `name` — it joins an open transaction, else it is one
 * history entry. Views, cameras and unchanged nodes are kept. A document that cannot be migrated
 * is the error, and nothing changes.
 */
export function replaceDocumentContent(
    document: IDocument,
    stored: Serialized,
    name: string,
): Result<void, DocumentFormatError> {
    const migrated = DocumentMigrations.migrate(stored);
    if (!migrated.isOk) return Result.err(migrated.error);
    const before = document.serialize();
    const history = document.history;
    const wasDisabled = history.disabled;
    history.disabled = true;
    try {
        applyDocumentContent(document, migrated.value);
    } finally {
        history.disabled = wasDisabled;
    }
    Transaction.add(document, new DocumentContentRecord(document, name, before, migrated.value));
    return Result.ok(undefined);
}
