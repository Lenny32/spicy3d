// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ConstructionNode,
    documentLengthUnit,
    FolderNode,
    formatLengthForEditing,
    GroupNode,
    I18n,
    type IDocument,
    type IFeatureListNode,
    type INode,
    type IView,
    isFeatureListNode,
    Localize,
    Node,
    PropertyUtils,
    PubSub,
    Transaction,
    toMillimetres,
    VisualNode,
} from "@spicy3d/core";
import { button, div, Expander, input, label } from "@spicy3d/element";
import { propertyControl } from "./complexPropertyUtils";
import { FeatureListProperty } from "./featureListProperty";
import { MatrixProperty } from "./matrixProperty";
import { ProjectPropertiesPanel } from "./projectPropertiesPanel";
import style from "./propertyView.module.css";

/** What the panel shows now, so a length-unit change can redraw it in the new unit. */
type Shown = { readonly document: IDocument; readonly nodes: INode[] } | { readonly document: IDocument };

export class PropertyView extends HTMLElement {
    private readonly panel = div({ className: style.panel });
    private shown: Shown | undefined;

    constructor(props: { className: string }) {
        super();
        this.classList.add(props.className, style.root);
        this.append(
            label({
                className: style.header,
                textContent: new Localize("properties.header"),
            }),
            this.panel,
        );
        PubSub.default.sub("showProperties", this.handleShowProperties);
        PubSub.default.sub("showProjectProperties", this.handleShowProjectProperties);
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
    }

    private readonly handleShowProjectProperties = (document: IDocument) => {
        this.removeProperties();
        this.watch({ document });
        this.panel.append(new ProjectPropertiesPanel(document));
    };

    /**
     * Every length field formats its value when it is built, so a unit change rebuilds the
     * panel rather than asking each control to reformat itself.
     */
    private readonly handleSettingsChanged = (property: string) => {
        const shown = this.shown;
        if (property !== "lengthUnit" || shown === undefined || !("nodes" in shown)) return;
        this.handleShowProperties(shown.document, shown.nodes);
    };

    private watch(shown: Shown | undefined) {
        if (this.shown?.document !== shown?.document) {
            this.shown?.document.settings?.removePropertyChanged(this.handleSettingsChanged);
            shown?.document.settings?.onPropertyChanged(this.handleSettingsChanged);
        }
        this.shown = shown;
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        if (view) {
            const nodes = view.document.selection.getSelectedNodes();
            this.handleShowProperties(view.document, nodes);
        }
    };

    private readonly handleShowProperties = (document: IDocument, nodes: INode[]) => {
        this.removeProperties();
        this.watch(nodes.length === 0 ? undefined : { document, nodes: [...nodes] });
        if (nodes.length === 0) return;
        this.addModel(document, nodes);
        this.addGeometry(nodes, document);
        this.addFeatureList(document, nodes);
        this.addConstructionEditor(nodes);
    };

    private removeProperties() {
        while (this.panel.lastElementChild) {
            this.panel.removeChild(this.panel.lastElementChild);
        }
    }

    private addModel(document: IDocument, nodes: INode[]) {
        if (nodes.length === 0) return;

        let controls: (HTMLElement | string)[] = [];
        if (nodes[0] instanceof FolderNode) {
            controls = PropertyUtils.getProperties(Object.getPrototypeOf(nodes[0])).map((x) =>
                propertyControl(document, nodes, x),
            );
        } else if (nodes[0] instanceof Node) {
            controls = PropertyUtils.getOwnProperties(Node.prototype).map((x) =>
                propertyControl(document, nodes, x),
            );
        }

        this.panel.append(div({ className: style.properties }, ...controls));
    }

    private addGeometry(nodes: INode[], document: IDocument) {
        const geometries = nodes.filter((x) => x instanceof VisualNode || x instanceof GroupNode);
        if (geometries.length === 0 || !this.isAllElementsOfTypeFirstElement(geometries)) return;
        this.addTransform(document, geometries);
        this.addParameters(geometries, document);
    }

