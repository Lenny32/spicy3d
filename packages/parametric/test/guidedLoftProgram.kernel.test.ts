// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, ShapeTypes } from "@spicy3d/core";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { buildParametricTools } from "../../ai/src/tools/parametricTools";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { EdgesReport, ProgramResult } from "../src/program/parametricProgram";
import { guidedLoftInputs, setupGuidedLoft } from "./_helpers/guidedLoft";
import "./sketch/setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
});
beforeEach(() => {
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterEach(() => {
    rs.unstubAllGlobals();
});

function tool(state: ReturnType<typeof guidedLoftInputs>) {
    rs.stubGlobal("app", state.app);
    const published = buildParametricTools()[0];
    return async (ops: unknown[]): Promise<ProgramResult> => {
        const result = await published.handler({ ops, responseMode: "compact" });
        if (typeof result !== "string") throw new Error("Expected JSON tool result");
        return JSON.parse(result);
    };
}

function loft(state: ReturnType<typeof guidedLoftInputs>) {
    return {
        op: "loft",
        id: "guided",
        sections: [state.first.id, state.last.id],
        guided: {
            spine: { nodeId: state.spine.id, edgeIndexes: [0] },
            boundary: { nodeId: state.boundary.id, edgeIndexes: [0] },
        },
    };
}

test("actual MCP calls create and edit an associative guided loft with one-step undo", async () => {
    const state = guidedLoftInputs();
    const call = tool(state);
    const created = await call([loft(state)]);
    expect(created.created).toHaveLength(1);
    const body = state.document.modelManager.findNode(
        (node) => node.id === created.created[0].nodeId,
    ) as ParametricBodyNode;
    expect(body instanceof ParametricBodyNode).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(1200, 5);
    const feature = body.features[0];
    const before = JSON.stringify(body.features);
    await call([{ op: "editLoft", body: body.id, featureId: feature.id, solid: false }]);
    expect(body.features[0]).toMatchObject({ id: feature.id, solid: false });
    expect(body.shape.isOk).toBe(true);
    state.document.history.undo();
    expect(JSON.stringify(body.features)).toBe(before);
    await call([{ op: "editLoft", body: body.id, featureId: feature.id, guided: null }]);
    expect(body.features[0]).not.toHaveProperty("guided");
    expect(body.shape.value.volume()).toBeCloseTo(1200, 5);
});

test("guide references queried in one MCP call round-trip as JSON into another call", async () => {
    const state = setupGuidedLoft();
    expect(state.body.shape.isOk).toBe(true);
    const edges = state.body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex(
        (edge) =>
            edge.startPoint().x === 5 &&
            edge.startPoint().y === 3 &&
            edge.endPoint().x === 5 &&
            edge.endPoint().y === 3,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    for (const edge of edges) edge.dispose();
    const call = tool(state);
    const query = await call([{ op: "edges", id: "guideEdges", body: state.body.id, edgeIndexes: [index] }]);
    const report = query.results["guideEdges"] as EdgesReport;
    expect(report.edges).toHaveLength(1);
    const refs = JSON.parse(JSON.stringify(report.edges.map((item) => item.reference)));
    const created = await call([
        {
            ...loft(state),
            guided: {
                spine: { nodeId: state.spine.id, edgeIndexes: [0] },
                boundary: { nodeId: state.body.id, edgeRefs: refs },
            },
        },
    ]);
    expect(created.created).toHaveLength(1);
    const body = state.document.modelManager.findNode(
        (node) => node.id === created.created[0].nodeId,
    ) as ParametricBodyNode;
    expect(body.shape.isOk, body.shape.error).toBe(true);
    expect(body.features[0]).toMatchObject({
        guided: { boundary: { nodeId: state.body.id, edges: [{ edgeId: refs[0].edge.edgeId }] } },
    });
    await expect(
        call([
            {
                ...loft(state),
                id: "mismatch",
                guided: {
                    spine: { nodeId: state.spine.id, edgeIndexes: [0] },
                    boundary: { nodeId: state.body.id, edgeRefs: [{ ...refs[0], bodyId: "wrong" }] },
                },
            },
        ]),
    ).rejects.toThrow(/different body/);
});

test.each([
    { edgeIndexes: [-1] },
    { edgeIndexes: [0, 999] },
    { edgeIndexes: [0, 0] },
    { edgeIndexes: [] },
])("invalid guided path indexes %j leave no partially created body", async (indexes) => {
    const state = guidedLoftInputs();
    const position = state.document.history.position();
    const call = tool(state);
    await expect(
        call([
            {
                ...loft(state),
                guided: {
                    spine: { nodeId: state.spine.id, ...indexes },
                    boundary: { nodeId: state.boundary.id, edgeIndexes: [0] },
                },
            },
        ]),
    ).rejects.toThrow(/valid edge indexes/);
    expect(state.document.modelManager.findNodes((node) => node instanceof ParametricBodyNode)).toHaveLength(
        0,
    );
    expect(state.document.history.position()).toBe(position);
    expect([state.first.visible, state.last.visible]).toEqual([true, true]);
});
