// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { agentCloudLink } from "@spicy3d/ai/src/tools/cloudLink";
import { buildCloudTools } from "@spicy3d/ai/src/tools/cloudTools";
import { type IDocument, type IView, Logger, type SaveConflict, type Serialized } from "@spicy3d/core";
import { CloudAgentDocuments } from "../src/mcp/agentDocuments";
import { FakeDocumentServer } from "./_helpers/fakeDocumentServer";
import { FakeServer, json, TestRequest } from "./_helpers/fakeServer";
import {
    Device,
    documentData,
    FakeEventsServer,
    FlakyNetwork,
    type SyncDoc,
    until,
    valuesOf,
} from "./_helpers/syncHarness";

beforeAll(() => {
    rs.stubGlobal("Request", TestRequest);
});

afterAll(() => {
    rs.unstubAllGlobals();
});

let devices: Device[];
let server: FakeServer;
let docs: FakeDocumentServer;
let events: FakeEventsServer;

beforeEach(() => {
    devices = [];
    server = new FakeServer();
    docs = new FakeDocumentServer(server);
    events = new FakeEventsServer(docs);
    rs.spyOn(Logger, "info").mockImplementation(() => {});
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
    for (const device of devices) device.dispose();
    rs.restoreAllMocks();
    for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
});

async function device(options?: Parameters<typeof Device.start>[3]) {
    const started = await Device.start(server, events, new FlakyNetwork(server), options);
    devices.push(started);
    return started;
}

const head = (id = "doc-1") => docs.head(id)!;

/** The tab shows `doc`: what the tools act on. */
function show(a: Device, doc: SyncDoc) {
    a.app.activeView = {
        document: doc as unknown as IDocument,
        cameraController: { fitContent: () => {} },
    } as unknown as IView;
}

function tool(name: string) {
    return buildCloudTools({ waitMs: 50 }).find((t) => t.name === name)!;
}

async function call(name: string, args: Record<string, unknown> = {}) {
    return JSON.parse((await tool(name).handler(args)) as string);
}

