// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveStatus,
    formatDateTime,
    formatTime,
    I18n,
    type IDocument,
    type IView,
    PubSub,
} from "@spicy3d/core";
import { input, label, span } from "@spicy3d/element";
import style from "./autosaveStatus.module.css";

/**
 * Status-bar entry of the active document's autosave: "Autosaved 14:05" (local time, formatted when
 * shown) after an autosave — cloud documents show it in the title bar instead — and, for a document
 * opened from a `.spicy` file, the per-file "Autosave to file" opt-in.
 */
export class AutosaveIndicator extends HTMLElement {
    private document?: IDocument;
    private unsubscribe?: () => void;

    constructor(private readonly status: AutosaveStatus = AutosaveStatus.current) {
        super();
        this.className = style.indicator;
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.onActiveViewChanged);
        PubSub.default.sub("documentClosed", this.onDocumentClosed);
        this.unsubscribe ??= this.status.onChanged(this.onStatusChanged);
        this.render();
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.onActiveViewChanged);
        PubSub.default.remove("documentClosed", this.onDocumentClosed);
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private readonly onActiveViewChanged = (view: IView | undefined) => {
        this.document = view?.document;
        this.render();
    };

    private readonly onDocumentClosed = (document: IDocument) => {
        if (document !== this.document) return;
        this.document = undefined;
        this.render();
    };

    private readonly onStatusChanged = (document: IDocument) => {
        if (document === this.document) this.render();
    };

    render(): void {
        const document = this.document;
        const children: HTMLElement[] = [];
        if (document) {
            const at = this.status.lastAutosavedAt(document);
            if (at !== undefined && document.repository.kind !== "cloud") {
                children.push(
                    span({
                        className: style.time,
                        textContent: I18n.translate("autosave.status.autosaved{0}", formatTime(at)),
                        title: formatDateTime(at),
                    }),
                );
            }
            const files = this.status.fileAutosave;
            const state = files?.state(document) ?? "unavailable";
            if (files && state !== "unavailable") children.push(this.fileToggle(document, state === "on"));
        }
        this.replaceChildren(...children);
    }

    private fileToggle(document: IDocument, checked: boolean): HTMLElement {
        const box = input({ type: "checkbox", checked });
        box.onchange = async () => {
            const wanted = box.checked;
            const on = (await this.status.fileAutosave?.set(document, wanted)) ?? false;
            if (wanted && !on) PubSub.default.pub("showToast", "autosave.file.denied");
            this.render();
        };
        return label(
            { className: style.toggle, title: I18n.translate("autosave.file.toggleHint") },
            box,
            span({ textContent: I18n.translate("autosave.file.toggle") }),
        );
    }
}

customElements.define("spicy-autosave-status", AutosaveIndicator);
