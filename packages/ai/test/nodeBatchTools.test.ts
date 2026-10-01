// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { FolderNode } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
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
        "delete_node",
        "set_node_visible",
    ])("%s reports missing ids and applies duplicates once in one undo step", async (name) => {
        const {
            doc,
            nodes: [first, second, untouched],
        } = setup();
        const before = doc.history.undoCount();
        const update = rs.spyOn(doc.visual, "update");
        const result = await call(name, {
            ids: [first.id, "missing", second.id, first.id],
            visible: false,
        });
        expect(result.error).toContain("Some node ids failed");
        expect(toCallToolResult(JSON.stringify(result)).isError).toBe(true);
        expect(result.results).toEqual([
            name === "delete_node" ? { id: first.id, deleted: first.id } : { id: first.id, visible: false },
            { id: "missing", error: "node not found; call get_document_state for current ids" },
            name === "delete_node"
                ? { id: second.id, deleted: second.id }
                : { id: second.id, visible: false },
            name === "delete_node" ? { id: first.id, deleted: first.id } : { id: first.id, visible: false },
        ]);
        expect(doc.history.undoCount()).toBe(before + 1);
        expect(update).toHaveBeenCalledTimes(1);
        if (name === "delete_node") {
            expect(doc.modelManager.findNodes().map((node) => node.id)).toEqual([untouched.id]);
        } else {
            expect([first.visible, second.visible, untouched.visible]).toEqual([false, false, true]);
        }
        doc.history.undo();
        expect(doc.history.undoCount()).toBe(before);
        expect(new Set(doc.modelManager.findNodes().map((node) => node.id))).toEqual(
            new Set([first.id, second.id, untouched.id]),
        );
        expect([first.visible, second.visible, untouched.visible]).toEqual([true, true, true]);
        doc.history.redo();
        if (name === "delete_node") {
            expect(doc.modelManager.findNodes().map((node) => node.id)).toEqual([untouched.id]);
        } else {
            expect([first.visible, second.visible, untouched.visible]).toEqual([false, false, true]);
        }
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
        const ids = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(128, "\u0000"));
        const result = await call(name, { ids, visible: false });
        expect(result.results).toHaveLength(100);
        expect(result.results.map((item: { id: string }) => item.id)).toEqual(ids);
        const envelope = JSON.stringify(toCallToolResult(JSON.stringify(result)));
        expect(new TextEncoder().encode(envelope).byteLength).toBeLessThan(256 * 1024);
        expect(doc.history.undoCount()).toBe(3);
    });

    test("a mutation failure rolls back every valid id and reports them as failed", async () => {
        const {
            doc,
            nodes: [first, second, untouched],
        } = setup();
        const before = doc.history.position();
        const root = doc.modelManager.rootNode as FolderNode;
        const remove = root.remove.bind(root);
        rs.spyOn(root, "remove").mockImplementation((...nodes) => {
            if (nodes.includes(second)) throw new Error("injected failure");
            remove(...nodes);
        });
        const result = await call("delete_node", { ids: [first.id, second.id] });
        expect(result.results).toEqual(
            [first, second].map((node) => ({
                id: node.id,
                error: "batch could not be applied; changes rolled back",
            })),
        );
        expect(doc.history.position()).toBe(before);
        expect(new Set(root.children())).toEqual(new Set([first, second, untouched]));
    });
});