describe("the agent's cloud link", () => {
    test("is lent while signed in and taken back when the cloud documents stop", async () => {
        expect(agentCloudLink()).toBeUndefined();
        const a = await device();
        expect(agentCloudLink()).toBeInstanceOf(CloudAgentDocuments);

        a.dispose();
        devices = [];

        expect(agentCloudLink()).toBeUndefined();
    });

    test("signing out takes it back, which ends the agents' open questions (CLOUD-17)", async () => {
        const a = await device();
        expect(agentCloudLink()).toBeInstanceOf(CloudAgentDocuments);

        server.on("POST /api/auth/logout", json(204));
        await a.account.signOut();

        await until(() => agentCloudLink() === undefined, "the link taken back");
        expect(agentCloudLink()).toBeUndefined();
    });

    test("a save is an mcp version with the label, pushed before the call returns", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const parent = head().id;
        doc.edit("w", "12");

        const outcome = await agentCloudLink()!.save(doc as unknown as IDocument, "Agent: wider");

        expect(outcome).toEqual({ status: "saved", version: head().id, kind: "mcp", label: "Agent: wider" });
        expect(head()).toMatchObject({ kind: "mcp", label: "Agent: wider", parentIds: [parent] });
        expect(valuesOf(docs.content(head()))).toEqual({ w: "12" });
        expect(doc.isDirty).toBe(false);
    });

    test("offline, the save stays on this device (pending) and is pushed as an mcp version later", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const before = head().id;
        doc.edit("w", "13");
        a.network.down = true;

        const outcome = await agentCloudLink()!.save(doc as unknown as IDocument, "offline edit");

        expect(outcome).toEqual({ status: "pending", reason: "offline", kind: "mcp", label: "offline edit" });
        expect(head().id).toBe(before);
        a.network.down = false;
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed after reconnecting");
        expect(head()).toMatchObject({ kind: "mcp", label: "offline edit" });
    });

    test("offline, the user's later autosave joins the agent's save: pushed as the user's, unlabelled", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "13");
        const agents = await agentCloudLink()!.save(doc as unknown as IDocument, "Agent: 13");
        expect(agents).toMatchObject({ status: "pending", kind: "mcp", label: "Agent: 13" });

        doc.edit("w", "14");
        await doc.save("auto");
        a.network.down = false;
        await until(() => a.repository.stateOf("doc-1") === "saved", "pushed after reconnecting");

        expect(head().kind).toBe("auto");
        expect(head().label).toBeNull();
        expect(valuesOf(docs.content(head()))).toEqual({ w: "14" });
    });

    test("an agent's save reports what the server stored: the user's manual save joined it", async () => {
        // No backoff retry may push the manual save alone before the agent's save joins it.
        const a = await device({ sync: { initialDelayMs: 60_000, maxDelayMs: 60_000 } });
        const doc = await a.create("doc-1", { w: "10" });
        a.network.down = true;
        doc.edit("w", "11");
        await doc.save("manual");
        doc.edit("w", "12");
        a.network.down = false;

        const outcome = await agentCloudLink()!.save(doc as unknown as IDocument, "Agent: 12");

        expect(outcome).toEqual({ status: "saved", version: head().id, kind: "manual" });
        expect(head()).toMatchObject({ kind: "manual", label: null });
    });

    test("a change elsewhere that can't be merged is a conflict left to the user", async () => {
        const a = await device({ deviceName: "Desktop" });
        const doc = await a.create("doc-1", { w: "10" });
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }), "Tablet");
        doc.edit("w", "20");

        const outcome = await agentCloudLink()!.save(doc as unknown as IDocument);

        expect(outcome.status).toBe("conflict");
        expect((outcome as { conflict: SaveConflict }).conflict).toMatchObject({ headDeviceName: "Tablet" });
        expect(a.repository.stateOf("doc-1")).toBe("conflict");
        expect(agentCloudLink()!.describe(doc as unknown as IDocument)?.syncState).toBe("conflict");
    });

    test("describes a cloud document's sync state; a local one is none of its business", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });

        expect(agentCloudLink()!.describe(doc as unknown as IDocument)).toEqual({
            syncState: "clean",
            readOnly: false,
        });
        const local = { ...doc, repository: a.app.repositories.local } as unknown as IDocument;
        expect(agentCloudLink()!.describe(local)).toBeUndefined();
    });

    test("opens the head through the app, and an older version as the history's read-only preview", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        const first = head().id;
        doc.edit("w", "11");
        await doc.save("manual");
        await a.engine.settle();
        await doc.close();
        const loaded: { data: Serialized; source: unknown }[] = [];
        a.app.loadDocument = async (data, source) => {
            loaded.push({ data, source });
            return {
                id: data["id"],
                name: data["name"],
                repository: source?.repository,
            } as unknown as IDocument;
        };

        const opened = await agentCloudLink()!.open("doc-1");
        expect(opened.isOk && (opened.value as unknown as SyncDoc).values).toEqual({ w: "11" });

        const preview = await agentCloudLink()!.openVersion("doc-1", first);
        expect(preview.isOk).toBe(true);
        expect(valuesOf(loaded[0].data)).toEqual({ w: "10" });
        const info = agentCloudLink()!.describe(preview.isOk ? preview.value : ({} as IDocument));
        expect(info).toEqual({ readOnly: true, preview: { documentId: "doc-1", versionId: first } });
        expect(a.documents.history?.history.documentId).toBe("doc-1");

        const missing = await agentCloudLink()!.openVersion("doc-1", "no-such-version");
        expect(!missing.isOk && missing.error).toEqual({ kind: "notFound", id: "no-such-version" });
    });
});

describe("spicy3d_save through the real sync", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
        rs.stubGlobal("Request", TestRequest);
    });

    test("the kind mcp and the label reach the server; the answer names the new head", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        show(a, doc);
        rs.stubGlobal("app", a.app);
        doc.edit("w", "40");

        const result = await call("spicy3d_save", { label: "  Agent: 40 mm  " });

        expect(result).toMatchObject({
            saved: true,
            uploaded: true,
            version: head().id,
            label: "Agent: 40 mm",
        });
        expect(result.document).toMatchObject({
            id: "doc-1",
            location: "cloud",
            dirty: false,
            syncState: "clean",
        });
        expect(head()).toMatchObject({ kind: "mcp", label: "Agent: 40 mm" });
    });

    test("a conflict goes to the app's conflict UI and the agent is told it waits for the user", async () => {
        const a = await device();
        const doc = await a.create("doc-1", { w: "10" });
        show(a, doc);
        rs.stubGlobal("app", a.app);
        const shown = rs.fn(async (_document: IDocument, _conflict: SaveConflict) => {});
        a.app.repositories.conflictHandler = shown;
        await docs.saveContentElsewhere("doc-1", documentData("doc-1", { w: "30" }), "Tablet");
        doc.edit("w", "20");

        const result = await call("spicy3d_save");

        expect(result.error).toMatch(/^Conflict pending user resolution/);
        expect(shown).toHaveBeenCalledTimes(1);
        expect(shown.mock.calls[0][0]).toBe(doc);
        expect(shown.mock.calls[0][1]).toMatchObject({ status: "conflict", headDeviceName: "Tablet" });
        // Nothing was forced through: the head is still the other device's.
        expect(valuesOf(docs.content(head()))).toEqual({ w: "30" });
    });
});
