// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { rs } from "@rstest/core";
import {
    type DocumentListQuery,
    type DocumentPage,
    type DocumentRepositoryError,
    type IApplication,
    type IDocument,
    type IDocumentRepository,
    type IView,
    Logger,
    Result,
    type SaveConflict,
    type StoredDocumentInfo,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildMcpInstructions } from "../src/llm/prompt";
import type { Tool } from "../src/llm/types";
import { createMcpServer, SerialQueue } from "../src/mcp/server";
import { MCP_SKILLS, SKILLS } from "../src/skills";
import {
    type AgentCloudInfo,
    type AgentSaveOutcome,
    agentCloudLink,
    agentCloudListenerCount,
    type IAgentCloudLink,
    setAgentCloudLink,
} from "../src/tools/cloudLink";
import {
    buildCloudTools,
    CLOUD_TOOL_NAMES,
    forgetCloudCaller,
    LABEL_MAX_LENGTH,
} from "../src/tools/cloudTools";
import { type AskOpen, type OpenChoice, OpenConsent } from "../src/tools/openConsent";

/** The SpicySrv tools the relay answers itself (McpHandlers.ServerTools): never a tab tool's name. */
const SERVER_TOOLS = [
    "spicy3d_connect",
    "spicy3d_list_tabs",
    "spicy3d_select_tab",
    "spicy3d_list_documents",
    "spicy3d_document_history",
];

type Doc = IDocument & { isDirty: boolean };

function cloudRepository(stored: Record<string, StoredDocumentInfo> = {}) {
    return {
        kind: "cloud",
        stat: rs.fn(async (id: string) => Result.ok<StoredDocumentInfo | undefined>(stored[id])),
        list: rs.fn(async (_query?: DocumentListQuery) =>
            Result.ok<DocumentPage>({
                items: [
                    {
                        id: "doc-2",
                        name: "Bracket",
                        updatedAt: Date.UTC(2026, 8, 27, 13, 35, 49),
                        location: "cloud",
                        headVersion: "v7",
                        sizeBytes: 1234,
                        syncState: "synced",
                    },
                ],
                nextCursor: "c2",
            }),
        ),
        isReadOnly: () => false,
    } as unknown as IDocumentRepository & {
        stat: ReturnType<typeof rs.fn<(id: string) => Promise<Result<StoredDocumentInfo | undefined>>>>;
    };
}

function doc(app: IApplication, id: string, repository: IDocumentRepository, dirty = false): Doc {
    const document = createMockDocument({ id, name: `Doc ${id}` }) as Doc;
    (document as { application: IApplication }).application = app;
    document.repository = repository;
    Object.defineProperty(document, "isDirty", { value: dirty, writable: true });
    document.save = rs.fn(async () => Result.ok({ status: "saved" as const, updatedAt: 1 }));
    return document;
}

function show(app: IApplication, document: IDocument | undefined) {
    app.activeView = document
        ? ({ document, cameraController: { fitContent: () => {} } } as unknown as IView)
        : undefined;
}

class FakeLink implements IAgentCloudLink {
    readonly opened: string[] = [];
    readonly saves: { document: IDocument; label?: string }[] = [];
    saveOutcome: AgentSaveOutcome = { status: "saved", version: "v2" };
    openError?: DocumentRepositoryError;
    info: AgentCloudInfo | undefined = { syncState: "clean", readOnly: false };

    constructor(
        private readonly app: IApplication,
        private readonly repository: IDocumentRepository,
    ) {}

    async open(id: string) {
        this.opened.push(id);
        if (this.openError) return Result.err(this.openError);
        const document = doc(this.app, id, this.repository);
        show(this.app, document);
        return Result.ok<IDocument>(document);
    }

    async openVersion(id: string, versionId: string) {
        this.opened.push(`${id}@${versionId}`);
        const document = doc(this.app, "preview-1", this.repository);
        show(this.app, document);
        return Result.ok<IDocument>(document);
    }

    async save(document: IDocument, label?: string) {
        this.saves.push({ document, label });
        return this.saveOutcome;
    }

    describe(document: IDocument): AgentCloudInfo | undefined {
        if (document.id === "preview-1") {
            return { readOnly: true, preview: { documentId: "doc-2", versionId: "v1" } };
        }
        return document.repository === this.repository ? this.info : undefined;
    }
}

