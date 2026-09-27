// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type GeometryNode,
    GeometryUtils,
    type IFace,
    type IShape,
    type IStep,
    type LengthAtAxisSnapData,
    LengthAtAxisStep,
    Precision,
    SelectShapeStep,
    type ShapeType,
    ShapeTypes,
} from "@spicy3d/core";
import { closedProfileToFace, ExtrudeNode } from "../../bodys";
import { CreateFromSelectionCommand } from "../createCommand";

@command({
    key: "create.extrude",
    icon: "icon-prism",
})
export class ExtrudeCommand extends CreateFromSelectionCommand {
    protected override geometryNode(): GeometryNode {
        const shape = this.transformdFirstShape(this.stepDatas[0], false);
        const { point, normal } = this.getAxis(shape);
        const dist = this.stepDatas[1].point!.sub(point).dot(normal);
        return new ExtrudeNode({ document: this.document, section: shape, length: dist });
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectShapeStep(
                (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.wire) as ShapeType,
                "prompt.select.shape",
            ),
            new LengthAtAxisStep("prompt.pickNextPoint", this.getLengthStepData, true),
        ];
    }

    private readonly getLengthStepData = (): LengthAtAxisSnapData => {
        const shape = this.transformdFirstShape(this.stepDatas[0]);
        const { point, normal } = this.getAxis(shape);
        return {
            point,
            direction: normal,
            preview: (p) => {
                if (!p) return [];
                const dist = p.sub(point).dot(normal);
                if (Math.abs(dist) < Precision.Float) return [];
                const vec = normal.multiply(dist);
                if (shape.shapeType === ShapeTypes.face) {
                    const sur = (shape as IFace).surface();
                    if (!sur.isPlanar()) {
                        return [this.meshCreatedShape("makeThickSolidBySimple", shape, dist)];
                    }
                } else if (
                    (shape.shapeType === ShapeTypes.wire || shape.shapeType === ShapeTypes.edge) &&
                    shape.isClosed()
                ) {
                    const face = closedProfileToFace(shape);
                    if (face.isOk) {
                        return [this.meshCreatedShape("prism", face.value, vec)];
                    }
                }
                return [this.meshCreatedShape("prism", shape, vec)];
            },
        };
    };

    private getAxis(shape: IShape) {
        const point = this.stepDatas[0].shapes[0].point!;
        const normal = GeometryUtils.normal(shape as any);
        return { point, normal };
    }
}
