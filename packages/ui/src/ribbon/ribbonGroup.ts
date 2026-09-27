// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    Localize,
    ObservableCollection,
    type PushButton,
    type RibbonCommand,
    type RibbonGroup,
} from "@spicy3d/core";
import { collection, div, label } from "@spicy3d/element";
import { createDropdownItem, DropdownController } from "./dropdownController";
import { RibbonPushButton } from "./ribbonButton";
import style from "./ribbonGroup.module.css";
import { RibbonPulldownButton } from "./ribbonPulldownButton";
import { RibbonSplitButton } from "./ribbonSplitButton";
import { RibbonStack } from "./ribbonStack";

/** `iconOnly` drops the names of stacked small buttons (large buttons are always icon-only). */
export function createRibbonButton(item: RibbonCommand, iconOnly = false): HTMLElement {
    if (typeof item === "string") {
        return RibbonPushButton.fromCommandName(item, "large")!;
    } else if (item instanceof ObservableCollection) {
        const stack = new RibbonStack();
        item.forEach((b) => {
            const button = RibbonPushButton.fromCommandName(b, "small", iconOnly);
            if (button) stack.append(button);
        });
        return stack;
    } else if (item.type === "push") {
        return new RibbonPushButton(item.command, item.icon, "large", item.onClick, item.display);
    } else if (item.type === "pulldown") {
        return new RibbonPulldownButton(item, "large");
    } else if (item.type === "split") {
        return new RibbonSplitButton(item, "large");
    } else {
        throw new Error("unknown ribbon button type");
    }
}

type MenuItem = PushButton | CommandKeys;

/** Every command a group's buttons reach — stacks, split and pulldown buttons expanded. */
export function flattenGroupItems(items: Iterable<RibbonCommand>): MenuItem[] {
    const result: MenuItem[] = [];
    for (const item of items) {
        if (typeof item === "string") {
            result.push(item);
        } else if (item instanceof ObservableCollection) {
            result.push(...item);
        } else if (item.type === "push") {
            result.push(item);
        } else {
            result.push(...item.items);
        }
    }
    return result;
}

const menuKey = (item: MenuItem) => (typeof item === "string" ? item : item.command);

/** The group ▼ menu: flattened buttons, then the menu-only items, each command listed once. */
export function groupMenuItems(group: RibbonGroup): { items: MenuItem[]; collapsed: MenuItem[] } {
    const seen = new Set<CommandKeys>();
    const unique = (list: MenuItem[]) =>
        list.filter((item) => {
            const key = menuKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    const items = unique(flattenGroupItems(group.items));
    return { items, collapsed: unique([...group.collapsedItems]) };
}

export class RibbonGroupElement extends HTMLElement {
    #dropdown = new DropdownController(style.collapsedDropdown);

    constructor(readonly group: RibbonGroup) {
        super();
        this.className = group.primary ? `${style.ribbonGroup} ${style.finish}` : style.ribbonGroup;
        this.initHTML();
    }

    dispose(): void {
        this.#dropdown.dispose();
    }

    private initHTML() {
        this.append(
            collection({
                className: style.content,
                sources: this.group.items,
                template: (item) => createRibbonButton(item, this.group.iconOnly),
            }),
            div(
                { className: style.headerContainer, onclick: this.toggleDropdown },
                label({ className: style.header, textContent: new Localize(this.group.groupName) }),
                div({ className: style.arrow }),
            ),
        );
    }

    private readonly toggleDropdown = (e: MouseEvent) => {
        e.stopPropagation();
        if (this.#dropdown.isOpened) {
            this.#dropdown.close();
        } else {
            this.openDropdown(e.currentTarget as HTMLElement);
        }
    };

    private openDropdown(anchorEl: HTMLElement) {
        const { items, collapsed } = groupMenuItems(this.group);
        if (this.#dropdown.isOpened || items.length + collapsed.length === 0) return;

        const classes = {
            item: style.collapsedDropdownItem,
            icon: style.collapsedDropdownIcon,
            text: style.collapsedDropdownText,
        };
        this.#dropdown.open(anchorEl, (dropdown) => {
            const close = () => this.#dropdown.close();
            for (const item of items) dropdown.append(createDropdownItem(item, close, classes));
            if (items.length > 0 && collapsed.length > 0) {
                dropdown.append(div({ className: style.separator }));
            }
            for (const item of collapsed) dropdown.append(createDropdownItem(item, close, classes));
        });
    }
}

customElements.define("ribbon-group", RibbonGroupElement);
