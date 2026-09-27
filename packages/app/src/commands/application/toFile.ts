// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, I18n, type IApplication, type ICommand, PubSub } from "@spicy3d/core";
import { saveDocumentFile } from "../../documentFiles";

/**
 * Saves the active document as a `.spicy` file: written back to its file where the browser
 * supports the File System Access API, downloaded otherwise.
 */
@command({
    key: "doc.saveToFile",
    icon: "icon-download",
})
export class SaveDocumentToFile implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (!document) return;
        PubSub.default.pub(
            "showPermanent",
            async () => {
                const result = await saveDocumentFile(document);
                if (result.isOk) {
                    PubSub.default.pub(
                        "showToast",
                        result.value === "written" ? "toast.document.savedToFile" : "toast.downloading",
                    );
                } else if (result.error !== "cancel") {
                    PubSub.default.pub("showToast", "error.default:{0}", result.error);
                }
            },
            "toast.excuting{0}",
            I18n.translate("command.doc.saveToFile"),
        );
    }
}