/** An open prompt the test answers by hand. */
function manualAsk() {
    const asked: { current: string; target: string }[] = [];
    const answers: ((choice: OpenChoice) => void)[] = [];
    const ask: AskOpen = (question, signal) => {
        asked.push(question);
        return new Promise((resolve) => {
            answers.push(resolve);
            signal.addEventListener("abort", () => resolve("cancel"));
        });
    };
    return {
        ask,
        asked,
        answer: async (choice: OpenChoice, index = 0) => {
            for (let i = 0; i < 50 && !answers[index]; i++) await new Promise((r) => setTimeout(r, 0));
            answers[index](choice);
        },
    };
}

function setup(options: { waitMs?: number; stored?: Record<string, StoredDocumentInfo> } = {}) {
    const app = createMockApplication();
    const cloud = cloudRepository(options.stored ?? { "doc-2": { name: "Bracket" } });
    app.repositories.cloud = cloud;
    const link = new FakeLink(app, cloud);
    setAgentCloudLink(link);
    rs.stubGlobal("app", app);
    const prompt = manualAsk();
    const consent = new OpenConsent({ ask: prompt.ask });
    const tools = buildCloudTools({ consent, waitMs: options.waitMs ?? 1000 });
    const run = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
        JSON.parse((await tools.find((t) => t.name === name)!.handler(args, signal)) as string);
    return { app, cloud, link, prompt, consent, tools, run };
}

afterEach(() => {
    setAgentCloudLink(undefined);
    rs.unstubAllGlobals();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

describe("cloud tool names", () => {
    test("are the ticket's, and never one the server answers itself", () => {
        expect([...CLOUD_TOOL_NAMES]).toEqual([
            "spicy3d_open_document",
            "spicy3d_list_cloud_documents",
            "spicy3d_new_document",
            "spicy3d_save",
        ]);
        for (const name of CLOUD_TOOL_NAMES) expect(SERVER_TOOLS).not.toContain(name);
    });
});

describe("spicy3d_open_document", () => {
    test("opens the latest version through the link and makes it the active document", async () => {
        const { run, link, app, prompt } = setup();

        const result = await run("spicy3d_open_document", { id: "doc-2" });

        expect(link.opened).toEqual(["doc-2"]);
        expect(result).toMatchObject({
            opened: true,
            document: { id: "doc-2", location: "cloud", syncState: "clean" },
        });
        expect(app.activeView?.document.id).toBe("doc-2");
        expect(prompt.asked).toEqual([]);
    });

    test("the active document is just reported, not reopened", async () => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "doc-2", cloud));

        const result = await run("spicy3d_open_document", { id: "doc-2" });

        expect(result).toMatchObject({ opened: true, alreadyActive: true });
        expect(link.opened).toEqual([]);
    });

    test("an unknown id or a trashed document is an error, and the user is not bothered", async () => {
        const { run, link, app, prompt } = setup({ stored: { gone: { name: "Old", trashed: true } } });
        show(app, doc(app, "mine", app.repositories.local, true));

        const unknown = await run("spicy3d_open_document", { id: "nope" });
        const trashed = await run("spicy3d_open_document", { id: "gone" });
        const missing = await run("spicy3d_open_document", {});

        expect(unknown.error).toContain('No cloud document with id "nope"');
        expect(trashed.error).toContain("in the trash");
        expect(missing.error).toContain("id is required");
        expect(link.opened).toEqual([]);
        expect(prompt.asked).toEqual([]);
    });

    test("with unsaved changes the call blocks until the user answers; Save and open saves first", async () => {
        const { run, link, app, prompt } = setup();
        const mine = doc(app, "mine", app.repositories.local, true);
        show(app, mine);

        const pending = run("spicy3d_open_document", { id: "doc-2" });
        await prompt.answer("save");
        const result = await pending;

        expect(prompt.asked).toEqual([{ current: "Doc mine", target: "Bracket" }]);
        expect(mine.save).toHaveBeenCalledWith("manual");
        expect(link.opened).toEqual(["doc-2"]);
        expect(result.opened).toBe(true);
    });

    test("Open, keep unsaved opens without saving; Cancel is a declined open", async () => {
        const { run, link, app, prompt } = setup();
        const mine = doc(app, "mine", app.repositories.local, true);
        show(app, mine);

        const declined = run("spicy3d_open_document", { id: "doc-2" });
        await prompt.answer("cancel");
        expect((await declined).error).toMatch(/^Declined: the user chose not to open "Bracket"/);
        expect(link.opened).toEqual([]);

        show(app, mine);
        const kept = run("spicy3d_open_document", { id: "doc-2" });
        await prompt.answer("keep", 1);
        expect((await kept).opened).toBe(true);
        expect(mine.save).not.toHaveBeenCalled();
        expect(link.opened).toEqual(["doc-2"]);
    });

    test("no answer in time: waitingForUser, and the retry waits for the same question", async () => {
        const { run, link, app, prompt } = setup({ waitMs: 20 });
        show(app, doc(app, "mine", app.repositories.local, true));

        const first = await run("spicy3d_open_document", { id: "doc-2" });
        expect(first).toMatchObject({ opened: false, status: "waitingForUser" });
        expect(link.opened).toEqual([]);

        const retry = run("spicy3d_open_document", { id: "doc-2" });
        await prompt.answer("keep");
        expect((await retry).opened).toBe(true);
        expect(prompt.asked).toHaveLength(1);
    });

    test("an answer given after the call stopped waiting is kept for its retry", async () => {
        const { run, link, app, prompt } = setup({ waitMs: 10 });
        show(app, doc(app, "mine", app.repositories.local, true));

        expect((await run("spicy3d_open_document", { id: "doc-2" })).status).toBe("waitingForUser");
        await prompt.answer("cancel");
        await new Promise((r) => setTimeout(r, 0));

        const retry = await run("spicy3d_open_document", { id: "doc-2" });
        expect(retry.error).toMatch(/^Declined/);
        expect(prompt.asked).toHaveLength(1);
        expect(link.opened).toEqual([]);
    });

    test("a failed Save and open does not open", async () => {
        const { run, link, app, prompt } = setup();
        const mine = doc(app, "mine", app.repositories.local, true);
        mine.save = rs.fn(async () => Result.err<DocumentRepositoryError>({ kind: "quota" }));
        show(app, mine);

        const warn = rs.spyOn(Logger, "warn").mockImplementation(() => {});
        try {
            const pending = run("spicy3d_open_document", { id: "doc-2" });
            await prompt.answer("save");

            expect((await pending).error).toContain("that save did not go through");
            expect(link.opened).toEqual([]);
            // The log names the document by id, never by its name (CLOUD-17).
            const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
            expect(logged).toContain("saving mine before opening failed: quota");
            expect(logged).not.toContain("Doc mine");
        } finally {
            warn.mockRestore();
        }
    });

    test("a version opens read-only through the history preview", async () => {
        const { run, link } = setup();

        const result = await run("spicy3d_open_document", { id: "doc-2", version: "v1" });

        expect(link.opened).toEqual(["doc-2@v1"]);
        expect(result).toMatchObject({
            opened: true,
            readOnly: true,
            document: {
                location: "cloud",
                readOnly: true,
                preview: { documentId: "doc-2", versionId: "v1" },
            },
        });
        expect(result.note).toContain("never saved");
    });
});

