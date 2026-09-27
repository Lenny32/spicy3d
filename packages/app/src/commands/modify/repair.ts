// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    EditableShapeNode,
    GetOrSelectNodeStep,
    type IShape,
    MultistepCommand,
    property,
    ShapeNode,
    Transaction,
} from "@spicy3d/core";

export function repairShape(shape: IShape, tolerance: number) {
    const getShapeIfNotNull = (testShape: IShape, defaultShape: IShape) => {
        return testShape.isNull() ? defaultShape : testShape;
    };
    let repairedShape = getShapeIfNotNull(shape.shellSewing(tolerance), shape);
    repairedShape = getShapeIfNotNull(repairedShape.fixShape(tolerance), repairedShape);
    repairedShape = getShapeIfNotNull(repairedShape.fixSmallFace(tolerance), repairedShape);
    return repairedShape;
}

@command({
    key: "modify.repairShape",
    icon: "icon-repair",
})
export class RepairShapeCommand extends MultistepCommand {
    @property("common.tolerance")
    get tolerance() {
        return this.getPrivateValue("tolerance", 1e-5);
    }

    set tolerance(value: number) {
        this.setProperty("tolerance", value);
    }

    protected override executeMainTask() {
        Transaction.execute(this.document, `execute ${Object.getPrototypeOf(this).data.name}`, () => {
            if (!this.stepDatas[0].nodes) return;

            for (const node of this.stepDatas[0].nodes) {
                const shapeNode = node as ShapeNode;
                const shape = shapeNode.shape.value;
                shape.setTolerance(this.tolerance);

                const repairedShape = repairShape(shape, this.tolerance);

                const model = new EditableShapeNode({
                    document: this.document,
                    name: `${node.name}_repaired`,
                    shape: repairedShape,
                    materialId: shapeNode.materialId,
                });
                model.transform = node.transform;
                (node.parent ?? this.document.modelManager.rootNode).add(model);
                node.parent?.remove(node);
            }
            this.document.visual.update();
        });
    }

    protected override getSteps() {
        return [
            new GetOrSelectNodeStep("prompt.select.shape", {
                filter: {
                    allow: (node) => node instanceof ShapeNode,
                },
                multiple: true,
            }),
        ];
    }
}
