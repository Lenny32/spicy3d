// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, NodeSelectionHandler, PubSub } from "@spicy3d/core";

export class ShowPropertyEventHandler extends NodeSelectionHandler {
    constructor(document: IDocument) {
        super(document, true);
        document.selection.onNodeChanged.sub(this.handleSelectionChanged);
    }

    protected readonly handleSelectionChanged = (selected: INode[]) => {
        PubSub.default.pub("showProperties", this.document, selected);
    };

    override disposeInternal() {
        this.document.selection.onNodeChanged.remove(this.handleSelectionChanged);
        super.disposeInternal();
    }
}
