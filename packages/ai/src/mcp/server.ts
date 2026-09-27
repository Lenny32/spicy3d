// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ErrorCode,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { I18n } from "@spicy3d/core";
import { buildMcpInstructions } from "../llm/prompt";
import type { Tool, ToolResult } from "../llm/types";
import { SKILLS } from "../skills";
import { buildTools } from "../tools";
import { parseAskRequest } from "../tools/askUser";
import { documentSnapshot } from "../tools/readTools";

export const MCP_SERVER_NAME = "spicy3d";

const DOCUMENT_URI = "spicy3d://document";
const GUIDE_URI = "spicy3d://guide/usage";
const SKILL_URI_PREFIX = "spicy3d://skill/";

export interface McpServerOptions {
    /** Defaults to the in-app assistant's registry, so both front ends expose the same tools. */
    tools?: Tool[];
    /** Defaults to `buildMcpInstructions()`. */
    instructions?: string;
    /** Reported once per finished call, for the status badge. */
    onToolCall?: (name: string, isError: boolean) => void;
}

/**
 * Runs tasks one at a time, in arrival order. `run_program` refs chain across calls (a fillet
 * references the box an earlier call created), and MCP clients are free to issue calls in
 * parallel — agent.ts gets the same guarantee by awaiting each call in turn.
 */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const next = this.tail.then(task);
        this.tail = next.catch(() => undefined);
        return next;
    }
}

/**
 * The tools' error convention (`{"error": …}` as the whole payload, see agent.ts `invokeTool`)
 * mapped onto MCP's `isError`, so the client can tell a failed call from a successful one.
 */
function isErrorPayload(text: string): boolean {
    try {
        const value = JSON.parse(text);
        return typeof value === "object" && value !== null && !Array.isArray(value) && "error" in value;
    } catch {
        return false;
    }
}

export function toCallToolResult(result: string | ToolResult): CallToolResult {
    const { content, images } = typeof result === "string" ? { content: result, images: undefined } : result;
    return {
        content: [
            { type: "text", text: content },
            ...(images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType })),
        ],
        ...(isErrorPayload(content) && { isError: true }),
    };
}

/**
 * ask_user answered through MCP elicitation: the client shows the question in its own UI instead
 * of the chat panel, which may not even be open.
 */
function elicitingAskUser(tool: Tool, server: Server): Tool {
    return {
        ...tool,
        handler: async (args, signal) => {
            const request = parseAskRequest(args);
            const answer = request.options?.length
                ? { type: "string" as const, title: "Answer", enum: request.options }
                : { type: "string" as const, title: "Answer" };
            const result = await server.elicitInput(
                {
                    message: request.question,
                    requestedSchema: { type: "object", properties: { answer }, required: ["answer"] },
                },
                { signal },
            );
            if (result.action !== "accept") return I18n.translate("ai.ask.notAnswered");
            return String(result.content?.["answer"] ?? "");
        },
    };
}

function usageGuideTool(instructions: string): Tool {
    return {
        name: "get_usage_guide",
        description:
            "Read how to use this server's tools: ordering rules, units, how to verify a change. Call it once before the first modeling call if the server instructions were not shown to you.",
        parameters: { type: "object", properties: {} },
        handler: async () => instructions,
    };
}

function readResource(uri: string, instructions: string): { mimeType: string; text: string } {
    if (uri === DOCUMENT_URI) return { mimeType: "application/json", text: documentSnapshot() };
    if (uri === GUIDE_URI) return { mimeType: "text/markdown", text: instructions };
    const skill = uri.startsWith(SKILL_URI_PREFIX)
        ? SKILLS.find((s) => s.name === uri.slice(SKILL_URI_PREFIX.length))
        : undefined;
    if (skill) return { mimeType: "text/markdown", text: skill.content };
    throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uri}`);
}

/**
 * An MCP server over the same tool registry the in-app assistant uses. It is transport-agnostic:
 * `session.ts` connects it to the local bridge over a WebSocket, tests use an in-memory pair.
 */
export function createMcpServer(options: McpServerOptions = {}): Server {
    const instructions = options.instructions ?? buildMcpInstructions();
    const baseTools = [...(options.tools ?? buildTools()), usageGuideTool(instructions)];
    const queue = new SerialQueue();
    const server = new Server(
        { name: MCP_SERVER_NAME, version: __APP_VERSION__ },
        {
            // listChanged: the bridge announces a changed list whenever a tab connects or leaves.
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
            instructions,
        },
    );

    /** ask_user only exists when the client can show a question; otherwise the model must not wait on it. */
    const currentTools = (): Tool[] => {
        const canAsk = server.getClientCapabilities()?.elicitation !== undefined;
        return baseTools.flatMap((t) => {
            if (t.name !== "ask_user") return [t];
            return canAsk ? [elicitingAskUser(t, server)] : [];
        });
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: currentTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters as { type: "object" },
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
        const { name, arguments: args } = request.params;
        const tool = currentTools().find((t) => t.name === name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool "${name}"`);
        return queue.run(async () => {
            if (extra.signal.aborted) throw new McpError(ErrorCode.RequestTimeout, "cancelled");
            let result: CallToolResult;
            try {
                result = toCallToolResult(await tool.handler(args ?? {}, extra.signal));
            } catch (err) {
                result = toCallToolResult(JSON.stringify({ error: (err as Error).message }));
            }
            options.onToolCall?.(name, result.isError === true);
            return result;
        });
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            {
                uri: DOCUMENT_URI,
                name: "Current document",
                description: "Snapshot of the open document: its nodes and the current selection.",
                mimeType: "application/json",
            },
            {
                uri: GUIDE_URI,
                name: "Usage guide",
                description: "How to use this server's tools (same text as the server instructions).",
                mimeType: "text/markdown",
            },
            ...SKILLS.map((s) => ({
                uri: `${SKILL_URI_PREFIX}${s.name}`,
                name: s.name,
                description: s.description,
                mimeType: "text/markdown",
            })),
        ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        return { contents: [{ uri, ...readResource(uri, instructions) }] };
    });

    return server;
}
