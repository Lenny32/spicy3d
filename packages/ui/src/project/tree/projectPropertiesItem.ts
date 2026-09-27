// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Localize, PubSub } from "@spicy3d/core";
import { label, svg } from "@spicy3d/element";
import itemStyle from "./treeItem.module.css";
import style from "./treeModel.module.css";

/**
 * The Project Properties row, pinned as the first child of the project in the Items tree.
 * It stands for the document's settings, not a model node: there is nothing to rename,
 * hide, drag or delete, so it carries no node and none of those controls — the tree and
 * the delete command only ever act on nodes. Choosing it clears the node selection and
 * shows the settings in the property panel.
 */
export class ProjectPropertiesItem extends HTMLElement {
    constructor(readonly document: IDocument) {
        super();
        this.draggable = false;
        this.classList.add(style.panel);
        this.dataset["projectProperties"] = "";
        this.append(
            svg({ className: itemStyle.typeIcon, icon: "icon-cog" }),
            label({ className: itemStyle.name, textContent: new Localize("project.properties") }),
        );
        this.addEventListener("click", this.handleClick);
        this.addEventListener("dragstart", this.preventDrag);
    }

    private readonly handleClick = (event: MouseEvent) => {
        event.stopPropagation();
        // Clear first: the selection change repaints the panel for an empty selection,
        // and the settings must land after it, not under it.
        this.document.selection.clearSelection();
        PubSub.default.pub("showProjectProperties", this.document);
    };

    private readonly preventDrag = (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
    };

    dispose() {
        this.removeEventListener("click", this.handleClick);
        this.removeEventListener("dragstart", this.preventDrag);
        this.remove();
    }
}

customElements.define("tree-project-properties", ProjectPropertiesItem);