    private addTransform(document: IDocument, geometries: (VisualNode | GroupNode)[]) {
        const matrix = new Expander("common.matrix");
        this.panel.append(matrix);

        matrix.contenxtPanel.append(new MatrixProperty(document, geometries, style.properties));
    }

    private addParameters(geometries: (VisualNode | GroupNode)[], document: IDocument) {
        const entities = geometries.filter((x) => x instanceof VisualNode);
        if (entities.length === 0 || !this.isAllElementsOfTypeFirstElement(entities)) return;
        const parameters = new Expander(entities[0].display());
        parameters.contenxtPanel.append(
            ...PropertyUtils.getProperties(Object.getPrototypeOf(entities[0]), Node.prototype).map((x) =>
                propertyControl(document, entities, x),
            ),
        );
        this.panel.append(parameters);
    }

    private addFeatureList(document: IDocument, nodes: INode[]) {
        if (nodes.length !== 1 || !isFeatureListNode(nodes[0])) return;

        const features = new Expander("features.header");
        features.contenxtPanel.append(
            new FeatureListProperty(document, nodes[0] as INode & IFeatureListNode),
        );
        this.panel.append(features);
    }

    private addConstructionEditor(nodes: INode[]) {
        if (nodes.length !== 1 || !(nodes[0] instanceof ConstructionNode)) return;
        const node = nodes[0];
        this.panel.append(
            button({
                textContent: new Localize("construction.edit"),
                onclick: () => PubSub.default.pub("executeCommand", "construct.edit"),
            }),
        );
        if (node.errorMessage) {
            this.panel.append(
                div({
                    role: "alert",
                    textContent: I18n.translate("construction.invalid{0}", node.errorMessage),
                }),
            );
        }
        const unit = documentLengthUnit(node.document);
        this.panel.append(
            label({ textContent: `${I18n.translate("construction.displaySize")} (${unit})` }),
            input({
                type: "number",
                min: "0",
                step: "any",
                value: formatLengthForEditing(node.displaySize, unit),
                onchange: (event) => {
                    const size = toMillimetres(Number((event.target as HTMLInputElement).value), unit);
                    if (!Number.isFinite(size) || size <= 0) return;
                    Transaction.execute(node.document, "edit construction display", () => {
                        node.displaySize = size;
                        node.document.visual.update();
                    });
                },
            }),
        );
        if (node.definition.kind.startsWith("plane-")) {
            this.panel.append(
                button({
                    textContent: new Localize("construction.activatePlane"),
                    onclick: () => PubSub.default.pub("executeCommand", "construct.activatePlane"),
                }),
            );
            this.panel.append(
                button({
                    textContent: new Localize("construction.createSketch"),
                    onclick: () => PubSub.default.pub("executeCommand", "sketch.create"),
                }),
            );
        }
        if (node.definition.kind === "ucs") {
            for (const member of ["XY", "YZ", "ZX"] as const) {
                this.panel.append(
                    button({
                        textContent: new Localize(`construction.activate${member}`),
                        onclick: () => PubSub.default.pub("executeCommand", `construct.activate${member}`),
                    }),
                );
                this.panel.append(
                    button({
                        textContent: new Localize(`construction.createSketch${member}`),
                        onclick: () => PubSub.default.pub("executeCommand", `sketch.createUcs${member}`),
                    }),
                );
            }
        }
    }

    private isAllElementsOfTypeFirstElement(arr: any[]): boolean {
        if (arr.length <= 1) {
            return true;
        }
        const firstElementType = Object.getPrototypeOf(arr[0]).constructor;
        for (let i = 1; i < arr.length; i++) {
            if (Object.getPrototypeOf(arr[i]).constructor !== firstElementType) {
                return false;
            }
        }
        return true;
    }
}

customElements.define("spicy-property-view", PropertyView);
