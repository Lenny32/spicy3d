// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@spicy3d/core";
import { svg } from "@spicy3d/element";
import style from "./contextMenu.module.css";

export interface ContextMenuAction {
    readonly label: I18nKeys;
    /** Arguments of `label` (`{0}`, ...). */
    readonly args?: readonly unknown[];
    /** Iconfont key shown before the label. */
    readonly icon?: string;
    readonly run: () => void;
    /** Shown dimmed, not clickable (the action does not apply to what was clicked). */
    readonly disabled?: boolean;
    /** Destroys something (delete): tinted with the error color. */
    readonly danger?: boolean;
}

/** An action, or a divider between groups (leading, trailing and doubled ones are dropped). */
export type ContextMenuEntry = ContextMenuAction | "separator";

/** Where the menu opens: at a pointer position (right-click), or under an element (a "⋯" button). */
export type ContextMenuAnchor = { readonly x: number; readonly y: number } | Element;

const MARGIN = 4;

let open: { menu: HTMLElement; close: () => void } | undefined;

/** Closes the open context menu, if any. */
export function closeContextMenu(): void {
    open?.close();
}

/**
 * Opens a floating menu (one at a time: a new one replaces the open one), kept inside the
 * viewport. It closes on a choice, Escape, a pointer press or wheel outside, and when the window
 * loses focus or resizes; arrow keys move between the actions. Returns its close function.
 */
export function showContextMenu(anchor: ContextMenuAnchor, entries: readonly ContextMenuEntry[]): () => void {
    closeContextMenu();
    const previousFocus = document.activeElement as HTMLElement | null;
    const menu = document.createElement("div");
    menu.className = style.menu;
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    const shown = tidy(entries);
    menu.append(...shown.map((entry, index) => (entry === "separator" ? separator() : item(entry, index))));

    const close = () => {
        if (open?.menu !== menu) return;
        open = undefined;
        menu.remove();
        document.removeEventListener("pointerdown", onOutside, true);
        document.removeEventListener("wheel", onOutside, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("blur", close);
        window.removeEventListener("resize", close);
        if (menu.contains(document.activeElement)) previousFocus?.focus?.();
    };
    const onOutside = (e: Event) => {
        if (!menu.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            previousFocus?.focus?.();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
            e.preventDefault();
            e.stopPropagation();
            moveFocus(menu, e.key);
        }
    };
    menu.addEventListener("click", (e) => {
        const target = (e.target as Element).closest?.(`.${style.item}`) as HTMLButtonElement | null;
        if (!target || target.disabled) return;
        e.stopPropagation();
        const index = Number(target.dataset["index"]);
        close();
        (shown[index] as ContextMenuAction).run();
    });
    menu.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    document.body.appendChild(menu);
    const { top, left } = position(anchor, menu);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    open = { menu, close };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("wheel", onOutside, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    enabledItems(menu)[0]?.focus({ preventScroll: true });
    return close;
}

function tidy(entries: readonly ContextMenuEntry[]): ContextMenuEntry[] {
    const result: ContextMenuEntry[] = [];
    for (const entry of entries) {
        if (entry === "separator" && (result.length === 0 || result.at(-1) === "separator")) continue;
        result.push(entry);
    }
    if (result.at(-1) === "separator") result.pop();
    return result;
}

function item(action: ContextMenuAction, index: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset["index"] = String(index);
    button.type = "button";
    button.className = action.danger ? `${style.item} ${style.danger}` : style.item;
    button.setAttribute("role", "menuitem");
    button.disabled = action.disabled === true;
    if (action.icon !== undefined) button.append(svg({ className: style.icon, icon: action.icon }));
    const label = document.createElement("span");
    label.textContent = I18n.translate(action.label, ...(action.args ?? [])) ?? action.label;
    button.append(label);
    return button;
}

function separator(): HTMLElement {
    const line = document.createElement("div");
    line.className = style.separator;
    line.setAttribute("role", "separator");
    return line;
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>(`.${style.item}`)].filter((x) => !x.disabled);
}

function moveFocus(menu: HTMLElement, key: string) {
    const items = enabledItems(menu);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = items.length - 1;
    else if (key === "ArrowDown") next = (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next].focus();
}

/**
 * At a point: opens down-right of it, flipped up / left when it would overflow. Under an element:
 * below it, right-aligned with it, flipped above when it would overflow the bottom edge.
 */
function position(anchor: ContextMenuAnchor, menu: HTMLElement) {
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    let top: number;
    let left: number;
    if (anchor instanceof Element) {
        const rect = anchor.getBoundingClientRect();
        top = rect.bottom + 2;
        if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, rect.top - height - 2);
        left = Math.max(rect.left, rect.right - width);
    } else {
        top = anchor.y;
        if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, anchor.y - height);
        left = anchor.x;
        if (left + width > window.innerWidth - MARGIN) left = anchor.x - width;
    }
    left = Math.min(left, window.innerWidth - width - MARGIN);
    return { top, left: Math.max(MARGIN, left) };
}
