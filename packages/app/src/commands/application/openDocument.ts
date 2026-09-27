// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, I18n, type IApplication, type ICommand, PubSub } from "@spicy3d/core";
import { openDocumentFile, pickDocumentFile } from "../../documentFiles";

@command({
    key: "doc.open",
    icon: "icon-open",
    isApplicationCommand: true,
})
export class OpenDocument implements ICommand {
    async execute(app: IApplication): Promise<void> {
        // Picked outside the progress toast: the picker needs the click's user activation.
        const picked = await pickDocumentFile();
        if (!picked.isOk) return;
        PubSub.default.pub(
            "showPermanent",
            async () => {
                for (const entry of picked.value) {
                    const document = await openDocumentFile(app, entry);
                    document?.application.activeView?.cameraController.fitContent();
                }
            },
            "toast.excuting{0}",
            I18n.translate("command.doc.open"),
        );
    }
}
