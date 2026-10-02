// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import type { Tool } from "../src/llm/types";
import { createMcpServer, SerialQueue, toCallToolResult } from "../src/mcp/server";
import { SKILLS } from "../src/skills";
import { buildTools } from "../src/tools";
import { buildAskUserTool } from "../src/tools/askUser";
import { buildCloudTools } from "../src/tools/cloudTools";
import { buildExportChunkTool, retainExport } from "../src/tools/exportChunks";
import { imageByteBudget } from "../src/tools/imageEncoding";
import { noteOpDuration, takeSlowOpWarnings } from "../src/tools/opBudget";
import { buildReadTools } from "../src/tools/readTools";

function tool(name: string, handler: Tool["handler"]): Tool {
    return { name, description: `${name} tool.`, parameters: { type: "object", properties: {} }, handler };
}

async function connect(
    tools: Tool[],
    capabilities: ConstructorParameters<typeof Client>[1] = {},
    queue?: SerialQueue,
) {
    const server = createMcpServer({ tools, instructions: "be careful", queue });
    const client = new Client({ name: "test", version: "1" }, capabilities);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { server, client };
}

describe("toCallToolResult", () => {
    test("wraps a plain string as text", () => {
        expect(toCallToolResult('{"ok":true}')).toEqual({ content: [{ type: "text", text: '{"ok":true}' }] });
    });

    test("maps images to MCP image content", () => {
        const result = toCallToolResult({
            content: "shot",
            images: [{ mediaType: "image/png", data: "AAAA" }],
        });
        expect(result.content).toEqual([
            { type: "text", text: "shot" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
        ]);
    });

    test("flags the tools' {error} payload as isError", () => {
        expect(toCallToolResult('{"error":"no document"}').isError).toBe(true);
        expect(toCallToolResult('["error"]').isError).toBeUndefined();
        expect(toCallToolResult("not json").isError).toBeUndefined();
    });
});

describe("SerialQueue", () => {
    test("runs tasks one after another in arrival order", async () => {
        const queue = new SerialQueue();
        const log: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const first = queue.run(async () => {
            log.push("first:start");
            await gate;
            log.push("first:end");
        });
        const second = queue.run(async () => {
            log.push("second");
        });
        await Promise.resolve();
        expect(log).toEqual(["first:start"]);
        release();
        await Promise.all([first, second]);
        expect(log).toEqual(["first:start", "first:end", "second"]);
    });

    test("keeps going after a task fails", async () => {
        const queue = new SerialQueue();
        await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        await expect(queue.run(async () => 42)).resolves.toBe(42);
    });
});

describe("createMcpServer", () => {
    test("advertises the registry plus get_usage_guide, and passes the instructions", async () => {
        const { client } = await connect([tool("alpha", async () => "a")]);

        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name)).toEqual(["alpha", "get_usage_guide"]);
        expect(tools[0].inputSchema).toEqual({ type: "object", properties: {} });
        expect(client.getInstructions()).toBe("be careful");
    });

    test("every registry tool advertises an input schema without top-level combinators", async () => {
        const registry = [...buildTools(), ...buildCloudTools()];
        expect(registry.length).toBeGreaterThan(0);
        const { client } = await connect(registry);
        try {
            const { tools } = await client.listTools();
            // ask_user requires elicitation, so check its parameters directly as well.
            for (const tool of registry) {
                for (const keyword of ["oneOf", "anyOf", "allOf"]) {
                    expect(tool.parameters, `${tool.name}: ${keyword}`).not.toHaveProperty(keyword);
                }
            }
            expect(tools.map((tool) => tool.name)).toEqual([
                ...registry.filter((tool) => tool.name !== "ask_user").map((tool) => tool.name),
                "get_usage_guide",
            ]);
            for (const tool of tools) {
                for (const keyword of ["oneOf", "anyOf", "allOf"]) {
                    expect(tool.inputSchema, `${tool.name}: ${keyword}`).not.toHaveProperty(keyword);
                }
            }
            expect(tools.find((tool) => tool.name === "delete_node")!.inputSchema.required).toEqual([]);
            expect(tools.find((tool) => tool.name === "set_node_visible")!.inputSchema.required).toEqual([
                "visible",
            ]);
        } finally {
            await client.close();
        }
    });

    test("calls the handler with the arguments and returns its result", async () => {
        const handler = rs.fn(async (args: Record<string, unknown>) => JSON.stringify({ echoed: args["x"] }));
        const { client } = await connect([tool("echo", handler)]);

        const result = await client.callTool({ name: "echo", arguments: { x: 3 } });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(result.content).toEqual([{ type: "text", text: '{"echoed":3}' }]);
        expect(result.isError).toBeUndefined();
    });

    test("turns a thrown handler error into an isError result", async () => {
        const { client } = await connect([
            tool("broken", async () => {
                throw new Error("kernel exploded");
            }),
        ]);

        const result = await client.callTool({ name: "broken", arguments: {} });

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: '{"error":"kernel exploded"}' }]);
    });

    test("rejects an unknown tool as a protocol error", async () => {
        const { client } = await connect([]);

        await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow('unknown tool "nope"');
    });

    test("serializes concurrent calls", async () => {
        const log: string[] = [];
        const slow = tool("slow", async () => {
            log.push("slow:start");
            await new Promise((r) => setTimeout(r, 20));
            log.push("slow:end");
            return "s";
        });
        const fast = tool("fast", async () => {
            log.push("fast");
            return "f";
        });
        const { client } = await connect([slow, fast]);

        await Promise.all([
            client.callTool({ name: "slow", arguments: {} }),
            client.callTool({ name: "fast", arguments: {} }),
        ]);

        expect(log).toEqual(["slow:start", "slow:end", "fast"]);
    });

    test("hides ask_user from a client without elicitation", async () => {
        const { client } = await connect([buildAskUserTool()]);

        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name)).not.toContain("ask_user");
    });

    test("answers ask_user through elicitation when the client supports it", async () => {
        const { client } = await connect([buildAskUserTool()], {
            capabilities: { elicitation: { form: {} } },
        });
        const seen: unknown[] = [];
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            seen.push(request.params);
            return { action: "accept", content: { answer: "10 mm" } };
        });

        const result = await client.callTool({
            name: "ask_user",
            arguments: { question: "How big?", options: ["5 mm", "10 mm"] },
        });

        expect(result.content).toEqual([{ type: "text", text: "10 mm" }]);
        expect(seen).toEqual([
            expect.objectContaining({
                message: "How big?",
                requestedSchema: {
                    type: "object",
                    properties: { answer: { type: "string", title: "Answer", enum: ["5 mm", "10 mm"] } },
                    required: ["answer"],
                },
            }),
        ]);
    });

    test("serves the skills and the usage guide as resources", async () => {
        const { client } = await connect([]);

        const { resources } = await client.listResources();
        const skill = SKILLS[0];
        const read = await client.readResource({ uri: `spicy3d://skill/${skill.name}` });
        const guide = await client.readResource({ uri: "spicy3d://guide/usage" });

        expect(resources.map((r) => r.uri)).toContain("spicy3d://document");
        expect(resources.map((r) => r.uri)).toContain(`spicy3d://skill/${skill.name}`);
        expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown", text: skill.content });
        expect(guide.contents[0]).toMatchObject({ text: "be careful" });
        await expect(client.readResource({ uri: "spicy3d://nope" })).rejects.toThrow("unknown resource");
    });
});

