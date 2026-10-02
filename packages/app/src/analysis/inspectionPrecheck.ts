// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, precheckInspectionShapes, type Result } from "@spicy3d/core";

export function inspectionPrecheck(
    shapes: IShape[],
    signal: AbortSignal,
): Promise<Result<ReadonlySet<IShape>>> {
    return precheckInspectionShapes(shapes, shapeFactory, signal);
}
