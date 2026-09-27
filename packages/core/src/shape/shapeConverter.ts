// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { Result } from "../foundation";
import type { FolderNode } from "../model";
import type { LengthUnit } from "../units/lengthUnit";
import type { IShape } from "./shape";

/** Options for the formats that record their length unit (STEP, IGES). */
export interface CadExportOptions {
    /**
     * The unit the file is written in. Shapes are millimetres; the writer scales coordinates
     * into this unit and records it in the file, so the physical size is preserved.
     * Millimetres when omitted.
     */
    lengthUnit?: LengthUnit;
}

export interface IShapeConverter {
    convertToIGES(shapes: IShape[], options?: CadExportOptions): Result<string>;
    convertFromIGES(document: IDocument, iges: Uint8Array): Result<FolderNode>;
    convertToSTEP(shapes: IShape[], options?: CadExportOptions): Result<string>;
    convertFromSTEP(document: IDocument, step: Uint8Array): Result<FolderNode>;
    convertToBrep(shape: IShape): Result<string>;
    convertFromBrep(brep: string): Result<IShape>;
    /**
     * Headless STL export: tessellates each shape (OCCT mesh) and writes STL
     * bytes with no visual layer. Binary by default. See {@link StlExportOptions}.
     */
    convertToSTL(shapes: IShape[], options?: StlExportOptions): Result<Uint8Array>;
    convertFromSTL(document: IDocument, stl: Uint8Array): Result<FolderNode>;
}

export interface StlExportOptions {
    /** Binary STL when true (default), ASCII otherwise. */
    binary?: boolean;
    /** Solid name written into the ASCII header (ignored for binary). */
    name?: string;
}
