// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DocumentMutations, Result, Transaction } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { applyCornerSetbackEdit } from "../../parametric/src/cornerSetbackEdit";
import { type FeatureData, featureHandler, registerFeature } from "../../parametric/src/features/feature";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { createMcpServer, SerialQueue } from "../src/mcp/server";
import { buildTools } from "../src/tools";
import { cornerJobRequest } from "../src/tools/cornerJobs";
import {
    buildCornerJobTools,
    cancelAllProgramJobs,
    isProgramJobTool,
    type ProgramJobExecutor,
    ProgramJobs,
} from "../src/tools/programJobs";
import { waitForTerminalJob } from "./_helpers/waitForTerminalJob";

const hook = rs.hoisted(() => ({
    apply: rs.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
rs.mock("@spicy3d/parametric", async () => ({
    ...(await import("../../parametric/src/parametricBodyNode")),
    applyCornerSetbackEdit: (...args: unknown[]) => hook.apply(...args),
}));
const connections: Client[] = [];
const managers: ProgramJobs[] = [];
const edges = [0, 1, 2].map((i) => ({
    kind: "line" as const,
    edgeId: `native:edge${i}`,
    start: { x: 0, y: 0, z: 0 },
    end: { x: i === 0 ? 10 : 0, y: i === 1 ? 10 : 0, z: i === 2 ? 10 : 0 },
}));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(async () => {
    cancelAllProgramJobs("Test cleanup");
    for (const client of connections.splice(0)) await client.close();
    for (const jobs of managers.splice(0)) jobs.forget("owner");
    hook.apply.mockReset();
    rs.unstubAllGlobals();
    rs.useRealTimers();
});
function setup() {
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    document.visual = createMockVisualWithDocument(document);
    document.selection = createMockSelection();
    app.activeView = createMockView({ document });
    rs.stubGlobal("app", app);
    const body = new ParametricBodyNode({
        document,
        features: [{ id: "fillet", type: "fillet", radius: 2, edges }],
    });
    document.modelManager.addNode(body);
    let entered!: () => void, settle!: () => void;
    const entry = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        settle = resolve;
    });
    hook.apply.mockImplementation(async (...args: unknown[]) => {
        const options = args[3] as { signal?: AbortSignal };
        const signal = options.signal;
        const aborted = () => settle();
        signal?.addEventListener("abort", aborted, { once: true });
        entered();
        try {
            await gate;
            return signal?.aborted ? Result.err("Worker cancelled") : Result.ok(undefined);
        } finally {
            signal?.removeEventListener("abort", aborted);
        }
    });
    return {
        app,
        document,
        body,
        entry,
        settle,
        args: { bodyId: body.id, featureId: "fillet", distances: [4, 5, 6], expectedEdgeRefs: edges },
    };
}
async function connect(extra: import("../src/llm/types").Tool[] = [], queue = new SerialQueue()) {
    const marker = rs.fn(async () => JSON.stringify({ ran: true }));
    const server = createMcpServer({
        tools: [
            ...buildTools(),
            { name: "mutation", description: "test", parameters: { type: "object" }, handler: marker },
            ...extra,
        ],
        queue,
    });
    const client = new Client({ name: "corner-jobs", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    connections.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await client.callTool({ name, arguments: args });
        const content = response.content as { type: string; text: string }[];
        expect(content[0].type).toBe("text");
        return JSON.parse(content[0].text);
    };
    return { client, call, marker };
}
function terminal(call: Awaited<ReturnType<typeof connect>>["call"], jobId: string) {
    return waitForTerminalJob(call, "get_corner_setback_job", jobId);
}
test("published tools append and only their private identity grants job bypass", () => {
    const tools = buildTools();
    const start = tools.findIndex((tool) => tool.name === "start_corner_setback_job");
    expect(start).toBeGreaterThanOrEqual(0);
    const corner = tools.slice(start, start + 3);
    expect(corner.map((tool) => tool.name)).toEqual([
        "start_corner_setback_job",
        "get_corner_setback_job",
        "cancel_corner_setback_job",
    ]);
    expect(corner.map(isProgramJobTool)).toEqual([true, true, true]);
    expect(
        isProgramJobTool({
            name: "get_corner_setback_job",
            description: "plugin",
            parameters: { type: "object" },
            handler: async () => "{}",
        }),
    ).toBe(false);
});
test("the actual published tool returns immediately, clones input and runs in the same mutation FIFO", async () => {
    const state = setup();
    const { call, marker } = await connect();
    const started = await call("start_corner_setback_job", state.args);
    expect(started.documentId).toBe(state.document.id);
    await state.entry;
    state.args.distances[0] = 99;
    const status = await call("get_corner_setback_job", { jobId: started.jobId });
    expect(status.state).toBe("running");
    expect(status.progress).toEqual({ completed: 0, total: 1, method: "cornerSetback" });
    expect(hook.apply.mock.calls[0][0]).toBe(state.body);
    expect(hook.apply.mock.calls[0][2]).toEqual([{ edges, distances: [4, 5, 6] }]);
    const next = call("mutation");
    await tick();
    expect(marker).not.toHaveBeenCalled();
    state.settle();
    const completed = await terminal(call, started.jobId);
    expect(completed.state).toBe("completed");
    expect(completed.result).toEqual({
        documentId: state.document.id,
        bodyId: state.body.id,
        featureId: "fillet",
        status: "ok",
    });
    expect(await next).toEqual({ ran: true });
});
test("cancellation remains responsive and releases the next mutation only after the apply API settles", async () => {
    const state = setup();
    const previousName = state.document.name;
    const { call, marker } = await connect();
    const started = await call("start_corner_setback_job", state.args);
    await state.entry;
    state.document.name = "Edit during cancelled preparation";
    expect(await call("get_document_state")).toMatchObject({ name: previousName });
    expect(await call("get_selection")).toEqual({ hasActiveDocument: true, selected: [] });
    const next = call("mutation");
    const cancelled = await call("cancel_corner_setback_job", { jobId: started.jobId });
    expect(["cancelling", "cancelled"]).toContain(cancelled.state);
    const terminalState = await terminal(call, started.jobId);
    expect(terminalState.state).toBe("cancelled");
    expect(terminalState.error).toBe("Cancelled by the caller");
    expect(await next).toEqual({ ran: true });
    expect(marker).toHaveBeenCalledTimes(1);
    expect(await call("get_document_state")).toMatchObject({ name: "Edit during cancelled preparation" });
});
test("session end and main-kernel recovery cancel the same corner manager", async () => {
    const state = setup();
    const first = await connect();
    await first.call("start_corner_setback_job", state.args);
    await state.entry;
    const options = hook.apply.mock.calls[0][3] as { signal: AbortSignal };
    await first.client.close();
    expect(options.signal.aborted).toBe(true);
    await tick();
    const second = setup();
    const connection = await connect();
    const started = await connection.call("start_corner_setback_job", second.args);
    await second.entry;
    cancelAllProgramJobs("Kernel recovery test");
    const cancelled = await terminal(connection.call, started.jobId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("Kernel recovery test");
});
test("a changed persistent selection fails before calling the shared apply API", async () => {
    const state = setup();
    const { call } = await connect();
    const started = await call("start_corner_setback_job", {
        ...state.args,
        expectedEdgeRefs: [{ ...edges[0], edgeId: "different" }, edges[1], edges[2]],
    });
    expect(await terminal(call, started.jobId)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("selection changed"),
    });
    expect(hook.apply).not.toHaveBeenCalled();
});
test("queued jobs retain caller/document binding and skip cancelled work before runtime creation", async () => {
    const state = setup();
    const execute = rs.fn<ProgramJobExecutor>(async (_input, _signal, _progress, document) =>
        JSON.stringify({ documentId: document.id }),
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
    const tools = buildCornerJobTools(jobs);
    const start = tools[0];
    const queued = JSON.parse((await start.handler(state.args, undefined, context)) as string);
    expect(() => jobs.read({ jobId: queued.jobId }, { caller: "other" })).toThrow("not found");
    expect(() => jobs.cancel({ jobId: queued.jobId }, { caller: "other" })).toThrow("not found");
    state.app.activeView = createMockView({ document: new TestDocument({ application: state.app }) });
    await tasks[0]();
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.read({ jobId: queued.jobId }, context)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("document changed"),
    });
});
test("a completed commit wins a simultaneous late abort and clears the cancellation error", async () => {
    setup();
    let jobs: ProgramJobs;
    let jobId: string;
    const execute: ProgramJobExecutor = async () => {
        jobs.cancel({ jobId }, { caller: "owner" });
        return JSON.stringify({ committed: true });
    };
    jobs = new ProgramJobs(execute);
    managers.push(jobs);
    let task!: () => Promise<void>;
    const context = {
        caller: "owner",
        scheduleMutation: (callback: () => Promise<void>) => {
            task = callback;
            return Promise.resolve();
        },
    };
    const started = jobs.start({ ops: [{}] }, context) as { jobId: string };
    jobId = started.jobId;
    await task();
    expect(jobs.read({ jobId }, context)).toMatchObject({
        state: "completed",
        result: { committed: true },
        error: undefined,
    });
});
test.each([
    [[1, 2]],
    [[1, 2, Number.NaN]],
    [[1, 2, 0]],
    [[1, 2, ""]],
])("invalid distances %s are rejected before queueing", (distances) => {
    expect(() => cornerJobRequest({ bodyId: "body", featureId: "feature", distances })).toThrow(
        "three positive finite",
    );
});

test("a queued corner cancellation skips runtime creation and completed jobs have bounded retention", async () => {
    const state = setup();
    let now = 0;
    const execute = rs.fn<ProgramJobExecutor>(async (_input, _signal, _progress, document) =>
        JSON.stringify({ documentId: document.id }),
    );
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
    const tools = buildCornerJobTools(jobs);
    const first = JSON.parse((await tools[0].handler(state.args, undefined, context)) as string);
    await tools[2].handler({ jobId: first.jobId }, undefined, context);
    await tasks[0]();
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.read({ jobId: first.jobId }, context)).toMatchObject({ state: "cancelled" });
    let latest = first;
    for (let i = 0; i < 20; i++) {
        latest = JSON.parse((await tools[0].handler(state.args, undefined, context)) as string);
        await tools[2].handler({ jobId: latest.jobId }, undefined, context);
    }
    expect(() => jobs.read({ jobId: first.jobId }, context)).toThrow("not found");
    expect(jobs.read({ jobId: latest.jobId }, context)).toMatchObject({ state: "cancelled" });
    now = 600_000;
    expect(() => jobs.read({ jobId: latest.jobId }, context)).toThrow("not found");
});
test("the executor receives its captured document even when current UI focus changes during preparation", async () => {
    const state = setup();
    const { call } = await connect();
    const started = await call("start_corner_setback_job", state.args);
    await state.entry;
    const second = new TestDocument({ application: state.app });
    state.app.activeView = createMockView({ document: second });
    state.settle();
    const completed = await terminal(call, started.jobId);
    expect(completed.state).toBe("completed");
    expect(completed.documentId).toBe(state.document.id);
    expect(completed.result.documentId).toBe(state.document.id);
    expect(hook.apply.mock.calls[0][0]).toBe(state.body);
});
test("a failed apply result does not overwrite user edits made during off-model preparation", async () => {
    const state = setup();
    const previousName = state.document.name;
    let finish!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const entry = new Promise<void>((resolve) => {
        entered = resolve;
    });
    hook.apply.mockImplementation(async () => {
        entered();
        await ready;
        return Result.err("Prepared corner became stale");
    });
    const { call } = await connect();
    const started = await call("start_corner_setback_job", state.args);
    await entry;
    state.document.name = "User edit while preparing";
    expect(await call("get_document_state")).toMatchObject({ name: previousName });
    finish();
    const failed = await terminal(call, started.jobId);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("Prepared corner became stale");
    expect(state.document.name).toBe("User edit while preparing");
    expect(await call("get_document_state")).toMatchObject({ name: "User edit while preparing" });
});

