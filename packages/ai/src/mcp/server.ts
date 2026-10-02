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
import { ErrorLog, I18n } from "@spicy3d/core";
import { buildMcpInstructions } from "../llm/prompt";
import type { Tool, ToolResult } from "../llm/types";
import { buildSkillTool, MCP_SKILLS } from "../skills";
import { buildTools } from "../tools";
import { parseAskRequest } from "../tools/askUser";
import { agentCloudLink, onAgentCloudChanged } from "../tools/cloudLink";
import { buildCloudTools, documentStorageInfo, forgetCloudCaller } from "../tools/cloudTools";
import { forgetExports } from "../tools/exportChunks";
import { withImageByteBudget } from "../tools/imageEncoding";
import { takeSlowOpWarnings } from "../tools/opBudget";
import { forgetProgramJobs, isProgramJobTool } from "../tools/programJobs";
import { documentSnapshot, hasDocumentReadSnapshot, isMetadataReadTool } from "../tools/readTools";
import { isScreenshotTool } from "../tools/viewTools";

export const MCP_SERVER_NAME = "spicy3d";

/** The relay names the MCP session of every request in `_meta` (pageTransport.ts `RELAY`). */
const AGENT_META_KEY = "spicy3d/agent";

let connections = 0;

const DOCUMENT_URI = "spicy3d://document";
const GUIDE_URI = "spicy3d://guide/usage";
const SKILL_URI_PREFIX = "spicy3d://skill/";