describe("image budget per server", () => {
    async function budgetSeenBy(budget?: () => number | undefined) {
        let seen: number | undefined = -1;
        const probe = tool("probe", async () => {
            seen = imageByteBudget();
            return "{}";
        });
        const server = createMcpServer({ tools: [probe], instructions: "x", imageByteBudget: budget });
        const client = new Client({ name: "test", version: "1" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        await client.callTool({ name: "probe", arguments: {} });
        await client.close();
        return seen;
    }

    test("the relay's calls run under its budget, a server without one under none", async () => {
        expect(await budgetSeenBy(() => 5000)).toBe(5000);
        expect(await budgetSeenBy()).toBeUndefined();
        expect(imageByteBudget()).toBeUndefined();
    });
});

describe("slow-op warnings", () => {
    afterEach(() => {
        takeSlowOpWarnings();
        takeSlowOpWarnings();
    });

    test("the call that ran a slow op carries the warning, the next one repeats it once", async () => {
        const slow = tool("slow", async () => {
            noteOpDuration("makeThickSolidByJoin", 48_000);
            return '{"ok":true}';
        });
        const alpha = tool("alpha", async () => '{"a":1}');
        const { client } = await connect([slow, alpha]);

        const first = await client.callTool({ name: "slow", arguments: {} });
        const second = await client.callTool({ name: "alpha", arguments: {} });
        const third = await client.callTool({ name: "alpha", arguments: {} });

        const texts = (result: typeof first) => (result.content as { text: string }[]).map((c) => c.text);
        // The payload keeps its own part (still valid JSON); the warning is a separate line.
        expect(texts(first)[0]).toBe('{"ok":true}');
        expect(texts(first)[1]).toContain(
            'Warning: op "makeThickSolidByJoin" took 48 s (slow-op budget 30 s)',
        );
        expect(first.isError).toBeUndefined();
        expect(texts(second)[0]).toBe('{"a":1}');
        expect(texts(second)[1]).toMatch(/^\(earlier call\) Warning: op "makeThickSolidByJoin" took 48 s/);
        expect(texts(third)).toEqual(['{"a":1}']);
    });

    test("ops within the budget add nothing", async () => {
        const quick = tool("quick", async () => {
            noteOpDuration("box", 20_000);
            return "{}";
        });
        const { client } = await connect([quick]);

        const result = await client.callTool({ name: "quick", arguments: {} });

        expect((result.content as { text: string }[]).map((c) => c.text)).toEqual(["{}"]);
    });
});

test("metadata reads wait for a yielded mutation when no committed snapshot is held", async () => {
    const doc = createMockDocument({ name: "before" });
    const app = createMockApplication();
    app.activeView = { document: doc } as typeof app.activeView;
    rs.stubGlobal("app", app);
    let release!: () => void;
    let start!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        start = resolve;
    });
    const read = buildReadTools().find((entry) => entry.name === "get_document_state")!;
    const called = rs.spyOn(read, "handler");
    const queue = new SerialQueue();
    const queued = rs.spyOn(queue, "run");
    const mutation = tool("mutation", async () => {
        doc.name = "partial";
        start();
        await gate;
        doc.name = "committed";
        return "{}";
    });
    const { client } = await connect([mutation, read], {}, queue);
    const changing = client.callTool({ name: "mutation", arguments: {} });
    let reading: ReturnType<typeof client.callTool> | undefined;
    try {
        await started;
        reading = client.callTool({ name: "get_document_state", arguments: {} });
        // Prove the server received and queued the read before checking that it is held.
        await rs.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
        expect(called).not.toHaveBeenCalled();
        release();
        const result = await reading;
        expect(JSON.parse((result.content as { text: string }[])[0].text).name).toBe("committed");
        await changing;
    } finally {
        release();
        await changing;
        await reading;
        await client.close();
        called.mockRestore();
        queued.mockRestore();
        rs.unstubAllGlobals();
    }
});

test("server close forgets the connection's retained exports", async () => {
    let caller: string | undefined;
    const retain = tool("retain", async (_args, _signal, context) => {
        caller = context?.caller;
        return retainExport(
            new Blob(["abc"]),
            { filename: "test.step", mimeType: "model/step", bytes: 3 },
            3,
            caller,
        );
    });
    const { server, client } = await connect([retain, buildExportChunkTool()]);
    const reply = await client.callTool({ name: "retain", arguments: {} });
    const metadata = JSON.parse((reply.content as { text: string }[])[0].text);
    const before = await client.callTool({
        name: "read_export_chunk",
        arguments: { exportId: metadata.exportId },
    });
    expect(JSON.parse((before.content as { text: string }[])[0].text).data).toBe(btoa("abc"));
    await server.close();
    const connectionReader = buildExportChunkTool();
    const after = JSON.parse(
        (await connectionReader.handler({ exportId: metadata.exportId }, undefined, { caller })) as string,
    );
    expect(after.error).toContain("not found");
    await client.close();
});
