// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ButtonSize,
    getShortcutText,
    I18n,
    type I18nKeys,
    Localize,
    type SplitButton,
} from "@spicy3d/core";
import { createIcon, div, label } from "@spicy3d/element";
import { createDropdownItem, DropdownController, getItemData } from "./dropdownController";
import buttonStyle from "./ribbonButton.module.css";
import style from "./ribbonSplitButton.module.css";

export class RibbonSplitButton extends HTMLElement {
    #primaryIndex = 0;
    #dropdown = new DropdownController(style.dropdown);
    #iconEl?: Element;
    #textEl?: Element;
    #mainEl?: HTMLElement;

    constructor(
        readonly data: SplitButton,
        readonly size: ButtonSize,
    ) {
        super();
        this.initHTML();
    }

    dispose(): void {
        this.#dropdown.dispose();
    }

    private initHTML() {
        if (this.data.items.length === 0) return;

        const isLarge = this.size === "large";
        this.className = isLarge ? style.split : style.splitSmall;

        const { icon: iconName, display, command } = getItemData(this.data.items[0]);

        this.#iconEl = createIcon(iconName);
        this.#iconEl.classList.add(isLarge ? buttonStyle.icon : buttonStyle.smallIcon);

        // large split buttons are icon-only; the name lives in the tooltip
        if (!isLarge) {
            this.#textEl = label({ className: style.smallText, textContent: new Localize(display) });
        }

        this.#mainEl = div(
            {
                className: isLarge ? style.mainArea : style.smallMainArea,
                onclick: (e) => {
                    e.stopPropagation();
                    this.executePrimary();
                },
            },
            this.#iconEl,
            ...(this.#textEl ? [this.#textEl] : []),
        );
        this.setTooltip(display, command);

        this.append(
            this.#mainEl,
            div(
                {
                    className: isLarge ? style.arrowButton : style.smallArrowButton,
                    onclick: (e) => {
                        e.stopPropagation();
                        if (this.#dropdown.isOpened) {
                            this.#dropdown.close();
                        } else {
                            this.openDropdown();
                        }
                    },
                },
                div({ className: isLarge ? style.arrow : style.smallArrow }),
            ),
        );
    }

    private executePrimary() {
        const item = this.data.items[this.#primaryIndex];
        if (!item) return;
        getItemData(item).onClick();
    }

    private openDropdown() {
        if (this.#dropdown.isOpened || this.data.items.length === 0) return;

        this.#dropdown.open(this, (dropdown) => {
            for (const [i, item] of this.data.items.entries()) {
                dropdown.append(
                    createDropdownItem(
                        item,
                        () => {
                            this.switchPrimary(i);
                            this.#dropdown.close();
                        },
                        {
                            item: style.dropdownItem,
                            icon: style.dropdownIcon,
                            text: style.dropdownText,
                        },
                    ),
                );
            }
        });
    }

    private switchPrimary(index: number) {
        if (index === this.#primaryIndex) return;
        this.#primaryIndex = index;

        const item = this.data.items[index];
        if (!item) return;

        const { icon: iconName, display, command } = getItemData(item);
        this.setTooltip(display, command);

        if (this.#iconEl) {
            const newIcon = createIcon(iconName);
            newIcon.classList.add(this.size === "large" ? buttonStyle.icon : buttonStyle.smallIcon);
            this.#iconEl.replaceWith(newIcon);
            this.#iconEl = newIcon;
        }

        if (this.#textEl) {
            const newText = label({ className: style.smallText, textContent: new Localize(display) });
            this.#textEl.replaceWith(newText);
            this.#textEl = newText;
        }
    }

    private setTooltip(display: I18nKeys, command: Parameters<typeof getShortcutText>[0]) {
        if (!this.#mainEl) return;
        const shortcut = getShortcutText(command);
        this.#mainEl.title = shortcut ? `${I18n.translate(display)} (${shortcut})` : I18n.translate(display);
    }
}

customElements.define("ribbon-split-button", RibbonSplitButton);
