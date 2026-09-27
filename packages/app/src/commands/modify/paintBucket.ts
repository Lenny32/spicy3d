// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    GeometryNode,
    type IStep,
    MultistepCommand,
    property,
    SelectNodeStep,
    Transaction,
} from "@spicy3d/core";

@command({
    key: "modify.paintBucket",
    icon: "icon-paintBucket",
})
export class PaintBucketCommand extends MultistepCommand {
    @property("common.material", { type: "materialId" })
    get materialId(): string {
        return this.getPrivateValue("materialId", this.document.modelManager.materials.at(0)?.id);
    }
    set materialId(value: string) {
        this.setProperty("materialId", value);
    }

    protected override getSteps(): IStep[] {
        return [new SelectNodeStep("prompt.select.shape", { multiple: true, keepSelection: true })];
    }

    protected override executeMainTask(): void {
        Transaction.execute(this.document, "paint bucket", () => {
            this.stepDatas[0].nodes?.forEach((node) => {
                if (!(node instanceof GeometryNode) || node.materialId === this.materialId) {
                    return;
                }
                if (node.faceMaterialPair.length > 0) {
                    node.clearFaceMaterial();
                }
                node.materialId = this.materialId;
            });
        });

        this.document.visual.update();
    }
}
