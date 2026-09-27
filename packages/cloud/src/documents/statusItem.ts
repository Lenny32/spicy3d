// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveStatus,
    formatDateTime,
    formatTime,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    PubSub,
} from "@spicy3d/core";
import { button, div, span, svg } from "@spicy3d/element";
import { mergePreviewOf } from "../conflicts/mergePreview";
import { previewOf } from "../history/previewRepository";
import accountStyle from "../ui/account.module.css";
import { downloadDocument, saveCopyOnThisDevice, saveOpenDocumentToCloud } from "./documentActions";
import style from "./documents.module.css";
import type { EditLocks } from "./editLocks";
import type { CloudDocumentRepository, CloudSaveState } from "./repository";

/** What the title bar says about the active cloud document. */
export type DocumentStatus =
    | "saved"
    | "unsaved"
    | "saving"
    | "pending"
    | "offline"
    | "merging"
    | "remotePending"
    | "conflict"
    | "error"
    | "readOnly";

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, I18nKeys> = {
    saved: "cloud.status.saved",
    unsaved: "cloud.status.unsaved",
    saving: "cloud.status.saving",
    pending: "cloud.status.pending",
    offline: "cloud.status.offline",
    merging: "cloud.status.merging",
    remotePending: "cloud.status.remotePending",
    conflict: "cloud.status.conflict",
    error: "cloud.status.error",
    readOnly: "cloud.status.readOnly",
};

/** The tooltip of a status, where one helps. */
export const DOCUMENT_STATUS_HINTS: Partial<Record<DocumentStatus, I18nKeys>> = {
    pending: "cloud.status.pendingHint",
    offline: "cloud.status.offlineHint",
    remotePending: "cloud.status.remotePendingHint",
    conflict: "cloud.status.conflictHint",
};

/**
 * The status of a cloud document from its sync state and its state here. `unsaved` = edits since
 * the last save (autosave catches up within its interval); `pending` = saved on this device, not
 * on the server yet (the sync pushes it); `remotePending` = a newer version from another device
 * waits until the user is done.
 */
export function documentStatus(
    state: CloudSaveState,
    { dirty, readOnly, online }: { dirty: boolean; readOnly: boolean; online: boolean },
): DocumentStatus {
    if (readOnly) return "readOnly";
    if (state === "saving") return "saving";
    if (state === "conflict") return "conflict";
    if (state === "merging") return "merging";
    if (state === "offline" || !online) return "offline";
    if (state === "error") return "error";
    if (state === "remotePending") return "remotePending";
    if (dirty) return "unsaved";
    return state === "pending" ? "pending" : "saved";
}

export interface DocumentStatusContext {
    app: IApplication;
    locks: EditLocks;
    /** The cloud repository while signed in. */
    repository: () => CloudDocumentRepository | undefined;
    /** "Edit here instead". */
    takeOver: (document: IDocument) => Promise<void>;
    /** Opens the conflict panel (or the dialog) of a document whose last save (an autosave) met a conflict. */
    resolveConflict?: (document: IDocument) => Promise<void>;
    /** When each document was last autosaved (default: the app's). */
    autosave?: AutosaveStatus;
    /** Opens the version history panel of a cloud document (or of the version a preview shows). */
    openHistory?: (document: IDocument) => void;
}

/**
 * The title bar entry for the active document while signed in: where it lives (a badge that opens
 * "Save to cloud" / "Save a copy on this device" / "Download .spicy") and, for a cloud document,
 * Saved · Saving… · Offline · Conflict · Error, or read-only with "Edit here instead".
 */
export class DocumentStatusItem extends HTMLElement {
    private menu?: HTMLElement;
    private watched?: IDocument;
    private readonly cleanups: (() => void)[] = [];
    private readonly autosave: AutosaveStatus;

