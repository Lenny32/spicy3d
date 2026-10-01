// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type IDocument,
    pickedTopologyIndex,
    SelectShapeStep,
    ShapeTypes,
} from "@spicy3d/core";
import type { FaceSweepFeatureData } from "../features/feature";
import { captureProjectionTarget } from "../features/projectionTargetReferences";
import { ParametricBodyNode } from "../parametricBodyNode";

export async function pickFaceSweepSupport(
    document: IDocument,
    controller: AsyncController,
    host?: ParametricBodyNode,
): Promise<{ body: ParametricBodyNode; support: FaceSweepFeatureData["support"] } | undefined> {
    const picked = await new SelectShapeStep(ShapeTypes.face, "prompt.select.faceSweepSupport", {
        nodeFilter: { allow: (node) => node instanceof ParametricBodyNode && (!host || node === host) },
    }).execute(document, controller);
    const body = picked?.nodes?.[0];
    const shape = picked?.shapes[0];
    if (!(body instanceof ParametricBodyNode) || !shape) return undefined;
    const index = pickedTopologyIndex(shape);
    if (index === undefined) throw new Error("Support pick has no face topology index");
    const captured = captureProjectionTarget(body, index);
    if (!captured.isOk) throw new Error(captured.error);
    return { body, support: captured.value };
}
