// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { DocumentRebuilds, decodeDocumentFile, PerformanceTrace } from "@spicy3d/core";
import { createMockApplication, createMockSelection, TestDocument } from "@spicy3d/core/test-utils";
import { ShapeFactory } from "@spicy3d/wasm";
import { runParametric } from "../../ai/src/tools/parametricTools";
import "../../wasm/test/setup";
import "../src";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "./sketch/setup";

// Download the attachment linked in #127 and point this variable at the local file.
// Opt-in on purpose: loading and replaying the 65-feature body takes about six minutes, too slow
// for every CI run; the fast synthetic boolean-chain tests in parametricProgram.kernel.test.ts
// cover the same batching on every run.
// The report gives complete actions for these two sketches; the other four are abbreviated.
test.skipIf(!process.env["SPICY3D_ISSUE_127_MODEL"])(
    "issue 127 snapshot coalesces the published sketch edits into one owner replay",
    async () => {
        const app = createMockApplication();
        const document = new TestDocument({ application: app, selection: createMockSelection() });
        app.activeView = { document } as never;
        rs.stubGlobal("app", app);
        rs.stubGlobal("shapeFactory", new ShapeFactory());
        try {
            const modelPath = process.env["SPICY3D_ISSUE_127_MODEL"];
            if (!modelPath) throw new Error("Missing issue 127 model path");
            const decoded = await decodeDocumentFile(new Blob([readFileSync(modelPath)]));
            expect(decoded.isOk).toBe(true);
            if (!decoded.isOk) throw new Error(decoded.error.message);
            document.variables.setItems(decoded.value["variables"]);
            await document.modelManager.deserialize(decoded.value["models"]);
            const body = document.modelManager.findNode((node) => node.id === "14JCUVmyt4bcOjacVAvPq");
            expect(body).toBeInstanceOf(ParametricBodyNode);
            if (!(body instanceof ParametricBodyNode)) throw new Error("Missing MouseBottom body");
            void body.shape;
            await DocumentRebuilds.settled(document);
            expect(body.featureCount).toBe(65);
            expect(body.featureItems().filter((item) => item.error)).toEqual([]);
            expect(body.shape.isOk).toBe(true);
            PerformanceTrace.enable();
            await runParametric(
                {
                    ops: [
                        {
                            op: "editSketch",
                            sketch: "28vsMNEFsLWi-FGpNceCB",
                            actions: [
                                { action: "setDatum", constraint: 8, value: 21.8 },
                                { action: "setDatum", constraint: 9, value: 14.5 },
                            ],
                        },
                        {
                            op: "editSketch",
                            sketch: "YnFALZk41XWe9FKK4NitA",
                            actions: [{ action: "setDatum", constraint: 27, value: "pcb_angle + 45" }],
                        },
                    ],
                },
                undefined,
                undefined,
                document,
            );
            const replays = PerformanceTrace.snapshot().records.filter(
                (record) => record.stage === "body.rebuild" && record.details?.["nodeId"] === body.id,
            );
            expect(replays).toHaveLength(1);
            expect(replays[0].details?.["outcome"]).toBe("success");
            expect(body.featureItems().filter((item) => item.error)).toEqual([]);
        } finally {
            PerformanceTrace.disable();
            document.dispose();
            rs.unstubAllGlobals();
        }
    },
    600_000,
);
