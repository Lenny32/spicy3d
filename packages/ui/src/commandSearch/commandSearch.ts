// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommandKeys, CommandStore, I18n, type I18nKeys, PubSub } from "@spicy3d/core";
import { div, input } from "@spicy3d/element";
import { createDropdownItem } from "../ribbon/dropdownController";
import style from "./commandSearch.module.css";

/** Commands that make no sense as a search result. */
const EXCLUDED = new Set<CommandKeys>(["special.last", "edit.commandSearch"]);
const MAX_RESULTS = 12;

/**
 * Commands whose localized name or key contains `query`, best match first: names starting with
 * the query, then earlier matches, then alphabetical. An empty query lists every command.
 */
export function searchCommands(query: string): CommandKeys[] {
    const needle = query.trim().toLowerCase();
    const scored: { key: CommandKeys; name: string; score: number }[] = [];
    for (const data of CommandStore.getAllCommands()) {
        if (EXCLUDED.has(data.key)) continue;
        const name = I18n.translate(`command.${data.key}` as I18nKeys).toLowerCase();
        const nameIndex = name.indexOf(needle);
        const keyIndex = data.key.toLowerCase().indexOf(needle);
        if (nameIndex < 0 && keyIndex < 0) continue;
        const score = nameIndex >= 0 ? nameIndex : 1000 + keyIndex;
        scored.push({ key: data.key, name, score });
    }
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return scored.map((x) => x.key);
}

let lastPointer = { x: 0, y: 0 };
if (typeof window !== "undefined") {
    window.addEventListener("pointermove", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), {
        passive: true,
    });
}

/** Fusion-style `S` popup: type to filter, ↑/↓ to pick, Enter runs, Escape or outside click closes. */
export class CommandSearch extends HTMLElement {
    static #current?: CommandSearch;

    /** Opens the popup at the last pointer position, replacing one already open. */
    static open(position = lastPointer): CommandSearch {
        CommandSearch.#current?.close();
        const popup = new CommandSearch(position);
        document.body.appendChild(popup);
        popup.input.focus();
        CommandSearch.#current = popup;
        return popup;
    }

    readonly input: HTMLInputElement;
    readonly #list = div({ className: style.list });
    #results: CommandKeys[] = [];
    #selected = 0;

    constructor(position: { x: number; y: number }) {
        super();
        this.className = style.root;
        this.style.left = `${Math.max(0, Math.min(position.x, window.innerWidth - 320))}px`;
        this.style.top = `${Math.max(0, Math.min(position.y, window.innerHeight - 360))}px`;
        this.input = input({
            className: style.input,
            placeholder: I18n.translate("commandSearch.placeholder"),
            oninput: () => this.update(),
            onkeydown: this.onKeyDown,
        });
        this.append(this.input, this.#list);
        this.update();
    }

    get results(): readonly CommandKeys[] {
        return this.#results;
    }

    get selectedIndex(): number {
        return this.#selected;
    }

    connectedCallback() {
        document.addEventListener("pointerdown", this.onOutsidePointer, true);
    }

    disconnectedCallback() {
        document.removeEventListener("pointerdown", this.onOutsidePointer, true);
        if (CommandSearch.#current === this) CommandSearch.#current = undefined;
    }

    close() {
        this.remove();
    }

    private update() {
        this.#results = searchCommands(this.input.value).slice(0, MAX_RESULTS);
        this.#selected = 0;
        this.render();
    }

    private render() {
        this.#list.replaceChildren(
            ...this.#results.map((command, i) => {
                const item = createDropdownItem(command, () => this.close(), {
                    item: i === this.#selected ? `${style.item} ${style.selected}` : style.item,
                    icon: style.icon,
                    text: style.text,
                });
                item.onmouseenter = () => this.select(i);
                return item;
            }),
        );
    }

    private select(index: number) {
        if (index === this.#selected) return;
        this.#selected = index;
        this.render();
        this.#list.children[index]?.scrollIntoView?.({ block: "nearest" });
    }

    run() {
        const command = this.#results[this.#selected];
        this.close();
        if (command) PubSub.default.pub("executeCommand", command);
    }

    private readonly onKeyDown = (e: KeyboardEvent) => {
        const count = this.#results.length;
        if (e.key === "ArrowDown" && count > 0) {
            this.select((this.#selected + 1) % count);
        } else if (e.key === "ArrowUp" && count > 0) {
            this.select((this.#selected - 1 + count) % count);
        } else if (e.key === "Enter") {
            this.run();
        } else if (e.key === "Escape") {
            this.close();
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
    };

    private readonly onOutsidePointer = (e: Event) => {
        if (!this.contains(e.target as Node)) this.close();
    };
}

customElements.define("spicy-command-search", CommandSearch);
