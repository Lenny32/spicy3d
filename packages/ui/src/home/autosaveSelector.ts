// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AUTOSAVE_INTERVALS,
    type AutosaveInterval,
    AutosaveSettings,
    autosaveIntervalLabel,
    I18n,
} from "@spicy3d/core";
import { option, select } from "@spicy3d/element";

/**
 * The autosave interval (Off, 1…30 minutes). Signed out it is kept in this browser; signed in the
 * account's value shows and a change goes to the server, so both stay in step.
 */
export class AutosaveSelector extends HTMLElement {
    readonly select: HTMLSelectElement;

    constructor(private readonly settings: AutosaveSettings = AutosaveSettings.current) {
        super();
        this.select = select(
            {
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
        this.select.setAttribute("aria-label", I18n.translate("autosave.setting"));
        this.append(this.select);
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

customElements.define("spicy-autosave-selector", AutosaveSelector);
