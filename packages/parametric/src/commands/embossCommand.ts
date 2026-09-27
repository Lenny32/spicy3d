// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    Id,
    type IFace,
    type INode,
    type IStep,
    LENGTH_UNITS,
    Matrix4,
    MultistepCommand,
    type ParameterValue,
    PubSub,
    property,
    SelectShapeStep,
    ShapeTypes,
    Transaction,
    type VisualShapeData,
} from "@spicy3d/core";
import { captureEmbossFaceRef } from "../features/emboss";
import type { EmbossFeatureData } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { captureProfileRef } from "../features/profileRef";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { SelectSketchProfilesStep } from "./extrudeCommand";

/**
 * Emboss / deboss (Fusion-style): pick the sketch profiles (or a whole sketch — texts included),
 * then the faces of a parametric body they project onto; the feature is appended to that body.
 * The relief follows the faces, so a profile over a cylinder wraps around it.
 */
@command({ key: "feature.emboss", icon: "icon-emboss" })
export class EmbossFeatureCommand extends MultistepCommand {
    @property("option.command.depth", { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this.getPrivateValue("depth", 1);
    }
    set depth(value: ParameterValue) {
        this.setProperty("depth", value);
    }

    @property("option.command.deboss")
    get deboss(): boolean {
        return this.getPrivateValue("deboss", false);
    }
    set deboss(value: boolean) {
        this.setProperty("deboss", value);
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectSketchProfilesStep((node) => node instanceof SketchNode),
            new SelectShapeStep(ShapeTypes.face, "prompt.select.embossFaces", {
                multiple: true,
                nodeFilter: { allow: (node: INode) => this.allowTarget(node) },
            }),
        ];
    }

    /** Faces of one parametric body — the first picked face's. */
    private allowTarget(node: INode): boolean {
        if (!(node instanceof ParametricBodyNode)) return false;
        const first = this.document.selection
            .getSelectedShapes()
            .find((x) => x.owner.node instanceof ParametricBodyNode)?.owner.node;
        return first === undefined || first === node;
    }

    protected override executeMainTask(): void {
        const depth = this.resolveParameter(this.depth, LENGTH_UNITS);
        if (!depth.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", depth.error);
            return;
        }
        if (!(depth.value > 0)) {
            PubSub.default.pub("showToast", "error.input.invalidNumber");
            return;
        }
        const sketch = this.stepDatas[0].nodes![0] as unknown as SketchNode;
        const picked = this.stepDatas[1].shapes;
        const body = picked[0]?.owner.node;
        if (!(body instanceof ParametricBodyNode)) return;
        const feature = buildEmbossFeature(
            sketch,
            this.stepDatas[0].shapes.map((x) => x.shape as unknown as IFace),
            body,
            picked.filter((x) => x.owner.node === body),
            this.depth,
            this.deboss,
        );
        Transaction.execute(this.document, "excute feature.emboss", () => {
            body.setFeaturesEmitShapeChanged([...body.features, feature]);
            // The sketch is consumed by the feature; hide it with the same undo step.
            sketch.visible = false;
            this.document.visual.update();
        });
    }
}

/**
 * The emboss feature for the picked sketch profiles (none = the whole sketch) and body faces:
 * the faces are fingerprinted in world coordinates with their tracked ids, like press-pull.
 */
export function buildEmbossFeature(
    sketch: SketchNode,
    profileFaces: IFace[],
    body: ParametricBodyNode,
    faces: VisualShapeData[],
    depth: ParameterValue,
    deboss: boolean,
): EmbossFeatureData {
    const refs = faces.map((data) => {
        const face = data.shape as unknown as IFace;
        const world = data.transform.equals(Matrix4.identity())
            ? face
            : (face.transformedMul(data.transform) as IFace);
        try {
            const faceId = body.faceIdAt(data.indexes[0]);
            if (faceId === undefined) reportSilentIdLoss(body, "face", "an emboss face has no tracked id");
            return captureEmbossFaceRef(world, faceId, body.faceIdIsShared(faceId));
        } finally {
            if (world !== face) world.dispose();
        }
    });
    return {
        id: Id.generate(),
        type: "emboss",
        sketchId: sketch.id,
        ...(profileFaces.length > 0 ? { profiles: profileFaces.map((face) => captureProfileRef(face)) } : {}),
        faces: refs,
        depth,
        ...(deboss ? { deboss: true } : {}),
    };
}