    constructor(readonly ctx: DocumentStatusContext) {
        super();
        this.className = style.status;
        this.autosave = ctx.autosave ?? AutosaveStatus.current;
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.render);
        PubSub.default.sub("documentClosed", this.render);
        this.ctx.app.repositories.onPropertyChanged(this.render);
        this.cleanups.push(this.ctx.locks.onChanged(this.render));
        this.cleanups.push(
            this.autosave.onChanged((document) => {
                if (document === this.watched) this.render();
            }),
        );
        globalThis.addEventListener?.("online", this.render);
        globalThis.addEventListener?.("offline", this.render);
        document.addEventListener("pointerdown", this.onDocumentPointerDown);
        this.render();
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.render);
        PubSub.default.remove("documentClosed", this.render);
        this.ctx.app.repositories.removePropertyChanged(this.render);
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        globalThis.removeEventListener?.("online", this.render);
        globalThis.removeEventListener?.("offline", this.render);
        document.removeEventListener("pointerdown", this.onDocumentPointerDown);
        this.watch(undefined);
        this.followRepository(undefined);
    }

    private watch(document: IDocument | undefined) {
        if (this.watched === document) return;
        this.watched?.removePropertyChanged(this.onDocumentChanged);
        this.watched = document;
        document?.onPropertyChanged(this.onDocumentChanged);
    }

    private readonly onDocumentChanged = (property: string | number | symbol) => {
        if (property === "isDirty" || property === "name") this.render();
    };

    private stateUnsubscribe?: () => void;
    private stateRepository?: CloudDocumentRepository;

    private followRepository(repository: CloudDocumentRepository | undefined) {
        if (this.stateRepository === repository) return;
        this.stateUnsubscribe?.();
        this.stateRepository = repository;
        this.stateUnsubscribe = repository?.onStateChanged(() => this.render());
    }

    readonly render = () => {
        this.closeMenu();
        const repository = this.ctx.repository();
        this.followRepository(repository);
        const document = this.ctx.app.activeView?.document;
        const open = document && this.ctx.app.documents.has(document) ? document : undefined;
        this.watch(open);
        if (!repository || !open) {
            this.replaceChildren();
            return;
        }
        if (mergePreviewOf(open)) {
            // The live preview of a merge being resolved: nothing to save, the panel finishes it.
            const label = span({
                className: style.state,
                textContent: I18n.translate("cloud.status.mergePreview"),
                title: I18n.translate("cloud.status.mergePreviewHint"),
            });
            label.dataset["status"] = "mergePreview";
            label.setAttribute("role", "status");
            this.replaceChildren(label);
            return;
        }
        if (previewOf(open)) {
            // A version from the history: nowhere to save it, only "back to the history".
            const label = span({
                className: style.state,
                textContent: I18n.translate("cloud.status.preview"),
                title: I18n.translate("cloud.status.previewHint"),
            });
            label.dataset["status"] = "preview";
            label.setAttribute("role", "status");
            this.replaceChildren(label, ...this.historyButton(open));
            return;
        }

        const inCloud = open.repository === repository;
        const location = button({
            type: "button",
            className: style.location,
            textContent: I18n.translate(inCloud ? "cloud.location.cloud" : "cloud.location.device"),
            title: I18n.translate("cloud.location.menu"),
            onclick: () => this.toggleMenu(open, inCloud),
        });
        location.dataset["location"] = inCloud ? "cloud" : "local";
        location.setAttribute("aria-haspopup", "menu");
        const children: HTMLElement[] = [location];

        if (inCloud) {
            const status = documentStatus(repository.stateOf(open.id), {
                dirty: open.isDirty,
                readOnly: this.ctx.locks.isReadOnly(open.id),
                online: globalThis.navigator?.onLine !== false,
            });
            const autosavedAt = status === "saved" ? this.autosave.lastAutosavedAt(open) : undefined;
            const text =
                autosavedAt !== undefined
                    ? I18n.translate("autosave.status.autosaved{0}", formatTime(autosavedAt))
                    : I18n.translate(DOCUMENT_STATUS_LABELS[status]);
            const resolve = this.ctx.resolveConflict;
            // A conflict met by an autosave opens no dialog by itself: the status does, when clicked.
            const label =
                status === "conflict" && resolve
                    ? button({
                          type: "button",
                          className: `${style.state} ${style.resolve}`,
                          textContent: text,
                          title: I18n.translate("cloud.status.conflictHint"),
                          onclick: () => void resolve(open).finally(this.render),
                      })
                    : span({
                          className: style.state,
                          textContent: text,
                          title:
                              autosavedAt !== undefined
                                  ? formatDateTime(autosavedAt)
                                  : DOCUMENT_STATUS_HINTS[status]
                                    ? I18n.translate(DOCUMENT_STATUS_HINTS[status])
                                    : "",
                      });
            label.dataset["status"] = status;
            label.setAttribute("role", "status");
            children.push(label);
            if (status === "readOnly") {
                children.push(
                    button({
                        type: "button",
                        className: style.takeOver,
                        textContent: I18n.translate("cloud.status.editHere"),
                        onclick: () => void this.ctx.takeOver(open),
                    }),
                );
            }
        }
        if (inCloud) children.push(...this.historyButton(open));
        this.replaceChildren(...children);
    };

    private historyButton(document: IDocument): HTMLElement[] {
        const openHistory = this.ctx.openHistory;
        if (!openHistory) return [];
        const history = button(
            {
                type: "button",
                className: style.history,
                title: I18n.translate("cloud.history.title"),
                onclick: () => openHistory(document),
            },
            svg({ icon: "icon-history" }),
        );
        history.dataset["action"] = "history";
        history.setAttribute("aria-label", I18n.translate("cloud.history.title"));
        return [history];
    }

    private toggleMenu(document: IDocument, inCloud: boolean) {
        if (this.menu) {
            this.closeMenu();
            return;
        }
        const repository = this.ctx.repository();
        if (!repository) return;
        const item = (label: I18nKeys, run: () => Promise<unknown>) =>
            button({
                type: "button",
                textContent: I18n.translate(label),
                onclick: () => {
                    this.closeMenu();
                    void run().finally(this.render);
                },
            });
        const openHistory = this.ctx.openHistory;
        const items = inCloud
            ? [
                  item("cloud.document.saveCopyOnDevice", () => saveCopyOnThisDevice(this.ctx.app, document)),
                  ...(openHistory ? [item("cloud.history.title", async () => openHistory(document))] : []),
              ]
            : [
                  item("cloud.document.saveToCloud", () =>
                      saveOpenDocumentToCloud(this.ctx.app, document, repository),
                  ),
              ];
        items.push(item("cloud.document.download", () => downloadDocument(document)));
        this.menu = div({ className: accountStyle.menu }, ...items);
        this.menu.setAttribute("role", "menu");
        this.append(this.menu);
    }

    private closeMenu() {
        this.menu?.remove();
        this.menu = undefined;
    }

    private readonly onDocumentPointerDown = (e: PointerEvent) => {
        if (this.menu && !this.contains(e.target as Node)) this.closeMenu();
    };
}

customElements.define("spicy-cloud-document-status", DocumentStatusItem);
