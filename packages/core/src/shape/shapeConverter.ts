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
    /**
     * Headless indexed mesh of one shape (3MF): the same OCCT meshing as STL, with coincident
     * vertices merged and collapsed triangles left out. See {@link IndexedMesh}.
     */
    convertToIndexedMesh(shape: IShape, options?: StlTessellationOptions): Result<IndexedMesh>;
}

/**
 * A triangle mesh with shared vertices: `vertices` holds x,y,z per vertex, `triangles` three
 * vertex indices per triangle, counter-clockwise seen from outside. Coordinates are in the
 * shape's unit.
 */
export interface IndexedMesh {
    readonly vertices: Float64Array;
    readonly triangles: Uint32Array;
}

/** Runtime tessellation controls of the meshed exports (STL, 3MF); neither value changes the CAD shape. */
export interface StlTessellationOptions {
    /** Requested linear tessellation deflection in the input shape's coordinate unit (normally mm); finite >= 0.001. */
    linearTolerance?: number;
    /** Angular deflection in degrees; finite > 0 and <= 180. */
    angularTolerance?: number;
}

/** Export formats meshed by OCCT for the file: the ones that take the custom tessellation tolerances. */
export const MESHED_EXPORT_FORMATS: readonly string[] = [".stl", ".stl binary", ".3mf"];
export const MESHED_EXPORT_ONLY_ERROR = "Tessellation tolerances apply only to STL and 3MF exports";

export function isMeshedExportFormat(format: string): boolean {
    return MESHED_EXPORT_FORMATS.includes(format);
}

/** Validate before entering the synchronous kernel mesher. */
export function validateStlTessellation(options?: StlTessellationOptions): string | undefined {
    if (
        options?.linearTolerance !== undefined &&
        (!Number.isFinite(options.linearTolerance) || options.linearTolerance < 0.001)
    ) {
        return "STL linearTolerance must be a finite number of at least 0.001 mm";
    }
    if (
        options?.angularTolerance !== undefined &&
        (!Number.isFinite(options.angularTolerance) ||
            options.angularTolerance <= 0 ||
            options.angularTolerance > 180)
    ) {
        return "STL angularTolerance must be a finite number greater than zero and at most 180 degrees";
    }
    return undefined;
}

export interface StlExportOptions extends StlTessellationOptions {
    /** Binary STL when true (default), ASCII otherwise. */
    binary?: boolean;
    /** Solid name written into the ASCII header (ignored for binary). */
    name?: string;
}
