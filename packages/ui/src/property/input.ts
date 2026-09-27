// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Binding,
    documentLengthUnit,
    type IConverter,
    type IDocument,
    isLengthProperty,
    isPropertyChanged,
    LengthConverter,
    Localize,
    type Property,
    PubSub,
    Result,
    Transaction,
    XY,
    XYZ,
    XYZLengthConverter,
} from "@spicy3d/core";
import {
    div,
    input,
    NumberConverter,
    StringConverter,
    span,
    XYConverter,
    XYZConverter,
} from "@spicy3d/element";
import commonStyle from "./common.module.css";
import style from "./input.module.css";
import { PropertyBase } from "./propertyBase";

class ArrayValueConverter implements IConverter {
    constructor(
        readonly objects: any[],
        readonly property: Property,
        readonly converter?: IConverter,
    ) {}

    convert(value: any): Result<string> {
        return Result.ok(this.getDefaultValue());
    }

    convertBack?(value: string): Result<any> {
        throw new Error("Method not implemented.");
    }

    private getValueString(obj: any): string {
        const value = obj[this.property.name];
        const cvalue = this.converter?.convert(value);
        return cvalue?.isOk ? cvalue.value : String(value);
    }

    private getDefaultValue() {
        const values = this.objects.map(this.getValueString.bind(this));
        const uniqueValues = new Set(values);
        return uniqueValues.size === 1 ? values[0] : "";
    }
}

export class InputProperty extends PropertyBase {
    readonly converter: IConverter | undefined;

    constructor(
        readonly document: IDocument,
        objects: any[],
        readonly property: Property,
    ) {
        super(objects);
        this.converter = property.converter ?? this.getConverter();
        const arrayConverter = new ArrayValueConverter(objects, property, this.converter);
        const box = input({
            className: style.box,
            value: new Binding(objects[0], property.name, arrayConverter),
            readOnly: this.isReadOnly(),
            onkeydown: this.handleKeyDown,
            onblur: this.handleBlur,
            onfocus: (e: FocusEvent) => {
                this.focusedText = (e.target as HTMLInputElement).value;
            },
        });
        this.append(
            div(
                { className: commonStyle.panel },
                span({ className: commonStyle.propertyName, textContent: new Localize(property.display) }),
                box,
                ...(this.isLength() ? [span({ className: style.unit, textContent: this.lengthUnit() })] : []),
            ),
        );
    }

    /**
     * The text the field held when it took the focus. Leaving it unchanged writes nothing:
     * a length shown in another unit is rounded for display, and writing that rounded text
     * back would nudge the stored millimetres on every visit.
     */
    private focusedText: string | undefined;

    private isLength(): boolean {
        return isLengthProperty(this.property);
    }

    private readonly lengthUnit = () => documentLengthUnit(this.document);

    private isReadOnly(): boolean {
        let des = Object.getOwnPropertyDescriptor(this.objects[0], this.property.name);
        if (!des) {
            let proto = Object.getPrototypeOf(this.objects[0]);
            while (isPropertyChanged(proto)) {
                des = Object.getOwnPropertyDescriptor(proto, this.property.name);
                if (des) break;
                proto = Object.getPrototypeOf(proto);
            }
        }
        return (
            des?.set === undefined ||
            (this.converter === undefined && typeof this.objects[0][this.property.name] !== "string")
        );
    }

    private readonly handleBlur = (e: FocusEvent) => {
        this.setValue(e.target as HTMLInputElement);
    };

    private readonly handleKeyDown = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (this.converter && e.key === "Enter") {
            this.setValue(e.target as HTMLInputElement);
        }
    };

    private readonly setValue = (input: HTMLInputElement) => {
        if (this.isReadOnly() || input.value === "") return;
        if (input.value === this.focusedText) return;

        const newValue = this.converter?.convertBack?.(input.value);
        if (!newValue?.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", newValue?.error);
            return;
        }
        Transaction.execute(this.document, "modify property", () => {
            for (let i = this.objects.length - 1; i >= 0; i--) {
                this.objects[i][this.property.name] = newValue.value;
            }
            this.document.visual.update();
        });
        // Enter commits without leaving the field; what it shows now is the new baseline.
        this.focusedText = input.value;
    };

    private getConverter(): IConverter | undefined {
        const name = this.objects[0][this.property.name].constructor.name;
        if (this.isLength()) {
            if (name === Number.name) return new LengthConverter(this.lengthUnit);
            if (name === XYZ.name) return new XYZLengthConverter(this.lengthUnit);
        }
        const converters: { [key: string]: () => IConverter } = {
            [XYZ.name]: () => new XYZConverter(),
            [XY.name]: () => new XYConverter(),
            [String.name]: () => new StringConverter(),
            [Number.name]: () => new NumberConverter(),
        };
        return converters[name]?.();
    }
}

customElements.define("spicy-input-property", InputProperty);