describe("spicy3d_new_document", () => {
    test("creates the document in the cloud, whatever the new-document location setting says", async () => {
        const { run, app, cloud } = setup();
        app.repositories.preferred = "local";
        const created = doc(app, "new-1", cloud);
        const newDocument = rs.fn(async (_name: string, _repository?: IDocumentRepository) => created);
        app.newDocument = newDocument;

        const result = await run("spicy3d_new_document", { name: "  Gearbox  " });

        expect(newDocument).toHaveBeenCalledWith("Gearbox", cloud);
        expect(result).toMatchObject({ created: true, document: { id: "new-1", location: "cloud" } });
        expect((await run("spicy3d_new_document", { name: " " })).error).toBe("name is required");
    });
});

describe("spicy3d_save", () => {
    test("saves the active cloud document through the link, with the label", async () => {
        const { run, link, app, cloud } = setup();
        const document = doc(app, "doc-2", cloud, true);
        show(app, document);

        const result = await run("spicy3d_save", { label: " Agent: fillet " });

        expect(link.saves).toEqual([{ document, label: "Agent: fillet" }]);
        expect(result).toMatchObject({ saved: true, uploaded: true, version: "v2", label: "Agent: fillet" });
    });

    test.each([
        [{ label: "x".repeat(LABEL_MAX_LENGTH + 1) }, "at most 200 characters"],
        [{ label: "a\nb" }, "control characters"],
        [{ label: 3 }, "label must be a string"],
    ])("refuses the label %j", async (args, message) => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "doc-2", cloud, true));

        expect((await run("spicy3d_save", args)).error).toContain(message);
        expect(link.saves).toEqual([]);
    });

    test("offline: saved in the browser, uploaded later", async () => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "doc-2", cloud, true));
        link.saveOutcome = { status: "pending", reason: "offline" };

        expect(await run("spicy3d_save")).toMatchObject({ saved: true, uploaded: false });
    });

    test("a conflict is handed to the conflict UI; the agent gets 'conflict pending user resolution'", async () => {
        const { run, link, app, cloud } = setup();
        const document = doc(app, "doc-2", cloud, true);
        show(app, document);
        const conflict: SaveConflict = { status: "conflict", headVersion: "v9", headDeviceName: "Tablet" };
        link.saveOutcome = { status: "conflict", conflict };
        const handler = rs.fn(async (_document: IDocument, _conflict: SaveConflict) => {});
        app.repositories.conflictHandler = handler;

        const result = await run("spicy3d_save", { label: "try" });

        expect(result.error).toMatch(/^Conflict pending user resolution/);
        expect(result.error).toContain("do not try to resolve it");
        expect(handler.mock.calls).toEqual([[document, conflict]]);
    });

    test("a preview is refused without saving; a local document saves locally, without a history", async () => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "preview-1", cloud, true));
        expect((await run("spicy3d_save")).error).toContain("read-only preview");

        const local = doc(app, "loc", app.repositories.local, true);
        show(app, local);
        const result = await run("spicy3d_save", { label: "ignored" });

        expect(local.save).toHaveBeenCalledWith("mcp");
        expect(result).toMatchObject({ saved: true, location: "local" });
        expect(link.saves).toEqual([]);
    });

    test("a failed save is an error in the agent's words", async () => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "doc-2", cloud, true));
        link.saveOutcome = { status: "failed", error: { kind: "readOnly" } };

        expect((await run("spicy3d_save")).error).toContain("Another tab of this browser is editing");
    });
});

