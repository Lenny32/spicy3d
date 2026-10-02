// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { DocumentMutations, FolderNode, type INode, REDACTED } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { toCallToolResult } from "../src/mcp/server";
import { buildNodeTools } from "../src/tools/nodeTools";

function setup() {
    const doc = new TestDocument();
    const nodes = ["first", "second", "untouched"].map((name) => {
        const node = new FolderNode({ document: doc, name });
        doc.modelManager.addNode(node);
        return node;
    });
    const app = createMockApplication();
    app.activeView = createMockView({ document: doc });
    rs.stubGlobal("app", app);
    return { doc, nodes };
}

async function call(name: string, args: Record<string, unknown>) {
    const tool = buildNodeTools().find((tool) => tool.name === name)!;
    return JSON.parse((await tool.handler(args)) as string);
}

afterEach(() => {
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

describe("node batches", () => {
    test.each([
        {
            name: "delete_node",
            reply: (id: string) => ({ id, deleted: id }),
            nodeIds: [2],
            visibility: [true, true, true],
        },
        {
            name: "set_node_visible",
            reply: (id: string) => ({ id, visible: false }),
            nodeIds: [0, 1, 2],
            visibility: [false, false, true],
        },
    ])("$name reports missing ids and applies duplicates once in one undo step", async ({
        name,
        reply,
        nodeIds,
        visibility,
    }) => {
        const { doc, nodes } = setup();
        const [first, second, untouched] = nodes;
        const before = doc.history.undoCount();
        const update = rs.spyOn(doc.visual, "update");
        const result = await call(name, {
            ids: [first.id, "missing", second.id, first.id],
            visible: false,
        });
        expect(result.error).toContain("Some node ids failed");
        expect(toCallToolResult(JSON.stringify(result)).isError).toBe(true);
        expect(result.results).toEqual([
            reply(first.id),
            { id: "missing", error: "node not found; call get_document_state for current ids" },
            reply(second.id),
            reply(first.id),
        ]);
        const assertApplied = () => {
            expect(doc.modelManager.findNodes().map((node) => node.id)).toEqual(
                nodeIds.map((i) => nodes[i].id),
            );
            expect(nodes.map((node) => node.visible)).toEqual(visibility);
        };
        expect(doc.history.undoCount()).toBe(before + 1);
        expect(update).toHaveBeenCalledTimes(1);
        assertApplied();
        doc.history.undo();
        expect(doc.history.undoCount()).toBe(before);
        expect(new Set(doc.modelManager.findNodes().map((node) => node.id))).toEqual(
            new Set([first.id, second.id, untouched.id]),
        );
        expect(nodes.map((node) => node.visible)).toEqual([true, true, true]);
        doc.history.redo();
        assertApplied();
    });

    test.each([
        false,
        true,
    ])("deletes a folder and child regardless of order (child first: %s)", async (childFirst) => {
        const {
            doc,
            nodes: [parent, child, untouched],
        } = setup();
        child.parent!.move(child, parent);
        const before = doc.history.undoCount();
        const ids = childFirst ? [child.id, parent.id] : [parent.id, child.id];
        const result = await call("delete_node", { ids });
        expect(result).toEqual({ results: ids.map((id) => ({ id, deleted: id })) });
        expect(doc.modelManager.findNodes().map((node) => node.id)).toEqual([untouched.id]);
        expect(child.parent).toBe(parent);
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        expect(parent.parent).toBe(doc.modelManager.rootNode);
        expect(parent.children()).toEqual([child]);
        doc.history.redo();
        expect(doc.modelManager.findNodes().map((node) => node.id)).toEqual([untouched.id]);
    });

    test.each([
        "delete_node",
        "set_node_visible",
    ])("%s leaves history unchanged if all ids are missing", async (name) => {
        const { doc } = setup();
        const before = doc.history.position();
        const update = rs.spyOn(doc.visual, "update");
        const result = await call(name, { ids: ["missing", "also-missing"], visible: false });
        expect(result.results.map((item: { id: string }) => item.id)).toEqual(["missing", "also-missing"]);
        expect(result.results.every((item: { error: string }) => item.error.includes("node not found"))).toBe(
            true,
        );
        expect(doc.history.position()).toBe(before);
        expect(update).not.toHaveBeenCalled();
    });

    test.each([
        "delete_node",
        "set_node_visible",
    ])("%s rejects malformed targets before editing", async (name) => {
        const {
            doc,
            nodes: [first],
        } = setup();
        const before = doc.history.position();
        for (const args of [
            {},
            { ids: [] },
            { ids: "bad" },
            { ids: [first.id, 7] },
            { ids: [""] },
            { id: first.id, ids: [first.id] },
            { ids: Array(101).fill(first.id) },
            { ids: ["x".repeat(129)] },
        ]) {
            const result = await call(name, { ...args, visible: false });
            expect(typeof result.error).toBe("string");
            expect(doc.history.position()).toBe(before);
            expect(first.parent).toBe(doc.modelManager.rootNode);
            expect(first.visible).toBe(true);
        }
    });

    test("visibility requires a boolean and can show a whole batch", async () => {
        const {
            doc,
            nodes: [first, second],
        } = setup();
        const before = doc.history.position();
        const invalid = await call("set_node_visible", { ids: [first.id], visible: "false" });
        expect(invalid).toEqual({ error: "visible must be a boolean" });
        expect(doc.history.position()).toBe(before);
        await call("set_node_visible", { ids: [first.id, second.id], visible: false });
        const result = await call("set_node_visible", { ids: [first.id, second.id], visible: true });
        expect(result).toEqual({ results: [first, second].map((node) => ({ id: node.id, visible: true })) });
        expect([first.visible, second.visible]).toEqual([true, true]);
        doc.history.undo();
        expect([first.visible, second.visible]).toEqual([false, false]);
    });

    test.each([
        "delete_node",
        "set_node_visible",
    ])("%s bounds replies at the maximum batch size", async (name) => {
        const { doc } = setup();
        const before = doc.history.undoCount();
        const ids = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(128, "\u0000"));
        const result = await call(name, { ids, visible: false });
        expect(result.results).toHaveLength(100);
        expect(result.results.map((item: { id: string }) => item.id)).toEqual(ids);
        const envelope = JSON.stringify(toCallToolResult(JSON.stringify(result)));
        expect(new TextEncoder().encode(envelope).byteLength).toBeLessThan(256 * 1024);
        expect(doc.history.undoCount()).toBe(before);
    });

    test("hiding a folder in a batch hides descendants through inherited visibility", async () => {
        const {
            doc,
            nodes: [parent, child, other],
        } = setup();
        child.parent!.move(child, parent);
        const grandchild = new FolderNode({ document: doc, name: "grandchild" });
        child.add(grandchild);
        const before = doc.history.undoCount();
        const ids = [parent.id, other.id];
        const result = await call("set_node_visible", { ids, visible: false });
        expect(result).toEqual({ results: ids.map((id) => ({ id, visible: false })) });
        expect([parent.visible, other.visible]).toEqual([false, false]);
        expect([child.visible, grandchild.visible]).toEqual([true, true]);
        expect([child.parentVisible, grandchild.parentVisible]).toEqual([false, false]);
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        expect([parent.visible, other.visible, child.parentVisible, grandchild.parentVisible]).toEqual([
            true,
            true,
            true,
            true,
        ]);
        doc.history.redo();
        expect([child.parentVisible, grandchild.parentVisible]).toEqual([false, false]);
    });

    test.each([
        { name: "delete_node", deleted: true, visible: true },
        { name: "set_node_visible", deleted: false, visible: false },
    ])("$name batches a real parametric body with a folder", async ({ name, deleted, visible }) => {
        const {
            doc,
            nodes: [folder],
        } = setup();
        const body = new ParametricBodyNode({ document: doc, features: [] });
        doc.modelManager.addNode(body);
        const before = doc.history.undoCount();
        const ids = [body.id, folder.id];
        const result = await call(name, { ids, visible: false });
        expect(result.results.map((item: { id: string }) => item.id)).toEqual(ids);
        expect(result.error).toBeUndefined();
        const state = (node: INode) => ({ parent: node.parent, visible: node.visible });
        const applied = { parent: deleted ? undefined : doc.modelManager.rootNode, visible };
        expect(state(body)).toEqual(applied);
        expect(state(folder)).toEqual(applied);
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        expect(state(body)).toEqual({ parent: doc.modelManager.rootNode, visible: true });
        expect(state(folder)).toEqual({ parent: doc.modelManager.rootNode, visible: true });
        doc.history.redo();
        expect(state(body)).toEqual(applied);
        expect(state(folder)).toEqual(applied);
    });

    test.each([
        "delete_node",
        "set_node_visible",
    ])("%s reports why document mutations are blocked", async (name) => {
        const {
            doc,
            nodes: [first, second],
        } = setup();
        const before = doc.history.position();
        const hold = DocumentMutations.hold(doc);
        try {
            const result = await call(name, { ids: [first.id, second.id], visible: false });
            expect(result.results).toEqual(
                [first, second].map((node) => ({
                    id: node.id,
                    error: "batch could not be applied; changes rolled back: A modeling program is running; wait for it to finish before editing",
                })),
            );
            expect(doc.history.position()).toBe(before);
            expect([first.parent, second.parent]).toEqual([
                doc.modelManager.rootNode,
                doc.modelManager.rootNode,
            ]);
            expect([first.visible, second.visible]).toEqual([true, true]);
        } finally {
            hold.release();
        }
    });

    test.each([
        { cause: "injected failure", expected: "injected failure" },
        {
            cause: "failed https://example.com/model?token=secret",
            expected: `failed https://example.com/model?${REDACTED}`,
        },
    ])("a mutation failure rolls back every valid id and reports a safe cause: $cause", async ({
        cause,
        expected,
    }) => {
        const {
            doc,
            nodes: [first, second, untouched],
        } = setup();
        const before = doc.history.position();
        const root = doc.modelManager.rootNode as FolderNode;
        const remove = root.remove.bind(root);
        rs.spyOn(root, "remove").mockImplementation((...nodes) => {
            if (nodes.includes(second)) throw new Error(cause);
            remove(...nodes);
        });
        const result = await call("delete_node", { ids: [first.id, second.id] });
        expect(result.results).toEqual(
            [first, second].map((node) => ({
                id: node.id,
                error: `batch could not be applied; changes rolled back: ${expected}`,
            })),
        );
        expect(doc.history.position()).toBe(before);
        expect(new Set(root.children())).toEqual(new Set([first, second, untouched]));
    });
});
