// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@spicy3d/core";
import { button, div, form, h2 } from "@spicy3d/element";
import style from "./account.module.css";

export interface ModalAction {
    label: I18nKeys;
    kind?: "primary" | "danger" | "secondary";
    /** Pressing Enter in a field runs the submit action. */
    submit?: boolean;
    /** Closes like Escape, calling `onCancel` (implied for `common.cancel`). */
    cancel?: boolean;
    /**
     * Runs with the dialog busy (every button disabled). Returning `false` keeps the dialog open,
     * e.g. after showing an error; anything else closes it. Omitted: just closes.
     */
    run?: () => boolean | undefined | Promise<boolean | undefined>;
}

export interface ModalOptions {
    title: I18nKeys;
    titleArgs?: unknown[];
    content: (Node | string)[];
    actions: ModalAction[];
    /** Escape (or a cancel action) closes the dialog and calls this. */
    onCancel?: () => void;
    wide?: boolean;
}

/**
 * A modal dialog of the account UI: a form, so Enter submits and password managers see the fields,
 * an error area, and actions that run asynchronously while the dialog is busy. The content can be
 * replaced for a next step (e.g. "check your inbox" after signing up).
 */
export class Modal {
    readonly dialog: HTMLDialogElement;
    private readonly titleEl: HTMLElement;
    private readonly bodyEl: HTMLElement;
    private readonly errorEl: HTMLElement;
    private readonly actionsEl: HTMLElement;
    private actions: ModalAction[] = [];
    private onCancel?: () => void;
    private busy = false;
    private readonly closeListeners: (() => void)[] = [];

    constructor(options: ModalOptions) {
        this.titleEl = h2({ className: style.title });
        this.errorEl = div({ className: style.error });
        this.errorEl.setAttribute("role", "alert");
        this.bodyEl = div({ className: style.body });
        this.actionsEl = div({ className: style.actions });
        const content = form(
            {
                className: style.form,
                onsubmit: (e: SubmitEvent) => {
                    e.preventDefault();
                    const submit = this.actions.find((a) => a.submit);
                    if (submit) void this.runAction(submit);
                },
            },
            this.titleEl,
            this.bodyEl,
            this.actionsEl,
        );
        content.noValidate = true;
        this.dialog = document.createElement("dialog");
        this.dialog.className = options.wide ? `${style.dialog} ${style.wide}` : style.dialog;
        this.dialog.append(content);
        this.dialog.addEventListener("cancel", (e) => {
            e.preventDefault();
            if (!this.busy) this.cancel();
        });
        this.show(options);
    }

    /** Replaces title, content and actions (the next step of a flow); clears the error. */
    show(options: Omit<ModalOptions, "wide">): void {
        this.titleEl.textContent = I18n.translate(options.title, ...(options.titleArgs ?? []));
        this.bodyEl.replaceChildren(this.errorEl, ...options.content);
        this.actions = options.actions;
        this.onCancel = options.onCancel;
        this.actionsEl.replaceChildren(...this.actions.map((action) => this.actionButton(action)));
        this.showError(undefined);
    }

    open(): this {
        document.body.append(this.dialog);
        this.dialog.showModal();
        this.dialog.querySelector<HTMLInputElement>("input:not([readonly]):not([type=checkbox])")?.focus();
        return this;
    }

    close(): void {
        if (this.dialog.open) this.dialog.close();
        this.dialog.remove();
        const listeners = this.closeListeners.splice(0);
        for (const listener of listeners) listener();
    }

    /** Runs once the dialog closes, however it closes. */
    onClosed(listener: () => void): void {
        this.closeListeners.push(listener);
    }

    get isOpen(): boolean {
        return this.dialog.isConnected;
    }

    cancel(): void {
        this.close();
        this.onCancel?.();
    }

    showError(message: string | undefined): void {
        this.errorEl.textContent = message ?? "";
    }

    get body(): HTMLElement {
        return this.bodyEl;
    }

    private actionButton(action: ModalAction) {
        const kind = action.kind ?? "secondary";
        return button({
            type: action.submit ? "submit" : "button",
            className: kind === "secondary" ? style.button : `${style.button} ${style[kind]}`,
            textContent: I18n.translate(action.label),
            onclick: (e: MouseEvent) => {
                // Submit buttons go through the form's submit event (which runs the action once).
                if (action.submit) return;
                e.preventDefault();
                void this.runAction(action);
            },
        });
    }

    private async runAction(action: ModalAction) {
        if (this.busy) return;
        if (!action.run) {
            if (action.cancel || action.label === "common.cancel") this.cancel();
            else this.close();
            return;
        }
        this.setBusy(true);
        let keepOpen = false;
        try {
            keepOpen = (await action.run()) === false;
        } finally {
            this.setBusy(false);
        }
        if (!keepOpen) this.close();
    }

    private setBusy(busy: boolean) {
        this.busy = busy;
        this.dialog.toggleAttribute("aria-busy", busy);
        for (const b of this.actionsEl.querySelectorAll("button")) b.disabled = busy;
    }
}

/** A modal that only asks for confirmation; resolves `true` when confirmed. */
export function confirmModal(
    title: I18nKeys,
    message: string,
    confirm: I18nKeys,
    kind: "primary" | "danger" = "primary",
): Promise<boolean> {
    return new Promise((resolve) => {
        new Modal({
            title,
            content: [div({ className: style.muted, textContent: message })],
            onCancel: () => resolve(false),
            actions: [
                { label: "common.cancel" },
                {
                    label: confirm,
                    kind,
                    submit: true,
                    run: () => {
                        resolve(true);
                        return undefined;
                    },
                },
            ],
        }).open();
    });
}
