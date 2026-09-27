// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    findNodeDependents,
    GetOrSelectNodeStep,
    I18n,
    type IDocument,
    type INode,
    type IStep,
    isConsumedTool,
    MultistepCommand,
    PubSub,
    Transaction,
} from "@spicy3d/core";

/** How many dependent names the warning lists before "and N more". */
const LISTED_DEPENDENTS = 5;

@command({
    key: "modify.deleteNode",
    icon: "icon-delete",
})
export class Delete extends MultistepCommand {
    protected override async executeAsync(): Promise<void> {
        if (await this.executeSteps()) await this.deleteChosen();
    }

    protected override executeMainTask(): void {
        // Unused: `executeAsync` awaits `deleteChosen`, which may ask before deleting.
    }

    /** Deletes the nodes the step chose, once the user agreed to break what depends on them. */
    protected async deleteChosen(): Promise<void> {
        const nodes: INode[] | undefined = this.stepDatas[0].nodes;
        if (!nodes || nodes.length === 0) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return;
        }

        // Consumed boolean tools belong to the owning body's feature list — deleting
        // one would leave a dangling tool id behind. Remove the boolean feature instead.
        const deletable = nodes.filter((x) => !isConsumedTool(x));
        if (deletable.length < nodes.length) {
            PubSub.default.pub("showToast", "toast.consumedTool.forbidden");
        }
        if (deletable.length === 0) return;
        if (!(await confirmBrokenDependents(this.document, deletable))) return;
        this.deleteNodes(deletable);
    }

    private deleteNodes(deletable: INode[]) {
        if (
            this.document.modelManager.currentNode &&
            deletable.includes(this.document.modelManager.currentNode)
        ) {
            this.document.modelManager.currentNode = this.document.modelManager.rootNode;
        }

        this.document.selection.clearSelection();
        Transaction.execute(this.document, "delete", () => {
            deletable.forEach((model) => model.parent?.remove(model));
        });
        this.document.visual.update();
        PubSub.default.pub("showToast", "toast.delete{0}Objects", deletable.length);
    }

    protected override getSteps(): IStep[] {
        return [new GetOrSelectNodeStep("prompt.select.models", { multiple: true })];
    }
}

/**
 * Deleting a sketch a body extrudes, or a body a sketch projects edges from, leaves them failing to
 * rebuild: the user is told which, and decides. Resolves `true` when nothing depends on the nodes.
 */
export function confirmBrokenDependents(document: IDocument, nodes: INode[]): Promise<boolean> {
    const dependents = findNodeDependents(document.modelManager.rootNode, nodes);
    if (dependents.length === 0) return Promise.resolve(true);
    const names = dependents.slice(0, LISTED_DEPENDENTS).map((x) => `“${x.name}”`);
    if (dependents.length > LISTED_DEPENDENTS) {
        names.push(I18n.translate("prompt.delete.more{0}", dependents.length - LISTED_DEPENDENTS));
    }
    const content = window.document.createElement("div");
    content.textContent = I18n.translate("prompt.delete.dependents{0}", names.join(", "));
    return new Promise((resolve) => {
        PubSub.default.pub("showDialog", "prompt.delete.title", content, [
            { content: "common.delete", onclick: () => resolve(true) },
            { content: "common.cancel", onclick: () => resolve(false) },
        ]);
    });
}
