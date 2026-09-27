// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { VisualNode } from "../model";

export interface MeshExportOptions {
    /**
     * Factor applied to every coordinate. The scene is in millimetres; a file written in
     * centimetres uses `0.1`. Mesh formats carry no unit, so this is the whole conversion.
     */
    scale?: number;
}

export interface IMeshExporter {
    exportToStl(node: VisualNode[], asciiMode: boolean, options?: MeshExportOptions): Result<BlobPart>;
    exportToPly(node: VisualNode[], asciiMode: boolean, options?: MeshExportOptions): Result<BlobPart>;
    exportToObj(node: VisualNode[], options?: MeshExportOptions): Result<BlobPart>;
}
