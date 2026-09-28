// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    I18n,
    type IApplication,
    type ICommand,
    PubSub,
    repositoryErrorMessage,
} from "@spicy3d/core";
import { reportSaveConflict } from "../../document";

@command({
    key: "doc.save",
    icon: "icon-save",
    isApplicationCommand: true,
})
export class SaveDocument implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (!document) return;
        PubSub.default.pub(
            "showPermanent",
            async () => {
                const result = await document.save("manual");
                if (!result.isOk) {
                    PubSub.default.pub("showToast", ...repositoryErrorMessage(result.error));
                } else if (result.value.status === "conflict") {
                    // Not awaited: the dialog outlives the progress indicator.
                    void reportSaveConflict(app, document, result.value);
                } else {
                    PubSub.default.pub("showToast", "toast.document.saved");
                }
            },
            "toast.executing{0}",
            I18n.translate("command.doc.save"),
        );
    }
}
