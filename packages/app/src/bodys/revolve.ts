// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDocument,
    type IShape,
    type Line,
    ParameterShapeNode,
    Result,
    ShapeTypes,
    serializable,
    serialize,
} from "@spicy3d/core";
import { closedProfileToFace } from "./extrude";

export interface RevolveOptions {
    document: IDocument;
    profile: IShape;
    axis: Line;
    angle: number;
}

@serializable()
export class RevolvedNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.revol";
    }

    @serialize()
    get profile() {
        return this.getPrivateValue("profile");
    }
    set profile(value: IShape) {
        this.setPropertyEmitShapeChanged("profile", value);
    }

    @serialize()
    get axis() {
        return this.getPrivateValue("axis");
    }
    set axis(value: Line) {
        this.setPropertyEmitShapeChanged("axis", value);
    }

    @serialize()
    get angle() {
        return this.getPrivateValue("angle");
    }
    set angle(value: number) {
        this.setPropertyEmitShapeChanged("angle", value);
    }

    constructor(options: RevolveOptions) {
        super({ document: options.document });
        this.setPrivateValue("profile", options.profile);
        this.setPrivateValue("axis", options.axis);
        this.setPrivateValue("angle", options.angle);
    }

    override generateShape(): Result<IShape> {
        if (
            (this.profile.shapeType === ShapeTypes.wire || this.profile.shapeType === ShapeTypes.edge) &&
            this.profile.isClosed()
        ) {
            // Revolving a closed profile (wire or circle edge) as a face produces a solid instead of a shell.
            const face = closedProfileToFace(this.profile);
            if (!face.isOk) return Result.err(face.error);
            return shapeFactory.revolve(face.value, this.axis, this.angle);
        }
        return shapeFactory.revolve(this.profile, this.axis, this.angle);
    }
}