describe("the MCP server with the cloud tools", () => {
    function tool(name: string, handler: Tool["handler"]): Tool {
        return { name, description: name, parameters: { type: "object", properties: {} }, handler };
    }

    async function connect(tools: Tool[], cloudTools: Tool[]) {
        const server = createMcpServer({ tools, cloudTools, instructions: "x", queue: new SerialQueue() });
        const client = new Client({ name: "test", version: "1" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        return { server, client };
    }

    test("hidden while not signed in; signing in lists them and tells the client the list changed", async () => {
        const { app, cloud } = setup();
        setAgentCloudLink(undefined);
        const { client } = await connect([tool("alpha", async () => "a")], buildCloudTools());
        const changed = rs.fn(() => {});
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => changed());

        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["alpha", "get_usage_guide"]);

        setAgentCloudLink(new FakeLink(app, cloud));
        await rs.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
            "alpha",
            "get_usage_guide",
            ...CLOUD_TOOL_NAMES,
        ]);

        setAgentCloudLink(undefined);
        await rs.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["alpha", "get_usage_guide"]);
    });

    test("a call waiting for the user holds the calls behind it (one queue, arrival order)", async () => {
        const { app, prompt, consent } = setup();
        show(app, doc(app, "mine", app.repositories.local, true));
        const log: string[] = [];
        const edit = tool("run_program", async () => {
            log.push("run_program");
            return "{}";
        });
        // Logged when the handler returns, inside the queue.
        const cloudTools = buildCloudTools({ consent, waitMs: 5000 }).map((t) => ({
            ...t,
            handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
                const result = await t.handler(args, signal);
                log.push(t.name);
                return result;
            },
        }));
        const { client } = await connect([edit], cloudTools);

        const open = client.callTool({ name: "spicy3d_open_document", arguments: { id: "doc-2" } });
        const next = client.callTool({ name: "run_program", arguments: {} });
        await rs.waitFor(() => expect(prompt.asked).toHaveLength(1));
        expect(log).toEqual([]);

        await prompt.answer("keep");
        await Promise.all([open, next]);

        expect(log).toEqual(["spicy3d_open_document", "run_program"]);
    });

    test("the document resource carries the cloud metadata", async () => {
        const { app, cloud } = setup();
        const document = doc(app, "doc-2", cloud, true);
        document.version = "v5";
        show(app, document);
        const { client } = await connect([], buildCloudTools());

        const read = await client.readResource({ uri: "spicy3d://document" });
        const snapshot = JSON.parse((read.contents[0] as { text: string }).text);

        expect(snapshot).toMatchObject({
            hasActiveDocument: true,
            document: {
                id: "doc-2",
                location: "cloud",
                headVersion: "v5",
                dirty: true,
                syncState: "clean",
                readOnly: false,
            },
        });
    });

    test("MCP clients get the cloud-documents skill and the workflow in the instructions", async () => {
        const { client } = await connect([], []);
        const { resources } = await client.listResources();

        expect(resources.map((r) => r.uri)).toContain("spicy3d://skill/cloud-documents");
        expect(SKILLS.map((s) => s.name)).not.toContain("cloud-documents");
        expect(MCP_SKILLS.map((s) => s.name)).toContain("cloud-documents");
        const bridge = buildMcpInstructions("bridge");
        expect(bridge).toContain("spicy3d_list_cloud_documents → spicy3d_open_document { id }");
        expect(bridge).not.toContain("spicy3d_document_history");
        expect(bridge).toContain("spicy3d_save { label }");
        expect(bridge).toContain("cloud-documents");
        const relay = buildMcpInstructions("relay");
        expect(relay).toContain("spicy3d_list_documents → spicy3d_open_document { id }");
        expect(relay).toContain("Let agents list documents and history");
        expect(relay).not.toContain("spicy3d_list_cloud_documents");
    });

    test("the default registry's load_skill offers the cloud skill to MCP clients", async () => {
        const server = createMcpServer({ instructions: "x" });
        const client = new Client({ name: "test", version: "1" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

        const result = await client.callTool({ name: "load_skill", arguments: { name: "cloud-documents" } });

        expect((result.content as { text: string }[])[0].text).toContain("Conflict pending user resolution");
        expect(agentCloudLink()).toBeUndefined();
    });
});

