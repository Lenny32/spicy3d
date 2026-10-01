// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type I18nKeys,
    type IDocument,
    pickedTopologyIndex,
    Result,
    SelectShapeStep,
    ShapeNode,
    ShapeTypes,
} from "@spicy3d/core";
import type { LoftFeatureData } from "../features/feature";
import { capturePathReference } from "../features/pathReferences";

export async function pickGuidedLoftPath(
    document: IDocument,
    controller: AsyncController,
    prompt: I18nKeys,
): Promise<Result<NonNullable<LoftFeatureData["guided"]>["spine"]> | undefined> {
    const picked = await new SelectShapeStep(ShapeTypes.edge, prompt, { multiple: true }).execute(
        document,
        controller,
    );
    if (!picked || picked.shapes.length === 0) return undefined;
    const source = picked.shapes[0].owner.node;
    if (!(source instanceof ShapeNode)) return Result.err("Pick a guided loft path from one shape node");
    if (picked.shapes.length > 128) return Result.err("Guided loft paths exceed the 128-reference limit");
    const indexes: number[] = [];
    for (const shape of picked.shapes) {
        const index = pickedTopologyIndex(shape);
        if (shape.owner.node !== source || index === undefined)
            return Result.err("Select an ordered edge path from one node");
        indexes.push(index);
    }
    const edges = [];
    for (const index of indexes) {
        const edge = capturePathReference(source, index);
        if (!edge.isOk) return Result.err(edge.error);
        edges.push(edge.value);
    }
    return Result.ok({ nodeId: source.id, edges });
}
