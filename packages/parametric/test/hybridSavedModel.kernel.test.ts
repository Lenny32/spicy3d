// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { decodeDocumentFile } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { HybridShapeFactory, ShapeFactory } from "@spicy3d/wasm";
import { replicaTopology, sameReplicaTopology } from "../../wasm/src/replicaTopology";
import type { BooleanReplica } from "../../wasm/src/workerProtocol";
import { NativeWorkerTransport } from "../../wasm/test/workerHarness";
import "../../wasm/test/setup";
import "../src";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "./sketch/setup";

test.skipIf(!process.env["SPICY3D_BENCHMARK_MODEL"])(
    "saved-model first worker result preserves topology correspondence",
    async () => {
        const transport = new NativeWorkerTransport();
        transport.hold = true;
        const hybrid = new HybridShapeFactory(() => transport.client);
        rs.stubGlobal("shapeFactory", new ShapeFactory(hybrid));
        const document = new TestDocument({ application: createMockApplication() });
        document.visual = createMockVisualWithDocument(document);
        try {
            const bytes = readFileSync(process.env["SPICY3D_BENCHMARK_MODEL"]!);
            const decoded = await decodeDocumentFile(new Blob([bytes]));
            expect(decoded.isOk).toBe(true);
            document.variables.setItems(decoded.value["variables"]);
            await document.modelManager.deserialize(decoded.value["models"]);
            const body = document.modelManager.findNodes().find((node) => node instanceof ParametricBodyNode);
            expect(body).not.toBeUndefined();
            void body!.shape;
            await rs.waitFor(() => expect(transport.held.length).toBeGreaterThan(0), { timeout: 60_000 });
            const reply = transport.held[0];
            if (reply.type !== "result" || !reply.result.ok) throw new Error(JSON.stringify(reply));
            const result = reply.result.value as BooleanReplica;
            const raw = wasm.Converter.convertFromBrep(result.brep);
            try {
                const actual = replicaTopology(wasm, raw);
                expect(actual.faces).toEqual(result.topology.faces);
                expect(actual.edges).toEqual(result.topology.edges);
                expect(sameReplicaTopology(actual, result.topology)).toBe(true);
            } finally {
                raw.delete();
            }
        } finally {
            document.dispose();
            hybrid.dispose();
            rs.unstubAllGlobals();
        }
    },
    120_000,
);
