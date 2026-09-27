// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentRepositoryError,
    formatDateTime,
    I18n,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    PubSub,
    type Result,
    repositoryErrorMessage,
    type SaveConflict,
    saveDocumentCopy,
} from "@spicy3d/core";
import { div } from "@spicy3d/element";
import style from "../ui/account.module.css";
import { Modal, type ModalAction } from "../ui/modal";
import { downloadDocument } from "./documentActions";

/** The message of a conflict: which device saved the newer version, and when (local time). */
export function conflictMessage(conflict: SaveConflict): string {
    const device = conflict.headDeviceName || I18n.translate("cloud.conflict.unknownDevice");
    const time =
        conflict.headCreatedAt !== undefined && Number.isFinite(conflict.headCreatedAt)
            ? formatDateTime(conflict.headCreatedAt)
            : I18n.translate("cloud.conflict.unknownTime");
    return I18n.translate("cloud.conflict.message{0}{1}", device, time);
}

const errorText = (error: Parameters<typeof repositoryErrorMessage>[0]) => {
    const [key, ...args] = repositoryErrorMessage(error);
    return I18n.translate(key, ...args);
};

/**
 * The conflict dialog's actions when the offline sync met the conflict (CLOUD-10): the pending save
 * lives in the sync's records, so "open latest" drops it there, "save mine as the latest version"
 * rebases it, and a merge whose conflicts all keep this device's side is offered.
 */
export interface ConflictSyncActions {
    /** Pauses the document's sync (and autosave) while the dialog is open; returns the release. */
    hold(): () => void;
    discardMine(): Promise<void>;
    keepMine(): Promise<Result<void, DocumentRepositoryError>>;
    /** Resolves every conflict with this device's side; `undefined` when there is no merge to finish. */
    mergeKeepingMine?: () => Promise<boolean>;
}

/**
 * The MVP answer to a stale save (409, until the merge of CLOUD-13): "A newer version was saved
 * from <device> at <local time>", then
 * - **Open latest**: closes this tab's copy without saving and opens the head (unsaved changes are
 *   lost; "Download mine as .spicy" keeps them in a file first);
 * - **Save mine as a copy**: saves this tab's content as a new cloud document and opens it;
 * - **Save mine as the latest version**: a new version on top of the head — nothing is lost, the
 *   history keeps both. Only offered when the head is known (it becomes the base).
 * With the offline sync (`sync`), the conflict is one its merge couldn't finish: the dialog also
 * offers **Merge, keeping mine where both changed**, and the actions go through the sync.
 * Resolves once the dialog closes.
 */
export function showConflictDialog(
    app: IApplication,
    document: IDocument,
    conflict: SaveConflict,
    repository: IDocumentRepository,
    sync?: ConflictSyncActions,
): Promise<void> {
    return new Promise((resolve) => {
        const release = sync?.hold();
        const mergeKeepingMine = sync?.mergeKeepingMine;
        const modal = new Modal({
            title: "cloud.conflict.title",
            wide: true,
            content: [
                div({ className: style.muted, textContent: conflictMessage(conflict) }),
                div({ className: style.muted, textContent: I18n.translate("cloud.conflict.undoCleared") }),
            ],
            actions: (
                [
                    { label: "common.cancel" },
                    {
                        label: "cloud.conflict.downloadMine",
                        run: async () => {
                            await downloadDocument(document);
                            return false;
                        },
                    },
                    {
                        label: "cloud.conflict.openLatest",
                        kind: "danger",
                        run: async () => {
                            await sync?.discardMine();
                            await document.close({ discardChanges: true });
                            const opened = await app.openDocument(document.id, repository);
                            opened?.application.activeView?.cameraController.fitContent();
                            return undefined;
                        },
                    },
                    {
                        label: "cloud.conflict.saveCopy",
                        run: async () => {
                            const name = I18n.translate("cloud.conflict.copyName{0}", document.name);
                            const copy = await saveDocumentCopy(app, document, repository, name);
                            if (!copy.isOk) {
                                modal.showError(errorText(copy.error));
                                return false;
                            }
                            await sync?.discardMine();
                            await document.close({ discardChanges: true });
                            await app.openDocument(copy.value.id, repository);
                            PubSub.default.pub("showToast", "cloud.conflict.copySaved");
                            return undefined;
                        },
                    },
                    {
                        label: "cloud.conflict.saveLatest",
                        kind: "primary",
                        submit: true,
                        run: async () => {
                            if (sync) {
                                release?.();
                                const kept = await sync.keepMine();
                                if (!kept.isOk) {
                                    modal.showError(errorText(kept.error));
                                    return false;
                                }
                                PubSub.default.pub("showToast", "toast.document.saved");
                                return undefined;
                            }
                            document.version = conflict.headVersion;
                            const saved = await document.save("manual");
                            if (!saved.isOk) {
                                modal.showError(errorText(saved.error));
                                return false;
                            }
                            if (saved.value.status === "conflict") {
                                // Yet another save got in first: ask again about the new head.
                                modal.onClosed(
                                    () =>
                                        void showConflictDialog(
                                            app,
                                            document,
                                            saved.value as SaveConflict,
                                            repository,
                                        ),
                                );
                                return undefined;
                            }
                            PubSub.default.pub("showToast", "toast.document.saved");
                            return undefined;
                        },
                    },
                    ...(mergeKeepingMine
                        ? [
                              {
                                  label: "cloud.conflict.mergeKeepMine",
                                  run: async () => {
                                      release?.();
                                      if (!(await mergeKeepingMine())) {
                                          modal.showError(I18n.translate("cloud.status.conflictHint"));
                                          return false;
                                      }
                                      return undefined;
                                  },
                              } satisfies ModalAction,
                          ]
                        : []),
                ] as ModalAction[]
            ).filter(
                (action) =>
                    action.label !== "cloud.conflict.saveLatest" || conflict.headVersion !== undefined,
            ),
        });
        modal.onClosed(() => {
            release?.();
            resolve();
        });
        modal.open();
    });
}
