// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryUtils,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IWire,
    ParameterShapeNode,
    property,
    Result,
    ShapeTypes,
    serializable,
    serialize,
} from "@spicy3d/core";

export interface PrismOptions {
    document: IDocument;
    section: IShape;
    length: number;
}

/**
 * Convert a closed profile to a face. A wire is used directly; a closed edge
 * (e.g. a circle) is first built into a wire.
 */
export function closedProfileToFace(section: IShape): Result<IFace> {
    if (section.shapeType === ShapeTypes.wire) {
        return shapeFactory.face([section as IWire]);
    }
    const wire = shapeFactory.wire([section as IEdge]);
    if (!wire.isOk) return Result.err(wire.error);
    return shapeFactory.face([wire.value]);
}

@serializable()
export class ExtrudeNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.extrude";
    }

    @serialize()
    get section(): IShape {
        return this.getPrivateValue("section");
    }
    set section(value: IShape) {
        this.setPropertyEmitShapeChanged("section", value);
    }

    @serialize()
    @property("common.length", { quantity: "length" })
    get length(): number {
        return this.getPrivateValue("length");
    }
    set length(value: number) {
        this.setPropertyEmitShapeChanged("length", value);
    }

    constructor(options: PrismOptions) {
        super({ document: options.document });
        this.setPrivateValue("section", options.section);
        this.setPrivateValue("length", options.length);
    }

    override generateShape(): Result<IShape> {
        const normal = GeometryUtils.normal(this.section as any);
        const vec = normal.multiply(this.length);
        if (this.section.shapeType === ShapeTypes.face) {
            const sur = (this.section as IFace).surface();
            if (!sur.isPlanar()) {
                return shapeFactory.makeThickSolidBySimple(this.section, this.length);
            }
        } else if (
            (this.section.shapeType === ShapeTypes.wire || this.section.shapeType === ShapeTypes.edge) &&
            this.section.isClosed()
        ) {
            // Extruding a closed profile (wire or circle edge) as a face produces a solid instead of a shell.
            const face = closedProfileToFace(this.section);
            if (!face.isOk) return Result.err(face.error);
            return shapeFactory.prism(face.value, vec);
        }
        return shapeFactory.prism(this.section, vec);
    }
}
