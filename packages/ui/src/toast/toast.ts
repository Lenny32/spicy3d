// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type ToastAction } from "@spicy3d/core";
import { button, label } from "@spicy3d/element";
import style from "./toast.module.css";

/** Long enough to read the message and reach the button. */
const ACTION_TOAST_MS = 8000;

export class Toast {
    private static _lastToast: [number, HTMLElement] | undefined;

    static readonly info = (message: I18nKeys, ...args: any[]) => {
        Toast.display(style.info, I18n.translate(message, ...args));
    };

    static readonly error = (message: string) => {
        Toast.display(style.error, message);
    };

    static readonly warn = (message: string) => {
        Toast.display(style.warning, message);
    };

    /** A toast with one action (e.g. "Undo"); the action closes it. */
    static readonly action = (message: I18nKeys, action: ToastAction, ...args: any[]) => {
        const toast = Toast.display(style.info, I18n.translate(message, ...args), ACTION_TOAST_MS);
        toast.classList.add(style.withAction);
        toast.append(
            button({
                className: style.action,
                textContent: I18n.translate(action.label),
                onclick: () => {
                    Toast.dismiss(toast);
                    action.run();
                },
            }),
        );
    };

    private static dismiss(toast: HTMLElement) {
        if (Toast._lastToast?.[1] !== toast) return;
        clearTimeout(Toast._lastToast[0]);
        toast.remove();
        Toast._lastToast = undefined;
    }

    private static display(type: string, message: string, durationMs = 2000): HTMLElement {
        if (Toast._lastToast) {
            clearTimeout(Toast._lastToast[0]);
            Toast._lastToast[1].remove();
        }

        const toast = label({ className: `${style.toast} ${type}`, textContent: message });
        document.body.appendChild(toast);
        Toast._lastToast = [
            window.setTimeout(() => {
                toast.remove();
                Toast._lastToast = undefined;
            }, durationMs),
            toast,
        ];
        return toast;
    }
}
