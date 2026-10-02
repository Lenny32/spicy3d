// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { DocumentRebuilds, decodeDocumentFile, type IEdge, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { ShapeFactory } from "@spicy3d/wasm";
import "../../wasm/test/setup";
import "../src";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import "./sketch/setup";

// Offline, opt-in replay of the attachment to #132. The investigated snapshot succeeds;
// this guards that outcome without committing a large model or loading it in ordinary CI.
test.skipIf(!process.env["SPICY3D_ISSUE_132_MODEL"])(
    "issue 132 saved final body accepts the reported half-millimetre bottom fillet",
    async () => {
        const document = new TestDocument({ application: createMockApplication() });
        const factory = new ShapeFactory();
        rs.stubGlobal("shapeFactory", factory);
        try {
            const modelPath = process.env["SPICY3D_ISSUE_132_MODEL"];
            if (!modelPath) throw new Error("Missing issue 132 model path");
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
            const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
            try {
                const bottom = edges.findIndex((edge) => {
                    const box = edge.geometryBoundingBox();
                    return Math.abs(box.min.z) < 0.001 && Math.abs(box.max.z) < 0.001 && edge.length() > 300;
                });
                expect(bottom).toBeGreaterThanOrEqual(0);
                const result = factory.fillet(body.shape.value, [bottom], 0.5);
                expect(result.isOk).toBe(true);
                if (!result.isOk) throw new Error(result.error);
                try {
                    expect(result.value.checkShape()).toBe(true);
                } finally {
                    result.value.dispose();
                }
            } finally {
                for (const edge of edges) edge.dispose();
            }
        } finally {
            document.dispose();
            rs.unstubAllGlobals();
        }
    },
    600_000,
);
