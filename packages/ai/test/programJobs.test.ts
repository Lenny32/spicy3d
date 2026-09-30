// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DocumentRebuilds, type IShape, Result, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockDocument, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { createMcpServer, SerialQueue } from "../src/mcp/server";
import { buildProgramJobTools, ProgramJobs } from "../src/tools/programJobs";
import { buildReadTools } from "../src/tools/readTools";

const boxOp = { id: "source", name: "source", method: "box", args: { dx: 10, dy: 10, dz: 10 } };
const filletOp = {
    id: "rounded",
    name: "rounded",
    method: "fillet",
    args: { shape: "source", edges: [0], radius: 1 },
};
const connections: Client[] = [];
const managers: ProgramJobs[] = [];

afterEach(async () => {
    for (const client of connections.splice(0)) await client.close();
    for (const jobs of managers.splice(0)) jobs.forget("owner");
    rs.unstubAllGlobals();
    rs.useRealTimers();
});

function setup() {
    const doc = new TestDocument({ selection: createMockDocument().selection });
    const shape = () => new MockShape({ shapeType: ShapeTypes.solid });
    let settle!: () => void;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const ready = new Promise<void>((resolve) => {
        settle = resolve;
    });
    let answer: Result<IShape> = Result.ok(shape());
    const shapeOperation = rs.fn((_request: unknown, signal?: AbortSignal) => {
        const abort = () => {
            answer = Result.err("Geometry worker operation cancelled");
            settle();
        };
        signal?.addEventListener("abort", abort, { once: true });
        entered();
        return {
            ready: ready.finally(() => signal?.removeEventListener("abort", abort)),
            take: () => answer,
            cancel: () => signal?.removeEventListener("abort", abort),
        };
    });
    const app = createMockApplication({
        shapeProvider: {
            factory: { box: () => Result.ok(shape()), boundedOperations: { shapeOperation } },
        } as never,
    });
    app.activeView = { document: doc } as never;
    rs.stubGlobal("app", app);
    return { doc, app, entry, settle, shapeOperation };
}

