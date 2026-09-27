// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AUTOSAVE_INTERVALS,
    type AutosaveInterval,
    type AutosaveSettings,
    autosaveIntervalLabel,
    I18n,
} from "@spicy3d/core";
import { label, option, select, span } from "@spicy3d/element";
import style from "../ui/account.module.css";
import type { AccountSettingsSection } from "../ui/accountSettings";
import { paragraph } from "../ui/forms";
import type { CloudUserSettings } from "./userSettings";

/** The interval drop-down, kept in step with the setting while shown. */
export class AutosaveIntervalField extends HTMLElement {
    readonly select: HTMLSelectElement;

    constructor(private readonly settings: AutosaveSettings) {
        super();
        this.select = select(
            {
                name: "autosaveInterval",
                onchange: () => {
                    this.settings.intervalMinutes = Number(this.select.value) as AutosaveInterval;
                },
            },
            ...AUTOSAVE_INTERVALS.map((interval) =>
                option({
                    value: String(interval),
                    textContent: I18n.translate(...autosaveIntervalLabel(interval)),
                }),
            ),
        ) as HTMLSelectElement;
        this.append(
            label(
                { className: style.field },
                span({ textContent: I18n.translate("autosave.setting") }),
                this.select,
            ),
        );
        this.update();
    }

    connectedCallback(): void {
        this.settings.onPropertyChanged(this.update);
        this.update();
    }

    disconnectedCallback(): void {
        this.settings.removePropertyChanged(this.update);
    }

    private readonly update = () => {
        this.select.value = String(this.settings.intervalMinutes);
    };
}

customElements.define("spicy-cloud-autosave-interval", AutosaveIntervalField);

/** The account settings' autosave section; opening it re-reads the server's value. */
export function autosaveSection(userSettings: CloudUserSettings): AccountSettingsSection {
    return {
        id: "autosave",
        title: "account.settings.autosave",
        render: () => {
            void userSettings.refresh();
            const root = document.createElement("div");
            root.append(
                new AutosaveIntervalField(userSettings.settings),
                paragraph("account.settings.autosaveHint"),
            );
            return root;
        },
    };
}
