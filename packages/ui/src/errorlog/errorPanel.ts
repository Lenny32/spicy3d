// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ErrorLog, type ErrorLogEntry, I18n } from "@spicy3d/core";
import { button, div, span, svg } from "@spicy3d/element";
import style from "./errorPanel.module.css";

/** Session error list, docked in the viewport's bottom-left corner; closing it keeps the entries. */
export class ErrorPanel extends HTMLElement {
    onClose?: () => void;

    private readonly list = div({ className: style.list });
    private unsubscribe?: () => void;

    constructor() {
        super();
        this.className = style.root;
        const iconButton = (icon: string, title: string, run: () => void) =>
            button({ className: style.iconButton, title, onclick: run }, svg({ icon }));
        this.append(
            div(
                { className: style.header },
                div(
                    { className: style.title },
                    svg({ className: style.titleIcon, icon: "icon-bell" }),
                    span({ textContent: I18n.translate("errors.title") }),
                ),
                div(
                    { className: style.headerButtons },
                    iconButton("icon-copy", I18n.translate("errors.copy"), () => this.copyAll()),
                    iconButton("icon-clear", I18n.translate("errors.clear"), () => ErrorLog.clear()),
                    iconButton("icon-times", I18n.translate("errors.close"), () => this.onClose?.()),
                ),
            ),
            this.list,
        );
        this.render();
    }

    connectedCallback(): void {
        this.unsubscribe ??= ErrorLog.subscribe(() => this.render());
        this.render();
    }

    disconnectedCallback(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private copyAll() {
        void navigator.clipboard?.writeText(ErrorLog.format()).catch(() => undefined);
    }

    private render() {
        const entries = ErrorLog.entries;
        if (entries.length === 0) {
            this.list.replaceChildren(
                div({ className: style.empty, textContent: I18n.translate("errors.empty") }),
            );
            return;
        }
        // Newest first.
        this.list.replaceChildren(...[...entries].reverse().map((e) => this.row(e)));
    }

    private row(entry: ErrorLogEntry): HTMLElement {
        const time = new Date(entry.time).toLocaleTimeString();
        const head = div(
            { className: style.rowHead },
            span({ className: style.time, textContent: time }),
            span({ className: style.source, textContent: I18n.translate(`errors.source.${entry.source}`) }),
        );
        const message = div({ className: style.message, textContent: entry.message });
        if (!entry.details) return div({ className: style.row }, head, message);
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.append(message);
        details.append(summary, div({ className: style.details, textContent: entry.details }));
        return div({ className: style.row }, head, details);
    }
}

customElements.define("spicy-error-panel", ErrorPanel);
