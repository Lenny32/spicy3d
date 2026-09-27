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

export interface SphereNodeOptions {
    document: IDocument;
    center: XYZ;
    radius: number;
}

@serializable()
export class SphereNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.sphere";
    }

    @serialize()
    @property("circle.center", { quantity: "length" })
    get center() {
        return this.getPrivateValue("center");
    }
    set center(center: XYZ) {
        this.setPropertyEmitShapeChanged("center", center);
    }

    @serialize()
    @property("circle.radius", { quantity: "length" })
    get radius() {
        return this.getPrivateValue("radius");
    }
    set radius(value: number) {
        this.setPropertyEmitShapeChanged("radius", value);
    }

    constructor(options: SphereNodeOptions) {
        super(options);
        this.setPrivateValue("center", options.center);
        this.setPrivateValue("radius", options.radius);
    }

    generateShape(): Result<IShape> {
        return shapeFactory.sphere(this.center, this.radius);
    }
}
