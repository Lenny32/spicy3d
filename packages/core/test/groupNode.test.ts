// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { GroupNode, type IDocument, Matrix4 } from "../src";
import { TestDocument } from "../test-utils";

describe("GroupNode", () => {
    const doc: IDocument = new TestDocument() as any;

    test("should set name and document via constructor", () => {
        const groupNode = new GroupNode({ document: doc, name: "testGroup" });
        expect(groupNode.name).toBe("testGroup");
        expect(groupNode.document).toBe(doc);
    });

    test("should default transform to identity", () => {
        const groupNode = new GroupNode({ document: doc, name: "testGroup" });
        const transform = groupNode.transform;
        expect(transform.equals(Matrix4.identity())).toBe(true);
    });

    test("should apply transform via setter", () => {
        const groupNode = new GroupNode({ document: doc, name: "testGroup" });
        const newTransform = Matrix4.fromTranslation(1, 2, 3);
        groupNode.transform = newTransform;
        expect(groupNode.transform.equals(newTransform)).toBe(true);
    });

    test("should replace transform when setting a different matrix", () => {
        const groupNode = new GroupNode({ document: doc, name: "testGroup" });
        const scaleTransform = Matrix4.fromScale(2, 2, 2);
        groupNode.transform = scaleTransform;
        expect(groupNode.transform.equals(scaleTransform)).toBe(true);
        expect(groupNode.transform.equals(Matrix4.identity())).toBe(false);
    });
});
