// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DocumentMutations, DocumentRebuilds, type Serialized, Transaction } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { ParametricBodyNode } from "@spicy3d/parametric";
import { HybridShapeFactory, ShapeFactory } from "@spicy3d/wasm";
import "../../parametric/test/sketch/setup";
import "../../wasm/test/setup";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
import { createMcpServer } from "../src/mcp/server";
import { buildTools } from "../src/tools";
import { cancelAllProgramJobs } from "../src/tools/programJobs";

test("published corner job fits native geometry through the strict worker protocol and commits one undo", async () => {
    const fixture = loadDocumentFixtures().find(
        (item) => item.name === "v2/parametric12-corner-setback.json",
    );
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Missing corner fixture");
    const data = structuredClone(fixture.data);
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    document.visual = createMockVisualWithDocument(document);
    document.selection = createMockSelection();
    app.activeView = createMockView({ document });
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    rs.stubGlobal("shapeFactory", new ShapeFactory(hybrid));
    rs.stubGlobal("app", app);
    const client = new Client({ name: "native-corner-job", version: "1" });
    try {
        // Start from the same approved tracked input with the ordinary fillet still committed.
        const models = data["models"] as {
            nodes: Serialized[];
            components: Serialized[];
            materials: Serialized[];
        };
        for (const node of models.nodes) {
            if (node["__cla$$__"] !== "ParametricBodyNode") continue;
            const features = JSON.parse(node["featuresJson"] as string);
            for (const feature of features) delete feature.cornerSetbacks;
            node["featuresJson"] = JSON.stringify(features);
        }
        document.variables.setItems(data["variables"]);
        await document.modelManager.deserialize(models);
        const body = document.modelManager.findNode(
            (node) => node instanceof ParametricBodyNode,
        ) as ParametricBodyNode;
        expect(body).toBeInstanceOf(ParametricBodyNode);
        expect(body.shape.isOk).toBe(true);
        expect(await body.whenRebuilt()).toBe(true);
        const feature = body.features.find((item) => item.type === "fillet");
        expect(feature?.type).toBe("fillet");
        if (!feature || feature.type !== "fillet") throw new Error("Missing fillet");
        const original = body.featuresJson;
        const position = document.history.position();
        const server = createMcpServer({ tools: buildTools() });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(b), client.connect(a)]);
        const call = async (name: string, args: Record<string, unknown>) => {
            const reply = await client.callTool({ name, arguments: args });
            const content = reply.content as { type: string; text: string }[];
            expect(content[0].type).toBe("text");
            return JSON.parse(content[0].text);
        };
        const started = await call("start_corner_setback_job", {
            bodyId: body.id,
            featureId: feature.id,
            expectedEdgeRefs: feature.edges,
            distances: [2.49, 2.5, 2.51],
        });
        const status = await rs.waitFor(
            async () => {
                const value = await call("get_corner_setback_job", { jobId: started.jobId });
                if (!["completed", "failed", "cancelled"].includes(value.state)) {
                    throw new Error(`Corner job is still ${value.state}`);
                }
                return value;
            },
            // Native corner fits take about a minute; leave room for slower CI runners.
            { timeout: 120_000, interval: 25 },
        );
        expect(status.state, status.error).toBe("completed");
        expect(status.progress).toMatchObject({ completed: 1, total: 1 });
        expect(
            transport.requests.filter(
                (request) => request.type === "request" && request.operation === "cornerSetbackReplica",
            ),
        ).toHaveLength(1);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.checkShape()).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(0);
        expect(body.shape.value.volume()).toBeLessThan(64000);
        expect(document.history.position()).not.toBe(position);
        expect(DocumentMutations.isHeld(document)).toBe(false);
        expect(Transaction.isActive(document)).toBe(false);
        const committed = body.featuresJson;
        document.history.undo();
        await DocumentRebuilds.settled(document);
        expect(body.featuresJson).toBe(original);
        expect(document.history.position()).toBe(position);
        document.history.redo();
        await DocumentRebuilds.settled(document);
        expect(body.featuresJson).toBe(committed);
        expect(body.shape.isOk).toBe(true);
    } finally {
        cancelAllProgramJobs("Test cleanup");
        await client.close();
        document.dispose();
        await DocumentRebuilds.settled(document);
        hybrid.dispose();
        rs.unstubAllGlobals();
    }
}, 180_000);
