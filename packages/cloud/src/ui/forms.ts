// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@spicy3d/core";
import { button, div, input, label, span } from "@spicy3d/element";
import {
    estimatePasswordStrength,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
} from "../account/passwordStrength";
import { type CloudError, cloudErrorMessage, fieldErrorMessages } from "../problem";
import style from "./account.module.css";
import type { Modal } from "./modal";

export interface Field {
    readonly root: HTMLElement;
    readonly input: HTMLInputElement;
    readonly value: string;
    setError(message: string | undefined): void;
}

export interface FieldOptions {
    label: I18nKeys;
    labelArgs?: unknown[];
    /** The request's field name, so the server's validation errors land under the right input. */
    name: string;
    type?: "text" | "email" | "password";
    autocomplete?: string;
    value?: string;
    readOnly?: boolean;
    maxLength?: number;
}

export function textField(options: FieldOptions): Field {
    const field = input({
        type: options.type ?? "text",
        name: options.name,
        value: options.value ?? "",
        readOnly: options.readOnly ?? false,
        spellcheck: false,
    });
    if (options.autocomplete) field.autocomplete = options.autocomplete as AutoFill;
    if (options.maxLength) field.maxLength = options.maxLength;
    const error = span({ className: style.fieldError });
    const root = label(
        { className: style.field },
        span({ textContent: I18n.translate(options.label, ...(options.labelArgs ?? [])) }),
        field,
        error,
    );
    return {
        root,
        input: field,
        get value() {
            return field.value;
        },
        setError(message) {
            error.textContent = message ?? "";
            field.toggleAttribute("aria-invalid", message !== undefined);
        },
    };
}

/**
 * A new-password field with a live strength hint. `personal` returns what the password shouldn't
 * contain (email, name) at the time of typing.
 */
export function newPasswordField(
    options: Omit<FieldOptions, "type" | "autocomplete">,
    personal: () => string[] = () => [],
): Field {
    const field = textField({
        ...options,
        type: "password",
        autocomplete: "new-password",
        maxLength: PASSWORD_MAX_LENGTH,
    });
    const text = span({});
    const meter = div({ className: style.meter }, span({}), text);
    meter.setAttribute("aria-live", "polite");
    const update = () => {
        const hint = estimatePasswordStrength(field.value, personal());
        meter.dataset["score"] = String(hint.score);
        meter.style.setProperty("--score", String(hint.score));
        meter.dataset["strength"] = hint.strength;
        text.textContent = I18n.translate(hint.message, PASSWORD_MIN_LENGTH);
    };
    field.input.addEventListener("input", update);
    update();
    field.root.insertBefore(meter, field.root.lastChild);
    return field;
}

export function checkbox(
    labelKey: I18nKeys,
    checked = false,
): { root: HTMLElement; input: HTMLInputElement } {
    const box = input({ type: "checkbox", checked });
    return {
        root: label({ className: style.check }, box, span({ textContent: I18n.translate(labelKey) })),
        input: box,
    };
}

export function linkButton(labelKey: I18nKeys, onclick: () => void, args: unknown[] = []): HTMLButtonElement {
    return button({
        type: "button",
        className: style.link,
        textContent: I18n.translate(labelKey, ...args),
        onclick: (e: MouseEvent) => {
            e.preventDefault();
            onclick();
        },
    });
}

export function paragraph(key: I18nKeys, ...args: unknown[]): HTMLElement {
    return div({ className: style.muted, textContent: I18n.translate(key, ...args) });
}

export function notice(key: I18nKeys, ...args: unknown[]): HTMLElement {
    const el = div({ className: style.notice, textContent: I18n.translate(key, ...args) });
    el.setAttribute("role", "status");
    return el;
}

/** A notice with a text that is already translated (e.g. a server error message). */
export function noticeText(text: string): HTMLElement {
    const el = div({ className: style.notice, textContent: text });
    el.setAttribute("role", "status");
    return el;
}

/**
 * Shows a failed request: `validation_failed` errors under their fields (server field names are the
 * keys of `fields`), anything else in the dialog's error area. Always returns `false` (keep open).
 */
export function showCloudError(modal: Modal, error: CloudError, fields: Record<string, Field> = {}): false {
    for (const field of Object.values(fields)) field.setError(undefined);
    const byField = fieldErrorMessages(error);
    let unmatched = false;
    for (const [name, messages] of Object.entries(byField)) {
        const field = fields[name];
        if (field) field.setError(messages.join(" "));
        else unmatched = true;
    }
    const matchedAny = Object.keys(byField).some((name) => fields[name]);
    modal.showError(matchedAny && !unmatched ? undefined : cloudErrorMessage(error));
    return false;
}

/** Clears field errors, then checks `required` fields are filled; returns whether all are. */
export function requireFilled(...fields: Field[]): boolean {
    let ok = true;
    for (const field of fields) {
        const empty = field.value.trim() === "";
        field.setError(empty ? I18n.translate("account.field.required") : undefined);
        if (empty) ok = false;
    }
    return ok;
}

/** Up to two initials of a display name (or the email), for the avatar. */
export function initials(name: string): string {
    const words = name
        .trim()
        .split(/[\s@._-]+/)
        .filter((w) => w.length > 0);
    const letters = words.length > 1 ? [words[0], words[1]] : words.slice(0, 1);
    return letters
        .map((w) => Array.from(w)[0] ?? "")
        .join("")
        .toUpperCase();
}
