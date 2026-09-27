// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import type { VisualNode } from "./model";
import type { LengthUnit } from "./units/lengthUnit";

/**
 * How an export format deals with length units — what the export dialog tells the user:
 *
 * - `embedded`: the file records its unit (STEP, IGES). Coordinates are written in the chosen
 *   unit and importers scale them back, so the physical size is preserved on its own.
 * - `none`: the file is bare numbers (STL, OBJ, PLY, BREP). Coordinates are written in the
 *   chosen unit, and the importing application must be told that same unit.
 * - `fixed`: the format mandates one unit; coordinates are always converted to it.
 */
export type ExportUnitHandling =
    | { readonly kind: "embedded" }
    | { readonly kind: "none" }
    | { readonly kind: "fixed"; readonly unit: LengthUnit };

export interface DataExportOptions {
    /**
     * The unit the file's coordinates are written in; millimetres when omitted. Ignored by a
     * `fixed` format. Models are millimetres internally, so any other unit is a conversion.
     */
    readonly lengthUnit?: LengthUnit;
}

export interface IDataExchange {
    importFormats(): string[];
    exportFormats(): string[];
    /** How `type` handles units; see `ExportUnitHandling`. */
    exportUnitHandling(type: string): ExportUnitHandling;
    import(document: IDocument, files: FileList | File[]): Promise<void>;
    export(type: string, nodes: VisualNode[], options?: DataExportOptions): Promise<BlobPart[] | undefined>;
}

/** The unit an export of `handling` actually writes, given the one asked for. */
export function exportLengthUnit(
    handling: ExportUnitHandling,
    requested: LengthUnit | undefined,
): LengthUnit {
    return handling.kind === "fixed" ? handling.unit : (requested ?? "mm");
}
