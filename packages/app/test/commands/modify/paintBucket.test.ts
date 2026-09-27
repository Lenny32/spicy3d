// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import {
    EditableShapeNode,
    FaceMaterialPair,
    type IDocument,
    type IShape,
    Result,
    ShapeTypes,
} from "@spicy3d/core";
import { PaintBucketCommand } from "../../../src/commands/modify/paintBucket";
import {
    ensureGlobalStubApp,
    mockShape,
    nodeStepResult,
    seedStepDatas,
    stubTransactionRun,
    wireCommand,
} from "../../commands/commandTestUtils";

/**
 * Build a real EditableShapeNode so `instanceof GeometryNode` checks inside
 * paintBucket.executeMainTask succeed. The node has no `_originFaceMesh`, so
 * `faceMaterialPair`-driven visual updates early-return without a WASM shape.
 */
function makeGeometryNode(doc: IDocument) {
    const shape = mockShape({ shapeType: ShapeTypes.solid });
    return new EditableShapeNode({
        document: doc,
        name: "body",
        shape: Result.ok(shape as unknown as IShape),
    });
}

describe("PaintBucketCommand", () => {
    test("should have command metadata", () => {
        const data = (PaintBucketCommand as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("modify.paintBucket");
        expect(data.icon).toBe("icon-paintBucket");
    });

    test("getSteps should return one step", () => {
        const cmd = new PaintBucketCommand();
        const steps = (cmd as any).getSteps();
        expect(steps.length).toBe(1);
    });

    test("materialId should default to first document material", () => {
        const cmd = new PaintBucketCommand();
        const { doc } = wireCommand(cmd);
        expect(cmd.materialId).toBe("mat-default");
        expect(doc).not.toBeNull();
    });

    test("materialId setter should update property", () => {
        const cmd = new PaintBucketCommand();
        wireCommand(cmd);
        cmd.materialId = "mat-other";
        expect(cmd.materialId).toBe("mat-other");
    });

    test("executeMainTask should assign material to all GeometryNode nodes", () => {
        const restoreApp = ensureGlobalStubApp();
        const restoreTx = stubTransactionRun();
        try {
            const cmd = new PaintBucketCommand();
            const { doc } = wireCommand(cmd);
            cmd.materialId = "mat-paint";

            const nodeA = makeGeometryNode(doc);
            const nodeB = makeGeometryNode(doc);
            const nonGeo = { id: "plain" };
            seedStepDatas(cmd, [nodeStepResult([nodeA, nonGeo as any, nodeB])]);

            (cmd as any).executeMainTask();

            expect(nodeA.materialId).toBe("mat-paint");
            expect(nodeB.materialId).toBe("mat-paint");
            expect(doc.visual.update).toHaveBeenCalledTimes(1);
        } finally {
            restoreTx();
            restoreApp();
        }
    });

    test("executeMainTask should clear face materials before painting", () => {
        const restoreApp = ensureGlobalStubApp();
        const restoreTx = stubTransactionRun();
        try {
            const cmd = new PaintBucketCommand();
            const { doc } = wireCommand(cmd);
            cmd.materialId = "mat-paint";

            const node = makeGeometryNode(doc);
            node.setPrivateValue("faceMaterialPair", [
                new FaceMaterialPair({ faceIndex: 0, materialIndex: 0 }),
            ]);
            seedStepDatas(cmd, [nodeStepResult([node])]);

            (cmd as any).executeMainTask();

            expect(node.faceMaterialPair.length).toBe(0);
            expect(node.materialId).toBe("mat-paint");
        } finally {
            restoreTx();
            restoreApp();
        }
    });

    test("executeMainTask should skip nodes already using the target material", () => {
        const restoreApp = ensureGlobalStubApp();
        const restoreTx = stubTransactionRun();
        try {
            const cmd = new PaintBucketCommand();
            const { doc } = wireCommand(cmd);
            cmd.materialId = "mat-paint";

            const node = makeGeometryNode(doc);
            node.materialId = "mat-paint";
            const setSpy = rs.spyOn(node, "materialId", "set");
            seedStepDatas(cmd, [nodeStepResult([node])]);

            (cmd as any).executeMainTask();

            expect(setSpy).not.toHaveBeenCalled();
        } finally {
            restoreTx();
            restoreApp();
        }
    });
});
