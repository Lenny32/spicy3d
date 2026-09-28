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
    onFeatureFocusRequested,
    PubSub,
    Transaction,
    takeFeatureFocus,
    type UnitSpec,
    unitSpecEquals,
} from "@spicy3d/core";
import { div, input, span, svg } from "@spicy3d/element";
import { type ContextMenuAnchor, type ContextMenuEntry, showContextMenu } from "../contextMenu";
import { showDialog } from "../dialog";
import commonStyle from "./common.module.css";
import style from "./featureListProperty.module.css";
import inputStyle from "./input.module.css";

interface DropTarget {
    readonly id: string;
    readonly before: boolean;
}

/** The i18n label of a unit the panel can name; undefined for derived ones (area, ...). */
function unitSpecLabelKey(unit: UnitSpec | undefined): I18nKeys | undefined {
    if (unit === undefined) return undefined;
    if (unit.length === 1 && unit.angle === 0) return "variable.type.length";
    if (unit.length === 0 && unit.angle === 1) return "variable.type.angle";
    if (unit.length === 0 && unit.angle === 0) return "variable.type.unitless";
    return undefined;
}

/**
 * Renders the ordered feature list of an `IFeatureListNode` (e.g. a parametric
 * body): one collapsible row per feature — the header expands the inline parameter
 * editor, rows are drag-reordered, and a hover "⋯" button or a right-click opens
 * the context menu (rename / reselect / suppress / delete). Edits go through the node's methods
 * inside a transaction, so every change is one undo step.
 */
export class FeatureListProperty extends HTMLElement {
    private readonly expanded = new Set<string>();
    /** Closes this list's context menu (a no-op once another menu replaced it). */
    private closeMenu: () => void = () => {};
    private draggingId: string | undefined;
    private dropTarget: DropTarget | undefined;
    private stopFocus?: () => void;

    constructor(
        readonly document: IDocument,
        readonly node: INode & IFeatureListNode,
    ) {
        super();
        // Opened for one feature (the conflict panel's "open failing feature"): that row expanded.
        const focused = takeFeatureFocus(node);
        if (focused !== undefined) this.expanded.add(focused);
        this.renderItems();
    }

    connectedCallback(): void {
        this.node.onPropertyChanged(this.handleNodeChanged);
        this.stopFocus = onFeatureFocusRequested(this.handleFocus);
    }

    disconnectedCallback(): void {
        this.node.removePropertyChanged(this.handleNodeChanged);
        this.stopFocus?.();
        this.stopFocus = undefined;
        this.closeMenu();
    }

    /** A feature of this list asked to be opened while it is shown: expanded and scrolled to. */
    private readonly handleFocus = (node: INode, featureId: string) => {
        if (node !== this.node || takeFeatureFocus(node) === undefined) return;
        this.expanded.add(featureId);
        this.renderItems();
        const row = [...this.children].find((x) => (x as HTMLElement).dataset["featureId"] === featureId);
        row?.scrollIntoView?.({ block: "nearest" });
    };

    private readonly handleNodeChanged = (property: string) => {
        if (property === "featuresJson") this.renderItems();
    };

    private renderItems() {
        this.closeMenu();
        this.replaceChildren(...this.node.featureItems().map((item) => this.featureRow(item)));
    }

    private isExpanded(item: FeatureItem) {
        // Errored rows stay expanded so the message and repair path remain visible;
        // warnings don't force expansion — the row tint and title carry the hint.
        return this.expanded.has(item.id) || item.error !== undefined;
    }

    private toggleExpand(item: FeatureItem) {
        if (this.expanded.has(item.id)) this.expanded.delete(item.id);
        else this.expanded.add(item.id);
        this.renderItems();
    }

    private featureRow(item: FeatureItem) {
        const expanded = this.isExpanded(item);
        const row = div(
            {
                className: `${style.item} ${item.error === undefined ? "" : style.error} ${
                    item.warning === undefined ? "" : style.warning
                } ${item.suppressed ? style.suppressed : ""}`,
                title: item.error ?? item.warning ?? "",
            },
            this.featureHeader(item, expanded),
            ...(expanded ? [this.featureBody(item)] : []),
        );
        row.dataset["featureId"] = item.id;
        this.addDropHandlers(row, item);
        return row;
    }

