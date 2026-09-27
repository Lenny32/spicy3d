// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DOCUMENT_FILE_EXTENSION,
    type DocumentRepositoryError,
    download,
    encodeDocumentFile,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    PubSub,
    type Result,
    repositoryErrorMessage,
    type SaveOutcome,
    saveDocumentCopy,
    transferDocument,
} from "@spicy3d/core";
import { div } from "@spicy3d/element";
import style from "../ui/account.module.css";
import { Modal } from "../ui/modal";

/** "Download .spicy": the document as it is in this tab, unsaved changes included. */
export async function downloadDocument(document: IDocument): Promise<void> {
    const blob = await encodeDocumentFile(document.serialize());
    download([blob], `${document.name}${DOCUMENT_FILE_EXTENSION}`);
}

/** How "Save to cloud" treats the local document: moved, or copied (the local one kept). */
export type SaveToCloudChoice = "move" | "copy" | "cancel";

export function askKeepLocalCopy(name: string): Promise<SaveToCloudChoice> {
    return new Promise((resolve) => {
        new Modal({
            title: "cloud.document.saveToCloud",
            content: [
                div({
                    className: style.muted,
                    textContent: I18n.translate("cloud.document.saveToCloudHint{0}", name),
                }),
            ],
            onCancel: () => resolve("cancel"),
            actions: [
                { label: "common.cancel" },
                { label: "cloud.document.keepLocalCopy", run: () => void resolve("copy") },
                {
                    label: "cloud.document.moveToCloud",
                    kind: "primary",
                    submit: true,
                    run: () => void resolve("move"),
                },
            ],
        }).open();
    });
}

/** Toasts the outcome of a save; `true` when saved. */
export function reportSave(result: Result<SaveOutcome, DocumentRepositoryError>, success: I18nKeys): boolean {
    if (!result.isOk) {
        PubSub.default.pub("showToast", ...repositoryErrorMessage(result.error));
        return false;
    }
    if (result.value.status === "conflict") {
        // Only a create answers this: the id is taken (possibly by a document in the trash).
        PubSub.default.pub("showToast", "cloud.document.alreadyInCloud");
        return false;
    }
    PubSub.default.pub("showToast", success);
    return true;
}

/** "Save to cloud" of the open local document: asks whether to keep the local copy, then moves it. */
export async function saveOpenDocumentToCloud(
    app: IApplication,
    document: IDocument,
    cloud: IDocumentRepository,
): Promise<boolean> {
    const choice = await askKeepLocalCopy(document.name);
    if (choice === "cancel") return false;
    const result = await transferDocument(
        app,
        { id: document.id, name: document.name, updatedAt: Date.now(), location: "local" },
        cloud,
        { keepSource: choice === "copy" },
    );
    return reportSave(result, "cloud.document.savedToCloud");
}

/** "Save a copy on this device" of the open cloud document: a new local document. */
export async function saveCopyOnThisDevice(app: IApplication, document: IDocument): Promise<boolean> {
    const result = await saveDocumentCopy(app, document, app.repositories.local);
    if (!result.isOk) {
        PubSub.default.pub("showToast", ...repositoryErrorMessage(result.error));
        return false;
    }
    PubSub.default.pub("showToast", "cloud.document.copySaved");
    return true;
}