export interface McpServerOptions {
    /** Defaults to the in-app assistant's registry, so both front ends expose the same tools. */
    tools?: Tool[];
    /**
     * Listed only while the cloud module lends its link (signed in); defaults to
     * `buildCloudTools()`. They follow the other tools, which the in-app assistant shares.
     */
    cloudTools?: Tool[];
    /** Defaults to `buildMcpInstructions()`. */
    instructions?: string;
    /** Reported once per finished call, for the status badge. */
    onToolCall?: (name: string, isError: boolean) => void;
    /** Defaults to one queue shared by every server of this page (reconnects included). */
    queue?: SerialQueue;
    /** The largest base64 image a call's result may carry (the relay's message limit); none by default. */
    imageByteBudget?: () => number | undefined;
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

/** The page's tool calls run one at a time, whichever connection they come from. */
const PAGE_QUEUE = new SerialQueue();

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
 * Appends the slow-op warnings (opBudget.ts `takeSlowOpWarnings`: the call that ran the slow op,
 * and once more the next call, whose answer is the first to arrive when the relay gave up waiting)
 * as a separate text part, so the payload's JSON stays intact.
 */
export function withSlowOpWarnings(result: CallToolResult): CallToolResult {
    const warnings = takeSlowOpWarnings();
    if (warnings.length) result.content.push({ type: "text", text: warnings.join("\n") });
    return result;
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

/** The document snapshot plus where the document is stored and how far it is saved (`document`). */
export function documentResource(): string {
    const snapshot = JSON.parse(documentSnapshot()) as Record<string, unknown>;
    const storage = documentStorageInfo();
    return JSON.stringify(storage ? { ...snapshot, document: storage } : snapshot);
}

function readResource(uri: string, instructions: string): { mimeType: string; text: string } {
    if (uri === DOCUMENT_URI) return { mimeType: "application/json", text: documentResource() };
    if (uri === GUIDE_URI) return { mimeType: "text/markdown", text: instructions };
    const skill = uri.startsWith(SKILL_URI_PREFIX)
        ? MCP_SKILLS.find((s) => s.name === uri.slice(SKILL_URI_PREFIX.length))
        : undefined;
    if (skill) return { mimeType: "text/markdown", text: skill.content };
    throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uri}`);
}

/**
 * An MCP server over the same tool registry the in-app assistant uses. It is transport-agnostic:
 * `remoteSession.ts` connects it to the server's relay over a WebSocket, tests use an in-memory pair.
 */
export function createMcpServer(options: McpServerOptions = {}): Server {
    const instructions = options.instructions ?? buildMcpInstructions();
    // The in-app registry's load_skill knows the in-app skills; MCP clients also get theirs.
    const registry =
        options.tools ?? buildTools().map((t) => (t.name === "load_skill" ? buildSkillTool(MCP_SKILLS) : t));
    const baseTools = [...registry, usageGuideTool(instructions)];
    const cloudTools = options.cloudTools ?? buildCloudTools();
    const queue = options.queue ?? PAGE_QUEUE;
    const server = new Server(
        { name: MCP_SERVER_NAME, version: __APP_VERSION__ },
        {
            // listChanged: sent when signing in or out adds or removes the cloud tools.
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, logging: {} },
            instructions,
        },
    );

    /** ask_user only exists when the client can show a question; otherwise the model must not wait on it. */
    const currentTools = (): Tool[] => {
        const canAsk = server.getClientCapabilities()?.elicitation !== undefined;
        const tools = baseTools.flatMap((t) => {
            if (t.name !== "ask_user") return [t];
            return canAsk ? [elicitingAskUser(t, server)] : [];
        });
        return agentCloudLink() ? [...tools, ...cloudTools] : tools;
    };

    // The relay names each request's session; a request without one (tests, an in-memory pair)
    // belongs to the connection.
    const connectionCaller = `connection-${++connections}`;
    const callers = new Set<string>();
    const callerOf = (meta: Record<string, unknown> | undefined): string => {
        const agent = meta?.[AGENT_META_KEY] as { id?: unknown } | undefined;
        return typeof agent?.id === "string" ? agent.id : connectionCaller;
    };

    // Signing in or out adds or removes the cloud tools: the client is told to list them again.
    // Watched only while connected: a server whose connect failed (the relay not reachable yet,
    // retried with backoff) must not leave a listener behind.
    let stopWatching: (() => void) | undefined;
    let stopErrorLog: (() => void) | undefined;
    const connect = server.connect.bind(server);
    server.connect = async (transport) => {
        await connect(transport);
        stopWatching ??= onAgentCloudChanged(() => void server.sendToolListChanged().catch(() => undefined));
        // Every error of the session's list also reaches the agent as a logging message.
        stopErrorLog ??= ErrorLog.subscribe((entry) => {
            if (!entry) return;
            void server
                .sendLoggingMessage({
                    level: "error",
                    logger: "spicy3d.errors",
                    data: {
                        id: entry.id,
                        source: entry.source,
                        message: entry.message,
                        details: entry.details,
                    },
                })
                .catch(() => undefined);
        });
        const closed = transport.onclose;
        transport.onclose = () => {
            stopWatching?.();
            stopWatching = undefined;
            stopErrorLog?.();
            stopErrorLog = undefined;
            // The sessions of this connection are gone: their open questions close.
            for (const caller of callers) {
                forgetCloudCaller(caller);
                forgetProgramJobs(caller);
                forgetExports(caller);
            }
            callers.clear();
            closed?.();
        };
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
        const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
        callers.add(caller);
        const invoke = async () => {
            if (extra.signal.aborted) throw new McpError(ErrorCode.RequestTimeout, "cancelled");
            let result: CallToolResult;
            try {
                const budget = options.imageByteBudget?.();
                result = toCallToolResult(
                    await withImageByteBudget(budget, () =>
                        tool.handler(args ?? {}, extra.signal, {
                            caller,
                            ...(isProgramJobTool(tool) && {
                                scheduleMutation: (task: () => Promise<void>) => queue.run(task),
                            }),
                        }),
                    ),
                );
            } catch (err) {
                result = toCallToolResult(JSON.stringify({ error: (err as Error).message }));
            }
            options.onToolCall?.(name, result.isError === true);
            // A cancelled call's answer is never sent: its warnings wait for the next result.
            if (!extra.signal.aborted) withSlowOpWarnings(result);
            return result;
        };
        // Built-in metadata and screenshots can read while a program yields; mutations stay FIFO.
        return ((isMetadataReadTool(tool) || isScreenshotTool(tool)) && hasDocumentReadSnapshot()) ||
            isProgramJobTool(tool)
            ? invoke()
            : queue.run(invoke);
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
            ...MCP_SKILLS.map((s) => ({
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