    private featureHeader(item: FeatureItem, expanded: boolean) {
        const more = svg({
            className: style.more,
            icon: "icon-ellipsis-vertical",
            onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.openMenu(more, item);
            },
        });
        const header = div(
            {
                className: style.header,
                onclick: () => this.toggleExpand(item),
                // The two clicks before it toggled the row twice, leaving it as it was.
                ondblclick: () => this.edit(item),
            },
            ...(item.icon === undefined ? [] : [svg({ className: style.icon, icon: item.icon })]),
            span({ className: style.name, textContent: item.name ?? new Localize(item.display) }),
            more,
            svg({
                className: style.expander,
                icon: expanded ? "icon-angle-down" : "icon-angle-right",
            }),
        );
        header.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openMenu({ x: e.clientX, y: e.clientY }, item);
        });
        header.draggable = true;
        header.addEventListener("dragstart", this.handleDragStart(item));
        header.addEventListener("dragend", () => this.clearDrag());
        return header;
    }

    private featureBody(item: FeatureItem) {
        // An error outranks a warning for the message slot (they never co-occur:
        // warnings are computed only after a fully successful chain).
        const message =
            item.error !== undefined
                ? div({ className: style.errorText, textContent: item.error })
                : item.warning !== undefined
                  ? div({ className: style.warningText, textContent: item.warning })
                  : undefined;
        return div(
            { className: style.body },
            ...(message === undefined ? [] : [message]),
            ...(item.references ?? []).map((ref) => this.referenceRow(item, ref)),
            ...item.parameters.map((param) => this.parameterRow(item, param)),
        );
    }

    /**
     * A node this feature holds (e.g. its sketch). The name is the door: click
     * selects the node, double-click opens it (the node decides what opening means —
     * for a sketch, entering its editing session).
     */
    private referenceRow(item: FeatureItem, ref: FeatureReference) {
        return div(
            { className: style.param },
            span({ className: commonStyle.propertyName, textContent: new Localize(ref.display) }),
            span({
                className: style.reference,
                textContent: new Binding(ref.node, "name"),
                onclick: () => this.document.selection.setSelectedNodes([ref.node], false),
                ondblclick: () => this.node.activateReference?.(item.id, ref.key),
            }),
        );
    }

    private parameterRow(item: FeatureItem, param: FeatureParameter) {
        return div(
            { className: style.param },
            span({ className: commonStyle.propertyName, textContent: new Localize(param.display) }),
            typeof param.value === "boolean"
                ? input({
                      type: "checkbox",
                      checked: param.value,
                      onclick: (e) =>
                          this.applyChecked(item, param.key, (e.target as HTMLInputElement).checked),
                  })
                : this.textParamInput(item, param.key, param.value, param.unit),
        );
    }

    private textParamInput(item: FeatureItem, key: string, value: number | string, unit?: UnitSpec) {
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
            onkeydown: (e) => this.handleKeyDown(e, item, key, isLength, () => focusedText),
            onblur: (e) => {
                const box = e.target as HTMLInputElement;
                this.applyParameter(box, item, key, isLength, focusedText);
                // A applied change re-renders the list, detaching this box.
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
        item: FeatureItem,
        key: string,
        isLength: boolean,
        focusedText: () => string,
    ) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            this.applyParameter(e.target as HTMLInputElement, item, key, isLength, focusedText());
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

    // --- menu ---

    private openMenu(anchor: ContextMenuAnchor, item: FeatureItem) {
        const entries: ContextMenuEntry[] = [];
        if (item.editable) {
            entries.push(
                { icon: item.icon ?? "icon-edit", label: "features.edit", run: () => this.edit(item) },
                "separator",
            );
        }
        entries.push({ icon: "icon-edit", label: "common.rename", run: () => this.rename(item) });
        if (item.reselectable) {
            entries.push({
                icon: "icon-sync-alt",
                label: "features.reselect",
                run: () => this.node.reselectShapes?.(item.id),
            });
        }
        entries.push(
            {
                icon: item.suppressed ? "icon-eye" : "icon-eye-slash",
                label: item.suppressed ? "features.unsuppress" : "features.suppress",
                run: () => this.toggleSuppressed(item),
            },
            "separator",
            { icon: "icon-delete", label: "common.delete", danger: true, run: () => this.removeItem(item) },
        );
        this.closeMenu = showContextMenu(anchor, entries);
    }

    /** Reopens the feature in its interactive session (handles and live preview). */
    private edit(item: FeatureItem) {
        if (item.editable) this.node.editFeature?.(item.id);
    }

    private rename(item: FeatureItem) {
        const box = input({ className: inputStyle.box, value: item.name ?? I18n.translate(item.display) });
        showDialog("common.rename", box, () => {
            Transaction.execute(this.document, "rename feature", () => {
                this.node.renameFeature?.(item.id, box.value.trim());
            });
        });
        setTimeout(() => {
            box.focus();
            box.select();
        });
    }

    // --- drag reorder ---

    private readonly handleDragStart = (item: FeatureItem) => (e: DragEvent) => {
        this.draggingId = item.id;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    };

    private addDropHandlers(row: HTMLElement, item: FeatureItem) {
        row.addEventListener("dragover", (e) => this.handleDragOver(e, row, item));
        row.addEventListener("dragleave", () => row.classList.remove(style.dropBefore, style.dropAfter));
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            this.applyDrop();
        });
    }

    private handleDragOver(e: DragEvent, row: HTMLElement, item: FeatureItem) {
        if (this.draggingId === undefined || this.draggingId === item.id) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        this.dropTarget = { id: item.id, before };
        this.clearDropIndicators();
        row.classList.add(before ? style.dropBefore : style.dropAfter);
    }

    private applyDrop() {
        const target = this.dropTarget;
        const draggingId = this.draggingId;
        this.clearDrag();
        if (target === undefined || draggingId === undefined) return;
        const items = this.node.featureItems();
        const from = items.findIndex((x) => x.id === draggingId);
        let index = items.findIndex((x) => x.id === target.id) + (target.before ? 0 : 1);
        if (from < 0 || index < 0 || from === index || from === index - 1) return;
        if (from < index) index -= 1;
        Transaction.execute(this.document, "reorder features", () => {
            this.moveFeatureTo(draggingId, index);
            this.document.visual.update();
        });
    }

    private moveFeatureTo(featureId: string, index: number) {
        if (this.node.moveFeatureTo !== undefined) {
            this.node.moveFeatureTo(featureId, index);
            return;
        }
        // Fallback for nodes without absolute moves: step towards the target index.
        let current = this.node.featureItems().findIndex((x) => x.id === featureId);
        while (current !== -1 && current < index) {
            this.node.moveFeature(featureId, 1);
            current++;
        }
        while (current !== -1 && current > index) {
            this.node.moveFeature(featureId, -1);
            current--;
        }
    }

    private clearDrag() {
        this.clearDropIndicators();
        this.draggingId = undefined;
        this.dropTarget = undefined;
    }

    private clearDropIndicators() {
        this.querySelectorAll(`.${style.item}`).forEach((row) =>
            row.classList.remove(style.dropBefore, style.dropAfter),
        );
    }

    // --- feature actions ---

    private applyChecked(item: FeatureItem, key: string, checked: boolean) {
        Transaction.execute(this.document, "edit feature", () => {
            this.node.setFeatureParameter(item.id, key, checked);
            this.document.visual.update();
        });
    }

    private applyParameter(
        box: HTMLInputElement,
        item: FeatureItem,
        key: string,
        isLength: boolean,
        focusedText: string,
    ) {
        const current = item.parameters.find((x) => x.key === key)?.value;
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
            this.node.setFeatureParameter(item.id, key, value);
            this.document.visual.update();
        });
    }

    private parseNumberOrExpression(text: string): number | string {
        const asNumber = Number(text);
        return Number.isFinite(asNumber) ? asNumber : text;
    }

    /**
     * Features after this one may be built on its faces and edges, so deleting it can break them:
     * asked first unless it is the last feature (undo still brings it back).
     */
    private removeItem(item: FeatureItem) {
        const remove = () =>
            Transaction.execute(this.document, "remove feature", () => {
                this.node.removeFeature(item.id);
                this.document.visual.update();
            });
        const items = this.node.featureItems();
        const later = items.length - 1 - items.findIndex((x) => x.id === item.id);
        if (later <= 0) {
            remove();
            return;
        }
        const name = item.name ?? I18n.translate(item.display);
        showDialog(
            "features.delete.title",
            div({ textContent: I18n.translate("features.delete.warning{0}{1}", name, later) }),
            [{ content: "common.delete", onclick: remove }, { content: "common.cancel" }],
        );
    }

    private toggleSuppressed(item: FeatureItem) {
        Transaction.execute(this.document, "toggle feature", () => {
            this.node.setFeatureSuppressed(item.id, !item.suppressed);
            this.document.visual.update();
        });
    }
}

customElements.define("spicy-feature-list", FeatureListProperty);
