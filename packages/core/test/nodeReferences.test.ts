// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { beforeEach, describe, expect, test } from "@rstest/core";
import { FolderNode, findNodeDependents, type INode, isNodeReferences } from "../src";
import { TestDocument } from "../test-utils";

/** A node reading others by id, like a body reading its sketch. */
class ReaderNode extends FolderNode {
    constructor(
        document: TestDocument,
        name: string,
        private readonly reads: string[],
    ) {
        super({ document, name });
    }

    referencedNodeIds() {
        return this.reads;
    }
}

describe("findNodeDependents", () => {
    let doc: TestDocument;
    let root: FolderNode;

    beforeEach(() => {
        doc = new TestDocument();
        root = new FolderNode({ document: doc, name: "root" });
    });

    const folder = (name: string, parent = root) => {
        const node = new FolderNode({ document: doc, name });
        parent.add(node);
        return node;
    };
    const reader = (name: string, reads: INode[], parent = root) => {
        const node = new ReaderNode(
            doc,
            name,
            reads.map((x) => x.id),
        );
        parent.add(node);
        return node;
    };

    test("recognises nodes implementing the contract", () => {
        expect(isNodeReferences(new ReaderNode(doc, "r", []))).toBe(true);
        expect(isNodeReferences(folder("plain"))).toBe(false);
    });

    test("finds the readers of a removed node", () => {
        const sketch = folder("sketch");
        const body = reader("body", [sketch]);
        reader("unrelated", [folder("other")]);

        expect(findNodeDependents(root, [sketch])).toEqual([body]);
    });

    test("a node inside a removed folder counts as removed", () => {
        const group = folder("group");
        const sketch = folder("sketch", group);
        const body = reader("body", [sketch]);

        expect(findNodeDependents(root, [group])).toEqual([body]);
    });

    test("readers removed along with what they read are not reported", () => {
        const sketch = folder("sketch");
        const body = reader("body", [sketch]);

        expect(findNodeDependents(root, [sketch, body])).toEqual([]);
    });

    test("a node reading itself is not its own dependent", () => {
        const self = new ReaderNode(doc, "self", []);
        (self as unknown as { reads: string[] }).reads.push(self.id);
        root.add(self);

        expect(findNodeDependents(root, [self])).toEqual([]);
    });
});
