// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { HistoryObservable } from "../foundation/observer";
import { DEFAULT_LENGTH_UNIT, isLengthUnit, type LengthUnit } from "./lengthUnit";

/** How project settings are stored in a document file. Every field is optional on read. */
export interface ProjectSettingsData {
    readonly lengthUnit?: LengthUnit;
}

/**
 * Per-project preferences, shown under the Items tree's Project Properties row. A change is
 * an ordinary undoable property edit, and it is display-only: stored geometry stays in
 * millimetres whatever unit the project is read in.
 */
export class ProjectSettings extends HistoryObservable {
    constructor(document: IDocument, data?: unknown) {
        super(document);
        this.load(data);
    }

    get lengthUnit(): LengthUnit {
        return this.getPrivateValue("lengthUnit", DEFAULT_LENGTH_UNIT);
    }
    set lengthUnit(value: LengthUnit) {
        // A setter reached from a hand-edited file or a plugin must not store a unit no
        // conversion knows — every display would then divide by `undefined`.
        if (!isLengthUnit(value)) return;
        this.setProperty("lengthUnit", value);
    }

    /**
     * Restores stored settings without recording history. A file from before project settings
     * existed has no entry at all, and a damaged one may hold anything — both read as defaults.
     */
    load(data: unknown): void {
        const stored = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
        this.setPrivateValue(
            "lengthUnit",
            isLengthUnit(stored["lengthUnit"]) ? stored["lengthUnit"] : DEFAULT_LENGTH_UNIT,
        );
    }

    toData(): ProjectSettingsData {
        return { lengthUnit: this.lengthUnit };
    }
}

/**
 * The unit a document displays lengths in. Tolerant of documents built without settings
 * (lightweight test doubles, plugins' own `IDocument`s): those read as millimetres.
 */
export function documentLengthUnit(document: IDocument | undefined): LengthUnit {
    return document?.settings?.lengthUnit ?? DEFAULT_LENGTH_UNIT;
}
