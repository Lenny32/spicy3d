// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Binding,
    documentLengthUnit,
    type FeatureItem,
    type FeatureParameter,
    type FeatureReference,
    formatLengthParameter,
    I18n,
    type I18nKeys,
    type IDocument,
    type IFeatureListNode,
    type INode,
    LENGTH_UNITS,
    Localize,
    lengthParameterFromInput,
    PubSub,
    Transaction,
    type UnitSpec,
    unitSpecEquals,
} from "@spicy3d/core";
import { div, input, span, svg } from "@spicy3d/element";
import commonStyle from "./common.module.css";
import style from "./featureListProperty.module.css";
import inputStyle from "./input.module.css";

/** The i18n label of a unit the panel can name; undefined for derived ones (area, ...). */
function unitSpecLabelKey(unit: UnitSpec | undefined): I18nKeys | undefined {
    if (unit === undefined) return undefined;
    if (unit.length === 1 && unit.angle === 0) return "variable.type.length";
    if (unit.length === 0 && unit.angle === 1) return "variable.type.angle";
    if (unit.length === 0 && unit.angle === 0) return "variable.type.unitless";
    return undefined;
}

/**
 * The editor of one feature of an `IFeatureListNode`: its error or warning, the nodes it holds
 * (e.g. an extrude's sketch, opened with the edit button or a double-click) and its parameters
 * (e.g. the depth). Built from one snapshot of the feature: the owner re-creates it when the
 * feature list changes. Every edit is one undo step; `onOpenReference` runs after a held node
 * was opened (a sketch's editing session took over).
 */
export class FeatureEditor extends HTMLElement {
    constructor(
        readonly document: IDocument,
        readonly node: INode & IFeatureListNode,
        readonly item: FeatureItem,
        readonly onOpenReference?: () => void,
    ) {
        super();
        this.className = style.body;
        // An error outranks a warning for the message slot (they never co-occur:
        // warnings are computed only after a fully successful chain).
        const message =
            item.error !== undefined
                ? div({ className: style.errorText, textContent: item.error })
                : item.warning !== undefined
                  ? div({ className: style.warningText, textContent: item.warning })
                  : undefined;
        this.append(
            ...(message === undefined ? [] : [message]),
            ...(item.references ?? []).map((ref) => this.referenceRow(ref)),
            ...item.parameters.map((param) => this.parameterRow(param)),
        );
    }

    /**
     * A node this feature holds (e.g. its sketch). Click on the name selects the node; the edit
     * button or a double-click opens it (the node decides what opening means — for a sketch,
     * entering its editing session).
     */
    private referenceRow(ref: FeatureReference) {
        const open = () => {
            this.node.activateReference?.(this.item.id, ref.key);
            this.onOpenReference?.();
        };
        return div(
            { className: style.param },
            span({ className: commonStyle.propertyName, textContent: new Localize(ref.display) }),
            span({
                className: style.reference,
                textContent: new Binding(ref.node, "name"),
                onclick: () => this.document.selection.setSelectedNodes([ref.node], false),
                ondblclick: open,
            }),
            svg({
                className: style.referenceEdit,
                icon: "icon-edit",
                title: I18n.translate("timeline.edit{0}", I18n.translate(ref.display) ?? "") ?? "",
                onclick: open,
            }),
        );
    }

    private parameterRow(param: FeatureParameter) {
        return div(
            { className: style.param },
            span({ className: commonStyle.propertyName, textContent: new Localize(param.display) }),
            typeof param.value === "boolean"
                ? input({
                      type: "checkbox",
                      checked: param.value,
                      onclick: (e) => this.applyChecked(param.key, (e.target as HTMLInputElement).checked),
                  })
                : this.textParamInput(param.key, param.value, param.unit),
        );
    }

    private textParamInput(key: string, value: number | string, unit?: UnitSpec) {
        const expected = unitSpecLabelKey(unit);
        const isLength = unit !== undefined && unitSpecEquals(unit, LENGTH_UNITS);
        let focusedText = "";
        const box = input({
            className: inputStyle.box,
            value: this.formatParameterValue(value, isLength),
            // What the slot measures — the value may be an expression, and the rebuild
            // rejects one of the wrong unit, so say up front what fits.
            title: expected === undefined ? "" : (I18n.translate(expected) ?? ""),
            // Reveal the raw value for editing; blur without a change
            // restores the trimmed display.
            onfocus: (e) => {
                const box = e.target as HTMLInputElement;
                box.value = this.editableParameterValue(value, isLength);
                focusedText = box.value;
                box.select();
            },
            onkeydown: (e) => this.handleKeyDown(e, key, isLength, () => focusedText),
            onblur: (e) => {
                const box = e.target as HTMLInputElement;
                // Detached by the rebuild an Enter caused: that value is already applied.
                if (!box.isConnected) return;
                this.applyParameter(box, key, isLength, focusedText);
                // A applied change re-renders the owner, detaching this box.
                if (box.isConnected) box.value = this.formatParameterValue(value, isLength);
            },
        });
        if (!isLength) return box;
        return div(
            { className: style.lengthInput },
            box,
            span({ className: inputStyle.unit, textContent: documentLengthUnit(this.document) }),
        );
    }

    private readonly handleKeyDown = (
        e: KeyboardEvent,
        key: string,
        isLength: boolean,
        focusedText: () => string,
    ) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            this.applyParameter(e.target as HTMLInputElement, key, isLength, focusedText());
        }
    };

    /**
     * Numbers display trimmed to 4 fraction digits (a length in the project unit, at the
     * precision that unit needs); expression strings stay as-is.
     */
    private formatParameterValue(value: number | string, isLength: boolean): string {
        if (isLength) return formatLengthParameter(value, documentLengthUnit(this.document));
        return typeof value === "number" ? String(Number(value.toFixed(4))) : value;
    }

    /** What the focused box holds: the full value, a length in the project unit. */
    private editableParameterValue(value: number | string, isLength: boolean): string {
        return isLength ? formatLengthParameter(value, documentLengthUnit(this.document)) : String(value);
    }

    private applyChecked(key: string, checked: boolean) {
        Transaction.execute(this.document, "edit feature", () => {
            this.node.setFeatureParameter(this.item.id, key, checked);
            this.document.visual.update();
        });
    }

    private applyParameter(box: HTMLInputElement, key: string, isLength: boolean, focusedText: string) {
        const current = this.item.parameters.find((x) => x.key === key)?.value;
        const text = box.value.trim();
        if (text === "") {
            PubSub.default.pub("showToast", "error.default:{0}", "invalid input");
            box.value =
                current === undefined
                    ? ""
                    : this.editableParameterValue(current as number | string, isLength);
            return;
        }
        // Untouched: a length shown in another unit is rounded, and writing it back would drift.
        if (text === focusedText.trim() || (!isLength && text === String(current))) return;
        // A non-numeric value is kept as an expression string; a failure to resolve
        // it surfaces as a feature error on the row.
        const value = isLength
            ? lengthParameterFromInput(
                  text,
                  documentLengthUnit(this.document),
                  this.document.variables.evaluate().scope,
              )
            : this.parseNumberOrExpression(text);
        Transaction.execute(this.document, "edit feature", () => {
            this.node.setFeatureParameter(this.item.id, key, value);
            this.document.visual.update();
        });
    }

    private parseNumberOrExpression(text: string): number | string {
        const asNumber = Number(text);
        return Number.isFinite(asNumber) ? asNumber : text;
    }
}

customElements.define("spicy-feature-editor", FeatureEditor);