describe("OpenConsent", () => {
    test("asking about another document closes the first question as declined", async () => {
        const prompt = manualAsk();
        const consent = new OpenConsent({ ask: prompt.ask });
        const question = { current: "A", target: "B" };

        expect(await consent.request("b", question, async () => true, 5)).toBe("waiting");
        const other = consent.request("c", { current: "A", target: "C" }, async () => true, 1000);
        await prompt.answer("keep", 1);

        expect(await other).toBe("proceed");
        expect(prompt.asked.map((q) => q.target)).toEqual(["B", "C"]);
        expect(consent.asking).toBe(false);
    });

    test("an answer nobody picked up expires; the next call asks again", async () => {
        const clock = { now: 0 };
        const prompt = manualAsk();
        const consent = new OpenConsent({ ask: prompt.ask, now: () => clock.now });
        const question = { current: "A", target: "B" };

        expect(await consent.request("b", question, async () => true, 5)).toBe("waiting");
        await prompt.answer("keep");
        await new Promise((r) => setTimeout(r, 0));
        clock.now = 10 * 60_000;

        const again = consent.request("b", question, async () => true, 1000);
        await prompt.answer("cancel", 1);
        expect(await again).toBe("declined");
        expect(prompt.asked).toHaveLength(2);
    });
});

