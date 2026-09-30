// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ButtonSize,
    type CommandData,
    type CommandIcon,
    type CommandKeys,
    CommandStore,
    getShortcutText,
    I18n,
    type I18nKeys,
    type IConverter,
    Localize,
    Logger,
    PubSub,
    Result,
} from "@spicy3d/core";
import { createIcon, label } from "@spicy3d/element";
import style from "./ribbonButton.module.css";

/**
 * A command's ribbon tooltip: its name, its shortcut in parentheses, and on the next line the
 * command's `helpText` (what it does) when it has one.
 */
export function commandTooltip(display: I18nKeys, command: CommandKeys): string {
    const shortcut = getShortcutText(command);
    const name = shortcut ? `${I18n.translate(display)} (${shortcut})` : I18n.translate(display);
    const help = CommandStore.getComandData(command)?.helpText;
    return help === undefined ? name : `${name}\n${I18n.translate(help)}`;
}

export class RibbonPushButton extends HTMLElement {
    #shortcut?: string;
    #display?: I18nKeys;
    get shortcut() {
        return this.#shortcut;
    }

    constructor(
        readonly commandName: CommandKeys,
        icon: CommandIcon,
        size: ButtonSize,
        readonly onClick: () => void,
        display?: I18nKeys,
        iconOnly = false,
    ) {
        super();
        this.initHTML(display ?? `command.${commandName}`, icon, size, iconOnly);
        this.addEventListener("click", onClick);
    }

    /** Large buttons are icon-only; small ones show their name unless `iconOnly` is set. */
    static fromCommandName(commandName: CommandKeys, size: ButtonSize, iconOnly = false) {
        const data = CommandStore.getComandData(commandName);
        if (!data) {
            Logger.warn(`commandData of ${commandName} is undefined`);
            return undefined;
        }
        if (data.toggle) {
            return new RibbonToggleButton(data, size, iconOnly);
        }

        return new RibbonPushButton(
            data.key,
            data.icon,
            size,
            () => {
                PubSub.default.pub("executeCommand", commandName);
            },
            undefined,
            iconOnly,
        );
    }

    dispose(): void {
        this.removeEventListener("click", this.onClick);
    }

    private initHTML(display: I18nKeys, icon: CommandIcon, size: ButtonSize, iconOnly: boolean) {
        const image = createIcon(icon);
        this.className = size === "large" ? style.normal : style.small;
        image.classList.add(size === "large" ? style.icon : style.smallIcon);

        this.#display = display;
        I18n.set(this, "title", display);
        this.updateShortcut();

        this.append(image);
        if (size === "small" && !iconOnly) {
            this.append(label({ className: style.smallButtonText, textContent: new Localize(display) }));
        } else {
            this.classList.add(style.iconOnly);
        }
    }

    updateShortcut() {
        this.#shortcut = getShortcutText(this.commandName) || undefined;
        if (this.#display !== undefined) this.title = commandTooltip(this.#display, this.commandName);
    }
}

customElements.define("ribbon-button", RibbonPushButton);

class ToggleConverter implements IConverter {
    constructor(
        readonly className: string,
        readonly active: string,
    ) {}
    convert(isChecked: boolean): Result<string, string> {
        return isChecked ? Result.ok(`${this.className} ${this.active}`) : Result.ok(this.className);
    }
}

export class RibbonToggleButton extends RibbonPushButton {
    constructor(data: CommandData, size: ButtonSize, iconOnly = false) {
        super(
            data.key,
            data.icon,
            size,
            () => {
                PubSub.default.pub("executeCommand", data.key);
            },
            undefined,
            iconOnly,
        );

        if (data.toggle) {
            data.toggle.converter = new ToggleConverter(this.className, style.checked);
            data.toggle.setBinding(this, "className");
        }
    }
}

customElements.define("ribbon-toggle-button", RibbonToggleButton);
