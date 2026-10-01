// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { FolderNode, PubSub, Transaction } from "@spicy3d/core";
import { createMockDocument, createMockSelection, TestDocument } from "@spicy3d/core/test-utils";
import { Delete } from "../../src/commands/delete";

/** A free node's parent: plain recorder with a FolderNode prototype for instanceof checks. */
function folderParent(removed: unknown[]) {
    const parent = { remove: (child: unknown) => removed.push(child) };
    Object.setPrototypeOf(parent, FolderNode.prototype);
    return parent;
}

describe("Delete", () => {
    test("should have command metadata", () => {
        const data = (Delete as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("modify.deleteNode");
        expect(data.icon).toBe("icon-delete");
    });

    test("getSteps should return one step with multiple: true", () => {
        const cmd = new Delete();
        const steps = (cmd as any).getSteps();
        expect(steps.length).toBe(1);
    });

    test("deleteChosen should remove nodes using Transaction pattern", () => {
        const originalExecute = Transaction.execute;
        Transaction.execute = ((_doc: unknown, _label: string, fn: () => void) => {
            fn();
        }) as typeof Transaction.execute;

        try {
            const removed: unknown[] = [];
            const nodes = [
                { id: "node-1", parent: { remove: (child: unknown) => removed.push(child) } },
                { id: "node-2", parent: { remove: (child: unknown) => removed.push(child) } },
            ];

            Transaction.execute({} as never, "delete", () => {
                for (const model of nodes) {
                    model.parent?.remove(model);
                }
            });

            expect(removed.length).toBe(2);
        } finally {
            Transaction.execute = originalExecute;
        }
    });

    test("deleteChosen should show toast when no nodes selected", async () => {
        let toastMessage = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") {
                toastMessage = message;
            }
        }) as any;

        try {
            const doc = createMockDocument();
            const cmd = new Delete();
            (cmd as any).stepDatas = [{ nodes: undefined }];
            (cmd as any)._application = { activeView: { document: doc } };
            await (cmd as any).deleteChosen();
            expect(toastMessage).toBe("toast.select.noSelected");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("deleteChosen should show toast when nodes array is empty", async () => {
        let toastMessage = "";
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") {
                toastMessage = message;
            }
        }) as any;

        try {
            const doc = createMockDocument();
            const cmd = new Delete();
            (cmd as any).stepDatas = [{ nodes: [] }];
            (cmd as any)._application = { activeView: { document: doc } };
            await (cmd as any).deleteChosen();
            expect(toastMessage).toBe("toast.select.noSelected");
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("deleteChosen should clear current node if it is in deleted nodes", async () => {
        const doc = new TestDocument({ selection: createMockSelection() });
        const nodeToDelete = new FolderNode({ document: doc, name: "Target" });
        doc.modelManager.addNode(nodeToDelete);
        doc.modelManager.currentNode = nodeToDelete;

        try {
            const cmd = new Delete();
            (cmd as any)._application = { activeView: { document: doc } };
            (cmd as any).stepDatas = [{ nodes: [nodeToDelete] }];
            await (cmd as any).deleteChosen();

            expect(doc.modelManager.currentNode).toBe(doc.modelManager.rootNode);
        } finally {
            doc.dispose();
        }
    });

    test("should not delete a consumed boolean tool and show a hint", async () => {
        const toasts: string[] = [];
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") toasts.push(message);
        }) as any;

        try {
            const doc = createMockDocument();
            const removed: unknown[] = [];
            // A plain-object parent is not a FolderNode → the node reads as a consumed tool.
            const tool = { id: "tool", parent: { remove: (child: unknown) => removed.push(child) } };
            const cmd = new Delete();
            (cmd as any)._application = { activeView: { document: doc } };
            (cmd as any).stepDatas = [{ nodes: [tool] }];

            await (cmd as any).deleteChosen();

            expect(removed.length).toBe(0);
            expect(toasts).toEqual(["toast.consumedTool.forbidden"]);
        } finally {
            PubSub.default.pub = originalPub;
        }
    });

    test("should delete free nodes while skipping consumed tools", async () => {
        const toasts: string[] = [];
        const originalPub = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, message: string) => {
            if (channel === "showToast") toasts.push(message);
        }) as any;
        const originalExecute = Transaction.execute;
        Transaction.execute = ((_doc: unknown, _label: string, fn: () => void) => fn()) as any;

        try {
            const doc = createMockDocument();
            doc.modelManager.rootNode = { id: "root" } as any;
            const removedFree: unknown[] = [];
            const removedTool: unknown[] = [];
            const free = { id: "free", parent: folderParent(removedFree) };
            const tool = { id: "tool", parent: { remove: (child: unknown) => removedTool.push(child) } };
            const cmd = new Delete();
            (cmd as any)._application = { activeView: { document: doc } };
            (cmd as any).stepDatas = [{ nodes: [free, tool] }];

            await (cmd as any).deleteChosen();

            expect(removedFree).toEqual([free]);
            expect(removedTool).toEqual([]);
            expect(toasts).toEqual(["toast.consumedTool.forbidden", "toast.delete{0}Objects"]);
        } finally {
            PubSub.default.pub = originalPub;
            Transaction.execute = originalExecute;
        }
    });

    describe("with dependents", () => {
        /** root → [sketch, body]; the body reads the sketch by id. */
        function modelWithDependent(removed: unknown[]) {
            const root = { id: "root", firstChild: undefined as unknown };
            Object.setPrototypeOf(root, FolderNode.prototype);
            const sketch = {
                id: "sketch",
                name: "Sketch 1",
                parent: root,
                nextSibling: undefined as unknown,
            };
            const body = {
                id: "body",
                name: "Body 1",
                parent: root,
                nextSibling: undefined,
                referencedNodeIds: () => ["sketch"],
            };
            (root as any).remove = (child: unknown) => removed.push(child);
            root.firstChild = sketch;
            sketch.nextSibling = body;
            return { root, sketch, body };
        }

        async function run(answer: "common.delete" | "common.cancel") {
            const dialogs: { title: string; text: string }[] = [];
            const originalPub = PubSub.default.pub;
            const originalExecute = Transaction.execute;
            PubSub.default.pub = ((channel: string, ...args: any[]) => {
                if (channel !== "showDialog") return;
                dialogs.push({ title: args[0], text: args[1].textContent });
                args[2].find((x: { content: string }) => x.content === answer).onclick();
            }) as any;
            Transaction.execute = ((_doc: unknown, _label: string, fn: () => void) => fn()) as any;
            try {
                const removed: unknown[] = [];
                const { root, sketch } = modelWithDependent(removed);
                const doc = createMockDocument();
                doc.modelManager.rootNode = root as any;
                const cmd = new Delete();
                (cmd as any)._application = { activeView: { document: doc } };
                (cmd as any).stepDatas = [{ nodes: [sketch] }];
                await (cmd as any).deleteChosen();
                return { dialogs, removed, sketch };
            } finally {
                PubSub.default.pub = originalPub;
                Transaction.execute = originalExecute;
            }
        }

        test("asks before deleting a node another one is built from, naming it", async () => {
            const { dialogs, removed, sketch } = await run("common.delete");

            expect(dialogs.length).toBe(1);
            expect(dialogs[0].title).toBe("prompt.delete.title");
            expect(dialogs[0].text).toContain("Body 1");
            expect(removed).toEqual([sketch]);
        });

        test("keeps everything when the user cancels", async () => {
            const { dialogs, removed } = await run("common.cancel");

            expect(dialogs.length).toBe(1);
            expect(removed).toEqual([]);
        });
    });
});