async function connect() {
    const marker = rs.fn(async () => JSON.stringify({ ran: true }));
    const server = createMcpServer({
        tools: [
            ...buildProgramJobTools(),
            ...buildReadTools(),
            { name: "mutation", description: "test", parameters: { type: "object" }, handler: marker },
        ],
        queue: new SerialQueue(),
    });
    const client = new Client({ name: "jobs-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    connections.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await client.callTool({ name, arguments: args });
        const content = response.content as { type: string; text: string }[];
        expect(content[0].type).toBe("text");
        return JSON.parse(content[0].text);
    };
    return { client, call, marker };
}

async function terminal(call: Awaited<ReturnType<typeof connect>>["call"], jobId: string) {
    for (let i = 0; i < 100; i++) {
        const value = await call("get_program_job", { jobId });
        if (["completed", "cancelled", "failed"].includes(value.state)) return value;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Job did not settle");
}

test("a worker-held job returns immediately, reports progress, and preserves the shared mutation FIFO", async () => {
    const { doc, entry, settle } = setup();
    const { call, marker } = await connect();
    const started = await call("start_program_job", { ops: [boxOp, filletOp] });
    expect(started.state).toBe("queued");
    expect(started.documentId).toBe(doc.id);
    await entry;
    const status = await call("get_program_job", { jobId: started.jobId });
    expect(status.state).toBe("running");
    expect(status.progress).toEqual({ completed: 1, total: 2, method: "fillet" });
    const metadata = await call("get_document_state");
    expect(metadata.nodes).toEqual([]);
    const next = call("mutation");
    await Promise.resolve();
    expect(marker).not.toHaveBeenCalled();
    settle();
    const completed = await terminal(call, started.jobId);
    expect(completed.state).toBe("completed");
    expect(completed.progress).toEqual({ completed: 2, total: 2 });
    expect(completed.result.created.map((item: { name: string }) => item.name)).toEqual([
        "source",
        "rounded",
    ]);
    expect(completed.result.removed).toHaveLength(1);
    expect(await next).toEqual({ ran: true });
    expect(marker).toHaveBeenCalledTimes(1);
});

test("cancellation bypasses the queue, rolls back before the next mutation and retains the terminal answer", async () => {
    const { doc, entry } = setup();
    const { call, marker } = await connect();
    const started = await call("start_program_job", { ops: [boxOp, filletOp] });
    await entry;
    const next = call("mutation");
    const cancelling = await call("cancel_program_job", { jobId: started.jobId });
    expect(["cancelling", "cancelled"]).toContain(cancelling.state);
    const cancelled = await terminal(call, started.jobId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("Cancelled by the caller");
    expect(doc.modelManager.findNodes(() => true)).toEqual([]);
    expect(await next).toEqual({ ran: true });
    expect(marker).toHaveBeenCalledTimes(1);
    expect(await call("get_program_job", { jobId: started.jobId })).toEqual(cancelled);
});

test("closing the MCP connection cancels its native job and restores the document", async () => {
    const { doc, entry } = setup();
    const { call, client } = await connect();
    await call("start_program_job", { ops: [boxOp, filletOp] });
    await entry;
    await client.close();
    for (let i = 0; i < 20 && doc.modelManager.findNodes(() => true).length; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.modelManager.findNodes(() => true)).toEqual([]);
});

test("only the actual built-in job tools bypass the queue", async () => {
    setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const queue = new SerialQueue();
    const held = queue.run(() => gate);
    const handler = rs.fn(async () => "{}");
    const server = createMcpServer({
        queue,
        tools: [{ name: "get_program_job", description: "plugin", parameters: { type: "object" }, handler }],
    });
    const client = new Client({ name: "fake-tool", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    connections.push(client);
    const result = client.callTool({ name: "get_program_job" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    finish();
    await held;
    await result;
    expect(handler).toHaveBeenCalledTimes(1);
});

test("queued jobs stay bound to their original document and are private to their caller", async () => {
    const { app } = setup();
    const execute = rs.fn(async () => JSON.stringify({ created: [] }));
    const jobs = new ProgramJobs(execute);
    managers.push(jobs);
    const tasks: (() => Promise<void>)[] = [];
    const context = {
        caller: "owner",
        scheduleMutation: (task: () => Promise<void>) => {
            tasks.push(task);
            return Promise.resolve();
        },
    };
    const started = jobs.start({ ops: [boxOp] }, context) as { jobId: string };
    expect(() => jobs.read({ jobId: started.jobId }, { caller: "other" })).toThrow("not found");
    expect(() => jobs.cancel({ jobId: started.jobId }, { caller: "other" })).toThrow("not found");
    app.activeView = { document: createMockDocument() } as never;
    await tasks[0]();
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.read({ jobId: started.jobId }, context)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("document changed"),
    });
});

test("queued cancellation prevents execution and completed jobs expire after ten minutes", async () => {
    setup();
    let now = 0;
    const execute = rs.fn(async () => JSON.stringify({ created: [] }));
    const jobs = new ProgramJobs(execute, () => now);
    managers.push(jobs);
    const tasks: (() => Promise<void>)[] = [];
    const context = {
        caller: "owner",
        scheduleMutation: (task: () => Promise<void>) => {
            tasks.push(task);
            return Promise.resolve();
        },
    };
    const started = jobs.start({ ops: [boxOp] }, context) as { jobId: string };
    expect(jobs.cancel({ jobId: started.jobId }, context)).toMatchObject({ state: "cancelled" });
    await tasks[0]();
    expect(execute).not.toHaveBeenCalled();
    now = 600_000;
    expect(() => jobs.read({ jobId: started.jobId }, context)).toThrow("not found");
});

test("deadline cancellation settles worker work and operation errors remain failed completion results", async () => {
    const { entry } = setup();
    const { call } = await connect();
    const started = await call("start_program_job", { ops: [boxOp, filletOp], timeoutMs: 100 });
    await entry;
    const cancelled = await terminal(call, started.jobId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("Modeling job deadline exceeded");
    const failed = await call("start_program_job", { ops: [{ method: "unknown" }] });
    expect(await terminal(call, failed.jobId)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("unknown"),
    });
});

test("runtime rebuild status observes yielded feature indexes without flushing geometry", async () => {
    const { doc } = setup();
    const flush = rs.fn();
    let featureIndex = 3;
    const release = DocumentRebuilds.add(doc, {
        settled: Promise.resolve(),
        flush,
        get featureIndex() {
            return featureIndex;
        },
    });
    try {
        const { call } = await connect();
        expect(await call("get_rebuild_status")).toEqual({
            documentId: doc.id,
            pending: 1,
            featureIndexes: [3],
        });
        featureIndex = 7;
        expect(await call("get_rebuild_status")).toEqual({
            documentId: doc.id,
            pending: 1,
            featureIndexes: [7],
        });
        expect(flush).not.toHaveBeenCalled();
    } finally {
        release();
    }
    expect(DocumentRebuilds.status(doc)).toEqual({ pending: 0, featureIndexes: [] });
});

test("input copies isolate queued jobs from later argument edits and oversized results stay committed", async () => {
    setup();
    const execute = rs.fn(async (args: Record<string, unknown>) =>
        JSON.stringify({ data: "x".repeat(1_048_576), received: args }),
    );
    const jobs = new ProgramJobs(execute);
    managers.push(jobs);
    const tasks: (() => Promise<void>)[] = [];
    const context = {
        caller: "owner",
        scheduleMutation: (task: () => Promise<void>) => {
            tasks.push(task);
            return Promise.resolve();
        },
    };
    const args = { ops: [{ ...boxOp, args: { dx: 10, dy: 10, dz: 10 } }] };
    const started = jobs.start(args, context) as { jobId: string };
    args.ops[0].args.dx = 999;
    await tasks[0]();
    expect(execute).toHaveBeenCalledWith(
        { ops: [{ ...boxOp, args: { dx: 10, dy: 10, dz: 10 } }] },
        expect.any(AbortSignal),
        expect.any(Function),
    );
    expect(jobs.read({ jobId: started.jobId }, context)).toMatchObject({
        state: "completed",
        error: expect.stringContaining("Program committed"),
    });
    expect(jobs.cancel({ jobId: started.jobId }, context)).toMatchObject({ state: "completed" });
});

test("session/page capacities bound active work and finished eviction never drops an active job", async () => {
    setup();
    const execute = rs.fn(async () => "{}");
    const jobs = new ProgramJobs(execute);
    const contexts = ["owner", "second", "third", "fourth", "fifth"].map((caller) => ({
        caller,
        scheduleMutation: (_task: () => Promise<void>) => Promise.resolve(),
    }));
    try {
        const first = jobs.start({ ops: [boxOp] }, contexts[0]) as { jobId: string };
        for (let i = 0; i < 3; i++) jobs.start({ ops: [boxOp] }, contexts[0]);
        expect(() => jobs.start({ ops: [boxOp] }, contexts[0])).toThrow("four active");
        for (const context of contexts.slice(1, 4))
            for (let i = 0; i < 4; i++) jobs.start({ ops: [boxOp] }, context);
        expect(() => jobs.start({ ops: [boxOp] }, contexts[4])).toThrow("sixteen active");
        expect(jobs.read({ jobId: first.jobId }, contexts[0])).toMatchObject({ state: "queued" });
        jobs.cancel({ jobId: first.jobId }, contexts[0]);
        const replacement = jobs.start({ ops: [boxOp] }, contexts[4]) as { jobId: string };
        expect(jobs.read({ jobId: replacement.jobId }, contexts[4])).toMatchObject({ state: "queued" });
        expect(() => jobs.read({ jobId: first.jobId }, contexts[0])).toThrow("not found");
    } finally {
        for (const context of contexts) jobs.forget(context.caller);
    }
    expect(execute).not.toHaveBeenCalled();
});

test.each([0, -1, Infinity, NaN, 600_001])("invalid deadline %s creates no queued job", (timeoutMs) => {
    setup();
    const jobs = new ProgramJobs();
    managers.push(jobs);
    const scheduleMutation = rs.fn(async (_task: () => Promise<void>) => {});
    expect(() => jobs.start({ ops: [boxOp], timeoutMs }, { caller: "owner", scheduleMutation })).toThrow(
        "timeoutMs",
    );
    expect(scheduleMutation).not.toHaveBeenCalled();
});
