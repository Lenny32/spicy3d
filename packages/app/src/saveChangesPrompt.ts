// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, PubSub } from "@spicy3d/core";
import { div } from "@spicy3d/element";

export type SaveChangesChoice = "save" | "discard" | "cancel";

/**
 * Asks, in the app dialog, whether to save the unsaved changes of `documentName`. Enter picks
 * "save", Escape "cancel".
 */
export function askToSaveChanges(documentName: string): Promise<SaveChangesChoice> {
    return new Promise((resolve) => {
        PubSub.default.pub(
            "showDialog",
            "dialog.title.unsavedChanges",
            div({ textContent: I18n.translate("prompt.saveDocument{0}", documentName) }),
            [
                { content: "common.save", onclick: () => resolve("save") },
                { content: "common.dontSave", onclick: () => resolve("discard") },
                { content: "common.cancel", onclick: () => resolve("cancel") },
            ],
        );
    });
}
