// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ButtonSize, type CommandIcon, I18n, Localize, type PulldownButton } from "@spicy3d/core";
import { createIcon, div, label } from "@spicy3d/element";
import { createDropdownItem, DropdownController } from "./dropdownController";
import buttonStyle from "./ribbonButton.module.css";
import style from "./ribbonPulldownButton.module.css";

export class RibbonPulldownButton extends HTMLElement {
    #dropdown = new DropdownController(style.dropdown);

    constructor(
        readonly data: PulldownButton,
        readonly size: ButtonSize,
    ) {
        super();
        this.initHTML();
        this.addEventListener("click", this.toggleDropdown);
    }

    dispose(): void {
        this.#dropdown.dispose();
        this.removeEventListener("click", this.toggleDropdown);
    }

    private initHTML() {
        const icon = createIcon(this.data.icon as CommandIcon);
        this.className = this.size === "large" ? style.pulldown : style.pulldownSmall;
        icon.classList.add(this.size === "large" ? buttonStyle.icon : buttonStyle.smallIcon);

        // large pulldowns are icon-only; the name lives in the tooltip
        I18n.set(this, "title", this.data.display);
        this.append(icon);
        if (this.size !== "large") {
            this.append(label({ className: style.smallText, textContent: new Localize(this.data.display) }));
        }
        this.append(div({ className: this.size === "large" ? style.arrow : style.smallArrow }));
    }

    private readonly toggleDropdown = (e: Event) => {
        e.stopPropagation();
        if (this.#dropdown.isOpened) {
            this.#dropdown.close();
        } else {
            this.openDropdown();
        }
    };

    private openDropdown() {
        if (this.#dropdown.isOpened || this.data.items.length === 0) return;

        this.#dropdown.open(this, (dropdown) => {
            for (const item of this.data.items) {
                dropdown.append(
                    createDropdownItem(item, () => this.#dropdown.close(), {
                        item: style.dropdownItem,
                        icon: style.dropdownIcon,
                        text: style.dropdownText,
                    }),
                );
            }
        });
    }
}

customElements.define("ribbon-pulldown-button", RibbonPulldownButton);
