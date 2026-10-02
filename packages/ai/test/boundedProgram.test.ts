// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    AutosaveHolds,
    type BoundedShapeRequest,
    DocumentMutations,
    DocumentRebuilds,
    type IShape,
    Result,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { createMcpServer, documentResource } from "../src/mcp/server";
import { buildCapabilityTools } from "../src/tools/capabilityEngine";
import { buildReadTools, documentSnapshot } from "../src/tools/readTools";

function setup() {
    const doc = new TestDocument({ selection: createMockDocument().selection });
    const shape = (volume: number) => {
        const value = new MockShape({ shapeType: ShapeTypes.solid });
        value.volume = () => volume;
        return value;
    };
    const box = rs.fn((_plane: unknown, dx: number) => Result.ok(shape(dx)));
    const fillet = rs.fn((_shape: IShape, _edges: number[], _radius: number) => Result.ok(shape(99)));
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let answer: Result<IShape> = Result.err("Geometry worker operation timed out after 90000 ms");
    const shapeOperation = rs.fn((_request: BoundedShapeRequest, signal?: AbortSignal) => {
        const abort = () => {
            answer = Result.err("Geometry worker operation cancelled");
            finish();
        };
        signal?.addEventListener("abort", abort, { once: true });
        return { ready, take: () => answer, cancel: () => signal?.removeEventListener("abort", abort) };
    });
    const app = createMockApplication({
        shapeProvider: { factory: { box, fillet, boundedOperations: { shapeOperation } } } as never,
    });
    app.activeView = { document: doc } as never;
    rs.stubGlobal("app", app);
    return {
        app,
        doc,
        box,
        fillet,
        shapeOperation,
        finish,
        succeed: () => {
            answer = Result.ok(shape(5));
            finish();
        },
        tool: buildCapabilityTools()[0],
    };
}
function boxOp(id: string, dx = 10) {
    return { id, method: "box", args: { dx, dy: 10, dz: 10 } };
}
function filletOp(id: string, shape: string) {
    return { id, method: "fillet", args: { shape, edges: [0], radius: 1 } };
}
afterEach(() => {
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

test("timeout restores nodes/history and overwritten refs while metadata reads stay committed", async () => {
    const { doc, tool, shapeOperation, finish, fillet } = setup();
    try {
        await tool.handler({ ops: [boxOp("base")] });
        const before = documentSnapshot();
        const position = doc.history.position();
        const nodes = doc.modelManager.findNodes(() => true).map((node) => node.id);
        const running = tool.handler({ ops: [boxOp("base", 22), filletOp("failed", "base")] });
        const rejected = expect(running).rejects.toThrow("timed out");
        await rs.waitFor(() => expect(shapeOperation).toHaveBeenCalledTimes(1));
        expect(DocumentMutations.isHeld(doc)).toBe(true);
        expect(AutosaveHolds.isHeld).toBe(true);
        expect(documentSnapshot()).toBe(before);
        const read = buildReadTools().find((tool) => tool.name === "get_document_state")!;
        const state = JSON.parse((await read.handler({})) as string);
        expect(state.nodes.map((node: { id: string }) => node.id)).toEqual(nodes);
        expect(fillet).not.toHaveBeenCalled();
        finish();
        await rejected;
        expect(doc.history.position()).toBe(position);
        expect(doc.modelManager.findNodes(() => true).map((node) => node.id)).toEqual(nodes);
        expect(DocumentMutations.isHeld(doc)).toBe(false);
        expect(AutosaveHolds.isHeld).toBe(false);
        const reuse = JSON.parse(
            (await tool.handler({
                ops: [{ method: "shape.volume", target: "base", id: "volume" }],
            })) as string,
        );
        expect(reuse.results.volume).toBe(10);
        expect(doc.history.position()).toBe(position);
        await expect(
            tool.handler({ ops: [{ method: "shape.volume", target: "failed", id: "volume" }] }),
        ).rejects.toThrow("ai.error.unknownRef");
    } finally {
        finish();
        doc.dispose();
    }
});

test("a worker result is installed before the next op and commits one reversible edit", async () => {
    const { doc, tool, shapeOperation, succeed, fillet } = setup();
    try {
        await tool.handler({ ops: [boxOp("source")] });
        const before = doc.history.undoCount();
        const running = tool.handler({
            ops: [filletOp("rounded", "source"), { method: "shape.volume", target: "rounded", id: "volume" }],
        });
        await rs.waitFor(() => expect(shapeOperation).toHaveBeenCalledTimes(1));
        succeed();
        const response = JSON.parse((await running) as string);
        expect(response.results.volume).toBe(5);
        expect(response.created).toHaveLength(1);
        expect(response.removed).toHaveLength(1);
        expect(fillet).not.toHaveBeenCalled();
        expect(doc.history.undoCount()).toBe(before + 1);
        const nodeIds = doc.modelManager.findNodes(() => true).map((node) => node.id);
        doc.history.undo();
        const restored = doc.modelManager.findNodes(() => true).map((node) => node.id);
        expect(restored).toContain(response.removed[0].nodeId);
        expect(restored).not.toContain(response.created[0].nodeId);
        doc.history.redo();
        expect(doc.modelManager.findNodes(() => true).map((node) => node.id)).toEqual(nodeIds);
    } finally {
        succeed();
        doc.dispose();
    }
});

test("MCP status and document resources answer while worker work blocks the mutation queue", async () => {
    const { doc, tool, shapeOperation, finish } = setup();
    const reads = buildReadTools();
    const mutation = rs.fn(async () => "second mutation");
    const server = createMcpServer({
        tools: [
            tool,
            ...reads,
            {
                name: "second_mutation",
                description: "test mutation",
                parameters: { type: "object", properties: {} },
                handler: mutation,
            },
        ],
        instructions: "test",
    });
    const client = new Client({ name: "bounded-test", version: "1" }, {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
        await tool.handler({ ops: [boxOp("source")] });
        const committed = JSON.parse(documentSnapshot());
        const committedResource = JSON.parse(documentResource());
        const pending = client.callTool({
            name: "run_program",
            arguments: { ops: [boxOp("temporary"), filletOp("failed", "source")] },
        });
        await rs.waitFor(() => expect(shapeOperation).toHaveBeenCalledTimes(1));
        const second = client.callTool({ name: "second_mutation", arguments: {} });
        const status = await client.callTool({ name: "get_document_state", arguments: {} }, undefined, {
            timeout: 500,
        });
        expect(status.content).toEqual([
            {
                type: "text",
                text: JSON.stringify({
                    hasActiveDocument: committed.hasActiveDocument,
                    name: committed.name,
                    nodeCount: committed.nodeCount,
                    nodes: committed.nodes,
                }),
            },
        ]);
        const resource = await client.readResource({ uri: "spicy3d://document" }, { timeout: 500 });
        expect("text" in resource.contents[0]).toBe(true);
        if (!("text" in resource.contents[0])) throw new Error("Expected text document resource");
        expect(JSON.parse(resource.contents[0].text)).toEqual(committedResource);
        expect(mutation).not.toHaveBeenCalled();
        finish();
        expect((await pending).isError).toBe(true);
        expect((await second).content).toEqual([{ type: "text", text: "second mutation" }]);
        expect(mutation).toHaveBeenCalledTimes(1);
    } finally {
        finish();
        await client.close();
        await server.close();
        doc.dispose();
    }
});

test("a program refuses an interactive command before starting any operations", async () => {
    const { app, doc, tool, box } = setup();
    Object.defineProperty(app, "executingCommand", { value: {}, configurable: true });
    try {
        await expect(tool.handler({ ops: [boxOp("new")] })).rejects.toThrow("active command or transaction");
        expect(box).not.toHaveBeenCalled();
        expect(DocumentMutations.isHeld(doc)).toBe(false);
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        doc.dispose();
    }
});

test("a program never joins an unrelated open transaction", async () => {
    const { doc, tool, box } = setup();
    const transaction = new Transaction(doc, "interactive edit");
    const original = doc.modelManager.rootNode.name;
    transaction.start();
    doc.modelManager.rootNode.name = "interactive change";
    try {
        await expect(tool.handler({ ops: [boxOp("new")] })).rejects.toThrow("active command or transaction");
        expect(box).not.toHaveBeenCalled();
        expect(Transaction.isActive(doc)).toBe(true);
        expect(doc.modelManager.rootNode.name).toBe("interactive change");
        expect(DocumentMutations.isHeld(doc)).toBe(false);
        transaction.rollback();
        expect(doc.modelManager.rootNode.name).toBe(original);
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        if (Transaction.isActive(doc)) transaction.rollback();
        doc.dispose();
    }
});

test("program entry rechecks command ownership after waiting for earlier rebuilds", async () => {
    const { app, doc, tool, box } = setup();
    rs.spyOn(DocumentRebuilds, "settled").mockImplementation(async () => {
        Object.defineProperty(app, "executingCommand", { value: {}, configurable: true });
    });
    try {
        await expect(tool.handler({ ops: [boxOp("new")] })).rejects.toThrow("active command or transaction");
        expect(box).not.toHaveBeenCalled();
        expect(DocumentMutations.isHeld(doc)).toBe(false);
    } finally {
        doc.dispose();
    }
});

test("aborting native program work restores exact refs/history before the next queued mutation", async () => {
    const { doc, tool, shapeOperation, finish } = setup();
    await tool.handler({ ops: [boxOp("source")] });
    const before = documentSnapshot();
    const position = doc.history.position();
    const nodes = doc.modelManager.findNodes(() => true).map((node) => node.id);
    let observed: { snapshot: string; position: object; held: boolean } | undefined;
    const next = rs.fn(async () => {
        observed = {
            snapshot: documentSnapshot(),
            position: doc.history.position(),
            held: DocumentMutations.isHeld(doc),
        };
        return tool.handler({ ops: [{ method: "shape.volume", target: "source", id: "volume" }] });
    });
    const server = createMcpServer({
        tools: [
            tool,
            {
                name: "next_mutation",
                description: "reuse committed reference",
                parameters: { type: "object", properties: {} },
                handler: next,
            },
        ],
        instructions: "test",
    });
    const client = new Client({ name: "cancel-test", version: "1" }, {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const signal = new AbortController();
    try {
        const running = client.callTool(
            {
                name: "run_program",
                arguments: { ops: [boxOp("source", 22), filletOp("cancelled", "source")] },
            },
            undefined,
            { signal: signal.signal },
        );
        const rejected = expect(running).rejects.toThrow(/abort|cancel/i);
        await rs.waitFor(() => expect(shapeOperation).toHaveBeenCalledTimes(1));
        expect(shapeOperation.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
        const queued = client.callTool({ name: "next_mutation", arguments: {} });
        expect(next).not.toHaveBeenCalled();
        signal.abort();
        await rejected;
        const response = await queued;
        expect(response.isError).not.toBe(true);
        expect(response.content).toEqual([
            { type: "text", text: JSON.stringify({ created: [], removed: [], results: { volume: 10 } }) },
        ]);
        expect(next).toHaveBeenCalledTimes(1);
        expect(observed).toEqual({ snapshot: before, position, held: false });
        expect(doc.history.position()).toBe(position);
        expect(doc.modelManager.findNodes(() => true).map((node) => node.id)).toEqual(nodes);
        expect(AutosaveHolds.isHeld).toBe(false);
        await expect(
            tool.handler({ ops: [{ method: "shape.volume", target: "cancelled", id: "volume" }] }),
        ).rejects.toThrow("ai.error.unknownRef");
    } finally {
        finish();
        await client.close();
        await server.close();
        doc.dispose();
    }
});

test("a late abort cannot undo an already committed program", async () => {
    const { doc, tool } = setup();
    const signal = new AbortController();
    try {
        await tool.handler({ ops: [boxOp("committed")] }, signal.signal);
        const position = doc.history.position();
        signal.abort();
        const reused = JSON.parse(
            (await tool.handler({
                ops: [{ method: "shape.volume", target: "committed", id: "volume" }],
            })) as string,
        );
        expect(reused.results.volume).toBe(10);
        expect(doc.history.position()).toBe(position);
        expect(doc.history.undoCount()).toBe(1);
    } finally {
        doc.dispose();
    }
});

test("tolerant thicken uses a bounded edit and replaces its source as one undo step", async () => {
    const { doc, tool, shapeOperation, succeed } = setup();
    try {
        await tool.handler({ ops: [boxOp("source")] });
        const before = doc.history.undoCount();
        const running = tool.handler({
            ops: [
                {
                    id: "envelope",
                    method: "makeThickSolidTolerant",
                    args: { shape: "source", openFaces: [], thickness: -3.75 },
                },
            ],
        });
        await rs.waitFor(() => expect(shapeOperation).toHaveBeenCalledTimes(1));
        expect(shapeOperation.mock.calls[0][0]).toMatchObject({
            method: "makeThickSolidTolerant",
            closingFaces: [],
            thickness: -3.75,
        });
        succeed();
        const response = JSON.parse((await running) as string);
        expect(response.created).toHaveLength(1);
        expect(response.removed).toHaveLength(1);
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        const restored = doc.modelManager.findNodes(() => true).map((node) => node.id);
        expect(restored).toContain(response.removed[0].nodeId);
        expect(restored).not.toContain(response.created[0].nodeId);
    } finally {
        succeed();
        doc.dispose();
    }
});