describe("review fixes", () => {
    function tool(name: string, handler: Tool["handler"]): Tool {
        return { name, description: name, parameters: { type: "object", properties: {} }, handler };
    }

    async function connect(options: Parameters<typeof createMcpServer>[0] = {}) {
        const server = createMcpServer({
            tools: [],
            instructions: "x",
            queue: new SerialQueue(),
            ...options,
        });
        const client = new Client({ name: "test", version: "1" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        return { server, client };
    }

    const agentPrompt = () => document.querySelector("dialog[data-prompt='agentOpen']");

    test("spicy3d_list_cloud_documents lists through the tab, in UTC; only the local bridge offers it", async () => {
        const { run, cloud } = setup();

        const result = await run("spicy3d_list_cloud_documents", { query: " Brack ", limit: 500 });

        expect((cloud as unknown as { list: ReturnType<typeof rs.fn> }).list).toHaveBeenCalledWith({
            search: "Brack",
            limit: 100,
        });
        expect(result).toEqual({
            documents: [
                {
                    id: "doc-2",
                    name: "Bracket",
                    updatedAt: "2026-09-27T13:35:49Z",
                    sizeBytes: 1234,
                    headVersionId: "v7",
                },
            ],
            more: true,
        });

        const bridge = await connect({ connection: "bridge" });
        const relay = await connect({ connection: "relay" });
        const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
        expect(await names(bridge.client)).toContain("spicy3d_list_cloud_documents");
        expect(await names(relay.client)).not.toContain("spicy3d_list_cloud_documents");
        expect(await names(relay.client)).toContain("spicy3d_open_document");
    });

    test("a save conflict opens the conflict UI once per document, never again while it waits", async () => {
        const { run, link, app, cloud } = setup();
        const document = doc(app, "doc-2", cloud, true);
        show(app, document);
        link.saveOutcome = { status: "conflict", conflict: { status: "conflict", headVersion: "v9" } };
        let close!: () => void;
        const handler = rs.fn(
            (_document: IDocument, _conflict: SaveConflict) =>
                new Promise<void>((resolve) => {
                    close = resolve;
                }),
        );
        app.repositories.conflictHandler = handler;

        await run("spicy3d_save");
        const second = await run("spicy3d_save");
        expect(handler).toHaveBeenCalledTimes(1);
        expect(second.error).toContain("already has the conflict in front of them");

        // Closed without resolving; the document then waits in conflict: the next save opens none.
        close();
        await new Promise((r) => setTimeout(r, 0));
        link.info = { syncState: "conflict", readOnly: false };
        await run("spicy3d_save");
        expect(handler).toHaveBeenCalledTimes(1);

        // Resolved, a new conflict later: shown again.
        link.info = { syncState: "clean", readOnly: false };
        await run("spicy3d_save");
        expect(handler).toHaveBeenCalledTimes(2);
    });

    test("the result says what the version became when the user's own save joined it", async () => {
        const { run, link, app, cloud } = setup();
        show(app, doc(app, "doc-2", cloud, true));
        link.saveOutcome = { status: "saved", version: "v3", kind: "manual" };

        const result = await run("spicy3d_save", { label: "Agent: fillet" });

        expect(result).toMatchObject({ saved: true, version: "v3", kind: "manual" });
        expect(result.label).toBeUndefined();
        expect(result.note).toContain("stored as a manual version and your label was not kept");
    });

    test("opening a version (a separate preview) does not ask about the unsaved changes", async () => {
        const { run, link, app, prompt } = setup();
        show(app, doc(app, "mine", app.repositories.local, true));

        const result = await run("spicy3d_open_document", { id: "doc-2", version: "v1" });

        expect(result.opened).toBe(true);
        expect(prompt.asked).toEqual([]);
        expect(link.opened).toEqual(["doc-2@v1"]);
    });

    test("no server leaks its sign-in listener: not before connecting, and not after the connection ends", async () => {
        const before = agentCloudListenerCount();
        const failing = createMcpServer({ tools: [], instructions: "x" });
        await expect(
            failing.connect({
                start: async () => {
                    throw new Error("bridge not running");
                },
                send: async () => {},
                close: async () => {},
            }),
        ).rejects.toThrow("bridge not running");
        expect(agentCloudListenerCount()).toBe(before);

        const { client } = await connect();
        expect(agentCloudListenerCount()).toBe(before + 1);
        await client.close();
        await rs.waitFor(() => expect(agentCloudListenerCount()).toBe(before));
    });

    test("the open question closes when the asking connection ends", async () => {
        const { app } = setup();
        show(app, doc(app, "mine", app.repositories.local, true));
        const { client } = await connect({ cloudTools: buildCloudTools() });

        const pending = client
            .callTool({ name: "spicy3d_open_document", arguments: { id: "doc-2" } })
            .catch((err: Error) => err);
        await rs.waitFor(() => expect(agentPrompt()).not.toBeNull());
        await client.close();

        await rs.waitFor(() => expect(agentPrompt()).toBeNull());
        expect(await pending).toBeInstanceOf(Error);
    });

    test("the relay's session that asked ends, or the user signs out: the question closes", async () => {
        const { app, cloud } = setup();
        show(app, doc(app, "mine", app.repositories.local, true));
        const { client } = await connect({
            cloudTools: buildCloudTools({ waitMs: 20 }),
            connection: "relay",
        });
        const ask = (agent: string) =>
            client.callTool({
                name: "spicy3d_open_document",
                arguments: { id: "doc-2" },
                _meta: { "spicy3d/agent": { id: agent } },
            });

        const waiting = await ask("a1");
        expect(JSON.parse((waiting.content as { text: string }[])[0].text).status).toBe("waitingForUser");
        expect(agentPrompt()).not.toBeNull();
        forgetCloudCaller("someone-else");
        expect(agentPrompt()).not.toBeNull();
        forgetCloudCaller("a1");
        await rs.waitFor(() => expect(agentPrompt()).toBeNull());

        await ask("a2");
        expect(agentPrompt()).not.toBeNull();
        setAgentCloudLink(undefined);
        await rs.waitFor(() => expect(agentPrompt()).toBeNull());
        setAgentCloudLink(new FakeLink(app, cloud));
    });
});
