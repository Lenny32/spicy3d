// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type GeometryNode,
    type IStep,
    type IWire,
    property,
    SelectShapeStep,
    type ShapeType,
    ShapeTypes,
    VisualStates,
} from "@spicy3d/core";
import { SweepedNode } from "../../bodys";
import { CreateFromSelectionCommand } from "../createCommand";

@command({
    key: "create.sweep",
    icon: "icon-sweep",
})
export class Sweep extends CreateFromSelectionCommand {
    @property("option.command.isRoundCorner")
    get round() {
        return this.getPrivateValue("round", false);
    }

    set round(value: boolean) {
        this.setProperty("round", value);
    }

    protected override geometryNode(): GeometryNode {
        const path = this.transformdFirstShape(this.stepDatas[0], false) as IWire;
        const shapes = this.transformdShapes(this.stepDatas[1], false) as IWire[];
        return new SweepedNode({
            document: this.document,
            profile: shapes,
            path,
            round: this.round,
        });
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectShapeStep((ShapeTypes.edge | ShapeTypes.wire) as ShapeType, "prompt.select.path"),
            new SelectShapeStep((ShapeTypes.edge | ShapeTypes.wire) as ShapeType, "prompt.select.section", {
                multiple: true,
                beforeSelection: () => this.addFirstSelectedState(VisualStates.edgeSelected),
                afterSelection: () => this.removeFirstSelectedState(VisualStates.edgeSelected),
            }),
        ];
    }
}
