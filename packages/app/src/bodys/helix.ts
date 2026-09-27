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

export interface HelixOptions {
    document: IDocument;
    origin: XYZ;
    normal: XYZ;
    xDir: XYZ;
    radius: number;
    pitch: number;
    angle: number;
}

@serializable()
export class HelixNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.helix";
    }

    @serialize()
    @property("circle.center", { quantity: "length" })
    get origin(): XYZ {
        return this.getPrivateValue("origin");
    }
    set origin(value: XYZ) {
        this.setPropertyEmitShapeChanged("origin", value);
    }

    @serialize()
    get normal(): XYZ {
        return this.getPrivateValue("normal");
    }

    @serialize()
    get xDir(): XYZ {
        return this.getPrivateValue("xDir");
    }

    @serialize()
    @property("circle.radius", { quantity: "length" })
    get radius() {
        return this.getPrivateValue("radius");
    }
    set radius(value: number) {
        this.setPropertyEmitShapeChanged("radius", value);
    }

    @serialize()
    @property("helix.pitch", { quantity: "length" })
    get pitch() {
        return this.getPrivateValue("pitch");
    }
    set pitch(value: number) {
        this.setPropertyEmitShapeChanged("pitch", value);
    }

    @serialize()
    @property("common.angle")
    get angle() {
        return this.getPrivateValue("angle");
    }
    set angle(value: number) {
        this.setPropertyEmitShapeChanged("angle", value);
    }

    constructor(options: HelixOptions) {
        super({ document: options.document });
        this.setPrivateValue("origin", options.origin);
        this.setPrivateValue("normal", options.normal);
        this.setPrivateValue("xDir", options.xDir);
        this.setPrivateValue("radius", options.radius);
        this.setPrivateValue("pitch", options.pitch);
        this.setPrivateValue("angle", options.angle);
    }

    generateShape(): Result<IShape, string> {
        return shapeFactory.helix(this.origin, this.normal, this.xDir, this.radius, this.pitch, this.angle);
    }
}
