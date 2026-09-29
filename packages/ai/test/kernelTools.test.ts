// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rs } from "@rstest/core";
import { KernelState } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import type { Tool } from "../src/llm/types";
import { createMcpServer } from "../src/mcp/server";
import { buildTools } from "../src/tools";
import { buildCloudTools, OPEN_DOCUMENT_TOOL } from "../src/tools/cloudTools";
import { guardKernelTool, KERNEL_TOOLS } from "../src/tools/kernelTools";
import { buildReadTools, documentSnapshot } from "../src/tools/readTools";

const CRASHED = "Kernel crashed (Aborted(undefined)); reload the page";

function crash() {
    KernelState.current.markCrashed("Aborted(undefined)");
}

function withDocument<T>(run: () => Promise<T>): Promise<T> {
    const doc = createMockDocument({ name: "part" });
    (doc.modelManager as any).findNodes = rs.fn(() => [
        { id: "a", name: "box", constructor: { name: "BoxNode" } },
    ]);
    const app = createMockApplication();
    (app as any).activeView = { document: doc };
    rs.stubGlobal("app", app);
    return run().finally(() => rs.unstubAllGlobals());
}

async function stateOf(): Promise<Record<string, unknown>> {
    const tool = buildReadTools().find((t) => t.name === "get_document_state")!;
    return JSON.parse((await tool.handler({})) as string);
}

afterEach(() => KernelState.current.reset());

describe("kernel tools after a crash", () => {
    test("a kernel tool answers the crash without starting work", async () => {
        const handler = rs.fn(async (_args: Record<string, unknown>) => '{"ok":true}');
        const tool = guardKernelTool({ name: "run_program", description: "", parameters: {}, handler });
        expect(await tool.handler({})).toBe('{"ok":true}');

        crash();
        expect(JSON.parse((await tool.handler({ program: [] })) as string)).toEqual({ error: CRASHED });
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test("other tools are left as they are", () => {
        const tool: Tool = { name: "get_selection", description: "", parameters: {}, handler: rs.fn() };
        expect(guardKernelTool(tool)).toBe(tool);
    });

    test.each([
        "run_program",
        "run_parametric",
        "set_node_properties",
        "undo",
        "export_nodes",
    ])("the registry's %s refuses once the kernel crashed", async (name) => {
        const tool = buildTools().find((t) => t.name === name);
        expect(tool?.name).toBe(name);
        crash();
        expect(JSON.parse((await tool!.handler({})) as string)).toEqual({ error: CRASHED });
    });

    test("every guarded name is a real tool", () => {
        const names = new Set([...buildTools(), ...buildCloudTools()].map((t) => t.name));
        expect([...KERNEL_TOOLS].filter((name) => !names.has(name))).toEqual([]);
    });

    test("opening a cloud document refuses too", async () => {
        const open = buildCloudTools().find((t) => t.name === OPEN_DOCUMENT_TOOL)!;
        crash();
        expect(JSON.parse((await open.handler({ id: "d1" })) as string)).toEqual({ error: CRASHED });
    });

    test("an MCP call reports the crash as an error result", async () => {
        const run = buildTools().find((t) => t.name === "run_program")!;
        const server = createMcpServer({ tools: [run], cloudTools: [], instructions: "x" });
        const client = new Client({ name: "test", version: "1" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        try {
            crash();
            const result = await client.callTool({ name: "run_program", arguments: { program: [] } });
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: CRASHED }) }]);
        } finally {
            await client.close();
        }
    });
});

describe("document state reports the kernel", () => {
    test("nothing while the kernel works", async () => {
        await withDocument(async () => {
            const state = await stateOf();
            expect(state["hasActiveDocument"]).toBe(true);
            expect(state).not.toHaveProperty("kernel");
        });
    });

    test('kernel: "crashed" with the error once it crashed', async () => {
        await withDocument(async () => {
            crash();
            const state = await stateOf();
            expect(state["nodeCount"]).toBe(1);
            expect(state["kernel"]).toBe("crashed");
            expect(state["kernelError"]).toBe(CRASHED);
            expect(JSON.parse(documentSnapshot())["kernel"]).toBe("crashed");
        });
    });

    test("also without an active document", async () => {
        const app = createMockApplication();
        app.activeView = undefined;
        rs.stubGlobal("app", app);
        try {
            crash();
            expect(await stateOf()).toEqual({
                hasActiveDocument: false,
                kernel: "crashed",
                kernelError: CRASHED,
            });
        } finally {
            rs.unstubAllGlobals();
        }
    });
});
