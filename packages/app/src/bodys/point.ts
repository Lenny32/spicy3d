// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDocument,
    type IShape,
    ParameterShapeNode,
    property,
    type Result,
    serializable,
    serialize,
    type XYZ,
} from "@spicy3d/core";

export interface PointOptions {
    document: IDocument;
    position: XYZ;
}

@serializable()
export class PointNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.point";
    }

    @serialize()
    @property("point.position", { quantity: "length" })
    get position() {
        return this.getPrivateValue("position");
    }
    set position(pnt: XYZ) {
        this.setPropertyEmitShapeChanged("position", pnt);
    }

    constructor(options: PointOptions) {
        super({ document: options.document });
        this.setPrivateValue("position", options.position);
    }

    generateShape(): Result<IShape, string> {
        return shapeFactory.point(this.position);
    }
}
