// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type IDocument,
    type IFace,
    PubSub,
    pickedTopologyIndex,
    SelectShapeStep,
    ShapeNode,
    ShapeTypes,
} from "@spicy3d/core";
import type { EdgeRef } from "../features/edgeRef";
import type { LoftSection, SweepFeatureData } from "../features/feature";
import { capturePathReference } from "../features/pathReferences";
import { captureProfileRef } from "../features/profileRef";
import { SketchNode } from "../sketch/sketchNode";
import { SELECTED_PROFILE_STATE } from "./extrudeDragStep";

export async function pickSweepSection(
    document: IDocument,
    controller: AsyncController,
): Promise<LoftSection | undefined> {
    const picked = await new SelectShapeStep(ShapeTypes.face, "prompt.select.sweepSection", {
        nodeFilter: { allow: (node) => node instanceof SketchNode },
        shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
        selectedState: SELECTED_PROFILE_STATE,
    }).execute(document, controller);
    const sketch = picked?.nodes?.[0];
    const face = picked?.shapes[0]?.shape;
    return sketch instanceof SketchNode && face?.shapeType === ShapeTypes.face
        ? { sketchId: sketch.id, profile: captureProfileRef(face as IFace) }
        : undefined;
}

/** One edge per pick preserves authored traversal order, including the direction of the first edge. */
export async function pickSweepPath(
    document: IDocument,
    controller: () => AsyncController,
    changed?: (path: SweepFeatureData["path"]) => void,
): Promise<SweepFeatureData["path"] | undefined> {
    let source: ShapeNode | undefined;
    const edges: EdgeRef[] = [];
    while (true) {
        const current = controller();
        const picked = await new SelectShapeStep(ShapeTypes.edge, "prompt.select.sweepPath", {
            nodeFilter: { allow: (node) => node instanceof ShapeNode && (!source || node === source) },
        }).execute(document, current);
        if (!picked)
            return current.result?.status === "success" && source && edges.length
                ? { nodeId: source.id, edges }
                : undefined;
        for (const shape of picked.shapes) {
            const node = shape.owner.node;
            if (!(node instanceof ShapeNode) || (source && node !== source)) {
                PubSub.default.pub(
                    "showToast",
                    "error.default:{0}",
                    "A sweep path must belong to one source node",
                );
                continue;
            }
            const index = pickedTopologyIndex(shape);
            if (index === undefined) {
                PubSub.default.pub("showToast", "error.default:{0}", "Path pick has no topology index");
                continue;
            }
            const captured = capturePathReference(node, index);
            if (!captured.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", captured.error);
                continue;
            }
            if (edges.length === 256) {
                PubSub.default.pub(
                    "showToast",
                    "error.default:{0}",
                    "A sweep path exceeds the 256-edge pick limit",
                );
                return undefined;
            }
            source = node;
            edges.push(captured.value);
            changed?.({ nodeId: node.id, edges: [...edges] });
        }
    }
}
