// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, ShapeTypes } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../../wasm/test/helpers";
import "../../../wasm/test/setup";
import { buildParametricTools } from "../../../ai/src/tools/parametricTools";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import "../sketch/setup";

beforeEach(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterEach(() => {
    rs.unstubAllGlobals();
});
async function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    rs.stubGlobal("app", app);
    const fixture = loadDocumentFixtures().find((entry) => entry.name === "v2/parametric11-face-sweep.json");
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Missing face sweep fixture");
    await doc.modelManager.deserialize(structuredClone(fixture.data["models"]));
    const body = doc.modelManager.findNode((node) => node.id === "body-face-sweep") as ParametricBodyNode;
    expect(body).toBeInstanceOf(ParametricBodyNode);
    body.setFeaturesEmitShapeChanged(body.features.slice(0, 1));
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    let faceIndex: number;
    try {
        faceIndex = faces.findIndex((face) => !face.surface().isPlanar());
    } finally {
        for (const face of faces) face.dispose();
    }
    expect(faceIndex).toBeGreaterThanOrEqual(0);
    const op = {
        op: "faceSweep",
        id: "rib",
        body: body.id,
        section: { sketchId: "sketch-section" },
        path: { nodeId: "sketch-path", edgeIndexes: [0] },
        support: { nodeId: body.id, faceIndex },
        operation: "join",
    };
    const tool = buildParametricTools().find((item) => item.name === "run_parametric");
    expect(tool).not.toBeUndefined();
    if (!tool) throw new Error("Missing published tool");
    return { doc, body, op, tool };
}
test("the published MCP tool creates and edits a real cylindrical-wall rib and cut with one undo per call", async () => {
    const { doc, body, op, tool } = await setup();
    const created = JSON.parse(
        (await tool.handler(JSON.parse(JSON.stringify({ ops: [op], responseMode: "compact" })))) as string,
    );
    expect(created.bodies[0].status).toBe("ok");
    expect(body.features[1]).toMatchObject({ type: "faceSweep", operation: "join" });
    expect(body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
    const edited = JSON.parse(
        (await tool.handler({
            ops: [{ op: "editFaceSweep", body: "rib", featureId: body.features[1].id, operation: "cut" }],
            responseMode: "compact",
        })) as string,
    );
    expect(edited.bodies[0].status).toBe("ok");
    expect(body.shape.value.volume()).toBeCloseTo(1990.5 * Math.PI, 3);
    doc.history.undo();
    expect(body.features[1]).toMatchObject({ operation: "join" });
    expect(body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
    doc.history.undo();
    expect(body.features).toHaveLength(1);
    expect(body.shape.value.volume()).toBeCloseTo(2000 * Math.PI, 3);
    doc.history.redo();
    expect(body.features).toHaveLength(2);
});
test("a failed multi-op MCP edit restores exact payload, geometry and undo position", async () => {
    const { doc, body, op, tool } = await setup();
    await tool.handler({ ops: [op] });
    const before = JSON.stringify(body.features),
        position = doc.history.position(),
        volume = body.shape.value.volume();
    await expect(
        tool.handler({
            ops: [
                { op: "editFaceSweep", body: body.id, featureId: body.features[1].id, operation: "cut" },
                {
                    op: "editFaceSweep",
                    body: body.id,
                    featureId: body.features[1].id,
                    support: { nodeId: body.id, faceIndex: 9999 },
                },
            ],
        }),
    ).rejects.toThrow(/face|index/i);
    expect(JSON.stringify(body.features)).toBe(before);
    expect(doc.history.position()).toBe(position);
    expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
    doc.history.undo();
    expect(body.features).toHaveLength(1);
});
test.each([
    "fuse",
    "common",
    null,
    1,
])("an unsupported face-sweep operation (%s) cannot mutate the host", async (operation) => {
    const { doc, body, op, tool } = await setup();
    const before = JSON.stringify(body.features),
        position = doc.history.position();
    await expect(tool.handler({ ops: [{ ...op, operation }] })).rejects.toThrow(/join or cut/);
    expect(JSON.stringify(body.features)).toBe(before);
    expect(doc.history.position()).toBe(position);
});
