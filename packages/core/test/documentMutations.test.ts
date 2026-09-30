// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentMutations, FolderNode, History, Transaction } from "../src";
import { TestDocument } from "../test-utils";

test("owner authority expires at an await and blocks external property/tree/transaction mutations", async () => {
    const doc = new TestDocument();
    const root = doc.modelManager.rootNode;
    const original = root.name;
    const child = new FolderNode({ document: doc, name: "child" });
    const owner = DocumentMutations.hold(doc);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const running = Transaction.executeAsync(
        doc,
        "owned",
        async () => {
            owner.run(() => {
                root.name = "owned change";
            });
            await wait;
            owner.run(() => {
                root.add(child);
            });
        },
        owner,
    );
    try {
        expect(root.name).toBe("owned change");
        expect(() => {
            root.name = "external";
        }).toThrow("modeling program is running");
        expect(root.name).toBe("owned change");
        expect(() => root.add(child)).toThrow("modeling program is running");
        expect(root.size()).toBe(0);
        const other = new TestDocument();
        try {
            other.modelManager.rootNode.name = "other document edit";
            expect(other.modelManager.rootNode.name).toBe("other document edit");
            expect(other.history.undoCount()).toBe(1);
        } finally {
            other.dispose();
        }
        expect(() => Transaction.execute(doc, "external", () => {})).toThrow("modeling program is running");
        release();
        await running;
        expect(root.size()).toBe(1);
        expect(doc.history.undoCount()).toBe(1);
    } finally {
        release();
        await running;
        owner.release();
    }
    doc.history.undo();
    expect(root.name).toBe(original);
    expect(root.size()).toBe(0);
    doc.history.redo();
    expect(root.name).toBe("owned change");
    expect(root.size()).toBe(1);
    doc.dispose();
});

test("owned async rollback restores history and no empty undo step is created for queries", async () => {
    const doc = new TestDocument();
    const root = doc.modelManager.rootNode;
    const original = root.name;
    const owner = DocumentMutations.hold(doc);
    try {
        await expect(
            Transaction.executeAsync(
                doc,
                "failure",
                async () => {
                    owner.run(() => {
                        root.name = "temporary";
                    });
                    await Promise.resolve();
                    throw new Error("worker timeout");
                },
                owner,
            ),
        ).rejects.toThrow("worker timeout");
        expect(root.name).toBe(original);
        expect(doc.history.undoCount()).toBe(0);
        await Transaction.executeAsync(
            doc,
            "query",
            async () => {
                await Promise.resolve();
            },
            owner,
        );
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        owner.release();
        doc.dispose();
    }
});

test("external replay leaves history stacks intact and owned failure restores the exact undo position", async () => {
    const doc = new TestDocument();
    const root = doc.modelManager.rootNode;
    const original = root.name;
    root.name = "committed";
    const position = doc.history.position();
    const owner = DocumentMutations.hold(doc);
    try {
        await expect(
            Transaction.executeAsync(
                doc,
                "failed worker",
                async () => {
                    owner.run(() => {
                        root.name = "temporary";
                    });
                    await Promise.resolve();
                    expect(() => doc.history.undo()).toThrow("modeling program is running");
                    expect(() => doc.history.redo()).toThrow("modeling program is running");
                    expect(doc.history.position()).toBe(position);
                    expect(doc.history.undoCount()).toBe(1);
                    expect(doc.history.redoCount()).toBe(0);
                    throw new Error("worker timeout");
                },
                owner,
            ),
        ).rejects.toThrow("worker timeout");
        expect(root.name).toBe("committed");
        expect(doc.history.position()).toBe(position);
    } finally {
        owner.release();
        owner.release();
    }
    doc.history.undo();
    expect(root.name).toBe(original);
    doc.history.redo();
    expect(root.name).toBe("committed");
    expect(doc.history.position()).toBe(position);
    doc.dispose();
});

test("history disposal and guard removal are idempotent", () => {
    const history = new History();
    const release = History.addMutationGuard(history, () => {
        throw new Error("held");
    });
    expect(() => history.undo()).toThrow("held");
    history.dispose();
    release();
    release();
    history.undo();
    expect(history.undoCount()).toBe(0);
    expect(history.redoCount()).toBe(0);
    history.dispose();
});
