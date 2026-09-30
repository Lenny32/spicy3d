// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    FolderNode,
    type IKernelRecoveryContext,
    KernelRecoveryCheckpoints,
    KernelState,
    Transaction,
} from "../src";
import { TestDocument } from "../test-utils";

function document() {
    const doc = new TestDocument();
    doc.analyses.dispose();
    const serialize = doc.serialize.bind(doc);
    doc.serialize = () => ({ ...serialize(), models: doc.modelManager.serialize() });
    doc.modelManager.addNode(new FolderNode({ document: doc, name: "committed", id: "stable-feature" }));
    return doc;
}
function context() {
    const dispose = rs.fn();
    return { run: <T>(action: () => T) => action(), dispose, publish() {} } satisfies IKernelRecoveryContext;
}

afterEach(() => KernelState.current.reset());

test("the committed checkpoint excludes an interrupted transaction and never reads dead native data", () => {
    const doc = document();
    expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true);
    const position = doc.history.position();
    const trans = new Transaction(doc, "interrupted");
    trans.start();
    doc.modelManager.findNode((node) => node.id === "stable-feature")!.name = "uncommitted";
    expect(KernelRecoveryCheckpoints.capture(doc)).toBe(false);
    KernelState.current.markCrashed("injected crash");
    const serialize = rs.spyOn(doc, "serialize").mockImplementation(() => {
        throw new Error("dead native access");
    });
    const checkpoint = KernelRecoveryCheckpoints.read(doc);
    expect(checkpoint.position).toBe(position);
    expect(checkpoint.data["models"].nodes[1].name).toBe("committed");
    expect(serialize).not.toHaveBeenCalled();
    serialize.mockRestore();
    trans.rollback();
});

test("a newer committed position without a checkpoint is refused explicitly", () => {
    const doc = document();
    expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true);
    doc.modelManager.findNode((node) => node.id === "stable-feature")!.name = "later commit";
    expect(() => KernelRecoveryCheckpoints.read(doc)).toThrow("current committed document state");
});

test("candidate lookup restores live graph and history after validation and disposal", () => {
    const doc = document();
    const root = doc.modelManager.rootNode;
    const node = doc.modelManager.findNode((node) => node.id === "stable-feature");
    const position = doc.history.position();
    let candidateNode = node;
    const changed = rs.fn();
    doc.modelManager.addNodeObserver(changed);
    const graph = doc.modelManager.prepareRecoveryNodes(doc.modelManager.serialize().nodes, () => {
        candidateNode = doc.modelManager.findNode((node) => node.id === "stable-feature");
        expect(candidateNode).not.toBe(node);
        expect(candidateNode?.name).toBe("committed");
    });
    expect(doc.modelManager.rootNode).toBe(root);
    expect(doc.modelManager.findNode((node) => node.id === "stable-feature")).toBe(node);
    expect(doc.history.position()).toBe(position);
    graph.run(() =>
        expect(doc.modelManager.findNode((node) => node.id === "stable-feature")).toBe(candidateNode),
    );
    graph.dispose();
    graph.dispose();
    expect(changed).not.toHaveBeenCalled();
    expect(doc.modelManager.rootNode).toBe(root);
    expect(doc.history.position()).toBe(position);
});

test("failure in the second open document disposes candidates without publishing either graph", async () => {
    const docs = [document(), document()];
    const roots = docs.map((doc) => doc.modelManager.rootNode);
    const positions = docs.map((doc) => doc.history.position());
    docs.forEach((doc) => expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true));
    const nativeContext = context();
    const preparedDispose = rs.fn();
    await expect(
        KernelRecoveryCheckpoints.prepare(
            docs,
            async () => nativeContext,
            (doc, checkpoint) => {
                const graph = doc.modelManager.prepareRecoveryNodes(checkpoint.data["models"].nodes, () => {
                    if (doc === docs[1]) throw new Error("second document rebuild failed");
                });
                return {
                    dispose() {
                        preparedDispose();
                        graph.dispose();
                    },
                };
            },
        ),
    ).rejects.toThrow("second document rebuild failed");
    expect(preparedDispose).toHaveBeenCalledTimes(1);
    expect(nativeContext.dispose).toHaveBeenCalledTimes(1);
    docs.forEach((doc, index) => {
        expect(doc.modelManager.rootNode).toBe(roots[index]);
        expect(doc.history.position()).toBe(positions[index]);
    });
});

test("module creation failure leaves every document and checkpoint intact", async () => {
    const doc = document();
    expect(KernelRecoveryCheckpoints.capture(doc)).toBe(true);
    const root = doc.modelManager.rootNode;
    const prepare = rs.fn(() => ({ dispose() {} }));
    await expect(
        KernelRecoveryCheckpoints.prepare(
            [doc],
            async () => {
                throw new Error("module creation failed");
            },
            prepare,
        ),
    ).rejects.toThrow("module creation failed");
    expect(prepare).not.toHaveBeenCalled();
    expect(doc.modelManager.rootNode).toBe(root);
    expect(KernelRecoveryCheckpoints.read(doc).data["models"].nodes[1].name).toBe("committed");
});

test("candidate run refuses an asynchronous turn and restores live lookup immediately", () => {
    const doc = document();
    const root = doc.modelManager.rootNode;
    const graph = doc.modelManager.prepareRecoveryNodes(doc.modelManager.serialize().nodes, () => {});
    expect(() => graph.run(() => Promise.resolve())).toThrow("must be synchronous");
    expect(doc.modelManager.rootNode).toBe(root);
    expect(doc.history.disabled).toBe(false);
    graph.dispose();
});
