// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    documentLengthUnit,
    formatLengthForEditing,
    type GroupNode,
    type IConverter,
    type IDocument,
    type LengthUnit,
    Matrix4,
    parseLength,
    Result,
    type VisualNode,
    type XYZLike,
} from "@spicy3d/core";
import { InputProperty } from "./input";
import { PropertyBase } from "./propertyBase";

export class MatrixProperty extends PropertyBase {
    readonly first: VisualNode | GroupNode;

    constructor(
        readonly document: IDocument,
        geometries: (VisualNode | GroupNode)[],
        className: string,
    ) {
        super(geometries);
        this.first = geometries[0];
        this.className = className;
        this.append(
            new InputProperty(document, [this.first], {
                name: "transform",
                display: "transform.translation",
                quantity: "length",
                converter: new TranslationConverter(this.first, () => documentLengthUnit(document)),
            }),
            new InputProperty(document, [this.first], {
                name: "transform",
                display: "transform.scale",
                converter: new ScalingConverter(this.first),
            }),
            new InputProperty(document, [this.first], {
                name: "transform",
                display: "transform.rotation",
                converter: new RotateConverter(this.first),
            }),
        );
    }

    private readonly onPropertyChanged = (property: keyof (VisualNode | GroupNode)) => {
        if (property === "transform") {
            this.objects.forEach((obj) => {
                if (obj === this.first) return;
                obj.transform = this.first.transform;
            });
        }
    };

    connectedCallback() {
        (this.first as VisualNode).onPropertyChanged(this.onPropertyChanged);
    }

    disconnectedCallback() {
        (this.first as VisualNode).removePropertyChanged(this.onPropertyChanged);
    }
}

customElements.define("matrix-property", MatrixProperty);

export abstract class MatrixConverter implements IConverter<Matrix4, string> {
    constructor(readonly geometry: VisualNode | GroupNode) {}

    convert(value: Matrix4): Result<string, string> {
        const [x, y, z] = this.convertFrom(value);
        return Result.ok(`${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)}`);
    }

    protected abstract convertFrom(value: Matrix4): [number, number, number];
    protected abstract convertTo(values: XYZLike): Matrix4;

    convertBack(value: string): Result<Matrix4, string> {
        const values = value
            .split(",")
            .map(Number)
            .filter((x) => !isNaN(x));
        if (values.length !== 3) return Result.err("invalid number of values");
        const newValue = {
            x: values[0],
            y: values[1],
            z: values[2],
        };
        const matrix = this.convertTo(newValue);
        return Result.ok(matrix);
    }
}

/** The translation, a millimetre offset, shown and typed in the project unit. */
export class TranslationConverter extends MatrixConverter {
    constructor(
        geometry: VisualNode | GroupNode,
        private readonly unit: () => LengthUnit = () => "mm",
    ) {
        super(geometry);
    }

    override convert(value: Matrix4): Result<string, string> {
        const unit = this.unit();
        return Result.ok(
            this.convertFrom(value)
                .map((x) => formatLengthForEditing(x, unit))
                .join(", "),
        );
    }

    override convertBack(value: string): Result<Matrix4, string> {
        const unit = this.unit();
        const values = value.split(",").map((x) => parseLength(x, unit));
        if (values.length !== 3 || values.some((x) => !x.isOk)) return Result.err("invalid number of values");
        return Result.ok(this.convertTo({ x: values[0].value, y: values[1].value, z: values[2].value }));
    }

    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const position = matrix.translationPart();
        return [position.x, position.y, position.z];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const rotation = this.geometry.transform.getEulerAngles();
        const scale = this.geometry.transform.getScale();
        return Matrix4.createFromTRS(values, rotation, scale);
    }
}

export class ScalingConverter extends MatrixConverter {
    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const s = matrix.getScale();
        return [s.x, s.y, s.z];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const rotation = this.geometry.transform.getEulerAngles();
        const translation = this.geometry.transform.translationPart();
        return Matrix4.createFromTRS(translation, rotation, values);
    }
}

export class RotateConverter extends MatrixConverter {
    protected convertFrom(matrix: Matrix4): [number, number, number] {
        const s = matrix.getEulerAngles();
        return [(s.pitch * 180) / Math.PI, (s.yaw * 180) / Math.PI, (s.roll * 180) / Math.PI];
    }
    protected convertTo(values: XYZLike): Matrix4 {
        const scale = this.geometry.transform.getScale();
        const translation = this.geometry.transform.translationPart();
        return Matrix4.createFromTRS(
            translation,
            {
                pitch: (values.x * Math.PI) / 180,
                yaw: (values.y * Math.PI) / 180,
                roll: (values.z * Math.PI) / 180,
            },
            scale,
        );
    }
}
