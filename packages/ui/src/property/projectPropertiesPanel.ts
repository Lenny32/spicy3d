// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    isLengthUnit,
    LENGTH_UNIT_LABELS,
    LENGTH_UNITS_LIST,
    Localize,
    Transaction,
} from "@spicy3d/core";
import { div, label, option, select, span } from "@spicy3d/element";
import commonStyle from "./common.module.css";
import style from "./projectPropertiesPanel.module.css";

/**
 * The property panel content for the Items tree's Project Properties row: the document's
 * settings. A unit change is one undoable step, and only changes how lengths are shown and
 * typed — the stored model is millimetres whatever this says.
 */
export class ProjectPropertiesPanel extends HTMLElement {
    private readonly unitSelect: HTMLSelectElement;

    constructor(readonly document: IDocument) {
        super();
        this.classList.add(style.root);
        this.unitSelect = select(
            {
                className: style.select,
                onchange: (e) => this.setLengthUnit((e.target as HTMLSelectElement).value),
            },
            ...LENGTH_UNITS_LIST.map((unit) =>
                option({
                    value: unit,
                    selected: unit === document.settings.lengthUnit,
                    textContent: new Localize(LENGTH_UNIT_LABELS[unit]),
                }),
            ),
        );
        this.append(
            label({ className: style.title, textContent: new Localize("project.properties") }),
            div(
                { className: commonStyle.panel },
                span({
                    className: commonStyle.propertyName,
                    textContent: new Localize("project.lengthUnit"),
                }),
                this.unitSelect,
            ),
            span({ className: style.hint, textContent: new Localize("project.lengthUnit.hint") }),
        );
    }

    connectedCallback(): void {
        this.document.settings.onPropertyChanged(this.onSettingsChanged);
    }

    disconnectedCallback(): void {
        this.document.settings.removePropertyChanged(this.onSettingsChanged);
    }

    /** Undo and redo change the setting behind the picker's back; keep it showing the truth. */
    private readonly onSettingsChanged = (property: string) => {
        if (property === "lengthUnit") this.unitSelect.value = this.document.settings.lengthUnit;
    };

    private setLengthUnit(value: string) {
        if (!isLengthUnit(value) || value === this.document.settings.lengthUnit) return;
        Transaction.execute(this.document, "change length unit", () => {
            this.document.settings.lengthUnit = value;
        });
    }
}

customElements.define("spicy-project-properties", ProjectPropertiesPanel);
