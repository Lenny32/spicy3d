// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../src/llm/types";
import { createMcpServer, SerialQueue, toCallToolResult } from "../src/mcp/server";
import { SKILLS } from "../src/skills";
import { buildAskUserTool } from "../src/tools/askUser";

function tool(name: string, handler: Tool["handler"]): Tool {
    return { name, description: `${name} tool.`, parameters: { type: "object", properties: {} }, handler };
}

async function connect(tools: Tool[], capabilities: ConstructorParameters<typeof Client>[1] = {}) {
    const server = createMcpServer({ tools, instructions: "be careful" });
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