test("the published tool's real edit API refuses a host removed during preparation", async () => {
    const state = setup();
    const original = featureHandler("fillet");
    expect(original).not.toBeUndefined();
    if (!original) throw new Error("Missing fillet handler");
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    registerFeature("job-corner-input", {
        display: "body.parametricBody",
        nodeIds: () => [],
        parameters: () => [],
        setParameter: (feature) => feature,
        evaluate: () => Result.ok(new MockShape()),
    });
    registerFeature("fillet", {
        ...original,
        evaluate: () => Result.ok(new MockShape()),
        prepareAsync: () => {
            entered();
            return { ready, cancel: release, canFallback: false, take: () => Result.ok(new MockShape()) };
        },
    });
    try {
        state.body.setFeaturesEmitShapeChanged([
            { id: "input", type: "job-corner-input" } as unknown as FeatureData,
            ...state.body.features,
        ]);
        expect(state.body.shape.isOk).toBe(true);
        hook.apply.mockImplementation((...args: unknown[]) =>
            applyCornerSetbackEdit(...(args as Parameters<typeof applyCornerSetbackEdit>)),
        );
        const { call } = await connect();
        const started = await call("start_corner_setback_job", state.args);
        await entry;
        const parent = state.body.parent;
        expect(parent).not.toBeUndefined();
        if (!parent) throw new Error("Missing parent");
        parent.remove(state.body);
        const position = state.document.history.position();
        release();
        const failed = await terminal(call, started.jobId);
        expect(failed.state).toBe("failed");
        expect(failed.error).toMatch(/removed|document|missing|stale/);
        expect(state.document.modelManager.findNode((node) => node === state.body)).toBeUndefined();
        expect(state.document.history.position()).toBe(position);
        expect(DocumentMutations.isHeld(state.document)).toBe(false);
        expect(Transaction.isActive(state.document)).toBe(false);
    } finally {
        release();
        registerFeature("fillet", original);
    }
});
