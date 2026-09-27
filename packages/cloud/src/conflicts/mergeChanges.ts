// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { compareDocuments, type DocumentChange, I18n, type Serialized } from "@spicy3d/core";
import { div, li, ul } from "@spicy3d/element";
import { Modal } from "../ui/modal";
import style from "./conflicts.module.css";

/**
 * What a clean merge changed in this device's document: the Compare lines (the registered
 * `IDocumentDiffer`, default the semantic one) from the content before the merge to the merge.
 */
export function mergeChanges(before: Serialized, merged: Serialized): DocumentChange[] {
    const changes = compareDocuments(before, merged);
    return changes.isOk ? changes.value : [];
}

/**
 * "View changes" of a clean merge's toast: the list in a dialog, with "Undo merge" while the
 * merge can still be undone. Resolves once the dialog closes.
 */
export function showMergeChanges(
    before: Serialized,
    merged: Serialized,
    from: string,
    undo?: () => Promise<boolean>,
): Promise<void> {
    return new Promise((resolve) => {
        const items = mergeChanges(before, merged).map((change) => {
            const item = li({ textContent: I18n.translate(change.message, ...change.args) });
            item.dataset["kind"] = change.kind;
            return item;
        });
        const modal = new Modal({
            title: "cloud.merge.changesTitle{0}",
            titleArgs: [from],
            wide: true,
            content:
                items.length > 0
                    ? [ul({ className: style.changes }, ...items)]
                    : [div({ textContent: I18n.translate("cloud.history.noChanges") })],
            actions: [
                ...(undo
                    ? [
                          {
                              label: "cloud.merge.undo" as const,
                              kind: "danger" as const,
                              run: async () => ((await undo()) ? undefined : false),
                          },
                      ]
                    : []),
                { label: "common.close", kind: "primary", submit: true },
            ],
        });
        modal.onClosed(() => resolve());
        modal.open();
    });
}
