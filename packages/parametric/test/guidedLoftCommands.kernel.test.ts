// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type AsyncController,
    type IPicker,
    Matrix4,
    Plane,
    ShapeTypes,
    type VisualShapeData,
    XYZ,
} from "@spicy3d/core";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { LoftFeatureCommand } from "../src/commands/loftCommand";
import type { LoftEditCommand } from "../src/commands/loftEditCommand";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch";
import { guidedLoftInputs, guidedVertical, setupGuidedLoft } from "./_helpers/guidedLoft";
import "../src/commands";
import "./sketch/setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
afterEach(() => {
    rs.restoreAllMocks();
});

function pick(node: SketchNode, type: number): VisualShapeData {
    const shape =
        type === ShapeTypes.face ? node.mesh.faces?.range[0]?.shape : node.mesh.edges?.range[0]?.shape;
    expect(shape).not.toBeUndefined();
    return {
        shape,
        owner: { node },
        transform: Matrix4.identity(),
        indexes: [9876],
    } as unknown as VisualShapeData;
}

test("guided creation picks both paths, previews and commits exactly one undo step", async () => {
    const { app, document, first, last, spine, boundary } = guidedLoftInputs();
    const command = new LoftFeatureCommand();
    let count = 0;
    document.picker = {
        pickShape: async () => {
            const step = count++;
            if (step === 0) {
                command.guided = true;
                return [pick(first, ShapeTypes.face)];
            }
            if (step === 1) return [pick(last, ShapeTypes.face)];
            if (step === 2) {
                command.confirm();
                return [];
            }
            if (step === 3) return [pick(spine, ShapeTypes.edge)];
            if (step === 4) {
                setTimeout(() => command.confirm(), 0);
                return [pick(boundary, ShapeTypes.edge)];
            }
            throw new Error("Unexpected picker request");
        },
    } as unknown as IPicker;
    const position = document.history.position();
    await command.execute(app);
    expect(count).toBe(5);
    const bodies = document.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode[];
    expect(bodies).toHaveLength(1);
    expect(bodies[0].shape.isOk, bodies[0].shape.error).toBe(true);
    expect(bodies[0].features[0]).toMatchObject({
        guided: {
            spine: { nodeId: spine.id, edges: [{ edgeId: `sketch:${spine.id}:path:ent11` }] },
            boundary: { nodeId: boundary.id, edges: [{ edgeId: `sketch:${boundary.id}:path:ent11` }] },
        },
    });
    expect(document.history.position()).not.toBe(position);
    expect([first.visible, last.visible, spine.visible, boundary.visible]).toEqual([
        false,
        false,
        true,
        true,
    ]);
    document.history.undo();
    expect(document.history.position()).toBe(position);
    expect(document.modelManager.findNodes((node) => node instanceof ParametricBodyNode)).toHaveLength(0);
    expect([first.visible, last.visible]).toEqual([true, true]);
    document.history.redo();
    expect(document.modelManager.findNodes((node) => node instanceof ParametricBodyNode)).toHaveLength(1);
});

async function edit(state: ReturnType<typeof setupGuidedLoft>) {
    expect(state.body.shape.isOk).toBe(true);
    const done = state.body.editFeature(state.feature.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = state.app.executingCommand as LoftEditCommand;
    expect(command).not.toBeUndefined();
    expect(command.guided).toBe(true);
    return { command, done };
}

test("guided edit previews options without mutation; confirmation and undo preserve inputs", async () => {
    const state = setupGuidedLoft();
    const before = JSON.stringify(state.body.features);
    const { command, done } = await edit(state);
    command.solid = false;
    expect(JSON.stringify(state.body.features)).toBe(before);
    command.confirm();
    await done;
    expect(state.body.features[0]).toMatchObject({
        id: state.feature.id,
        solid: false,
        guided: state.feature.guided,
    });
    expect(state.body.shape.isOk, state.body.shape.error).toBe(true);
    state.document.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.body.shape.value.volume()).toBeCloseTo(1200, 5);
});

test("repicking one guide preserves the other reference and feature identity as one undo step", async () => {
    const state = setupGuidedLoft();
    const replacement = new SketchNode({
        document: state.document,
        plane: state.boundary.plane,
        data: guidedVertical(5),
    });
    state.document.modelManager.addNode(replacement);
    const before = JSON.stringify(state.body.features);
    const { command, done } = await edit(state);
    state.document.picker = {
        pickShape: async () => [pick(replacement, ShapeTypes.edge)],
    } as unknown as IPicker;
    await command.pickBoundary();
    expect(JSON.stringify(state.body.features)).toBe(before);
    command.confirm();
    await done;
    expect(state.body.features[0]).toMatchObject({
        id: state.feature.id,
        guided: { spine: state.feature.guided?.spine, boundary: { nodeId: replacement.id } },
    });
    state.document.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
});

test("an incompatible repick cannot commit through Confirm; cancel preserves payload and history", async () => {
    const state = setupGuidedLoft();
    const invalid = new SketchNode({
        document: state.document,
        plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: guidedVertical(2),
    });
    state.document.modelManager.addNode(invalid);
    const before = JSON.stringify(state.body.features);
    const position = state.document.history.position();
    const { command, done } = await edit(state);
    state.document.picker = { pickShape: async () => [pick(invalid, ShapeTypes.edge)] } as unknown as IPicker;
    await command.pickBoundary();
    command.confirm();
    expect(JSON.stringify(state.body.features)).toBe(before);
    await command.cancel();
    await done;
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.document.history.position()).toBe(position);
    expect(state.body.shape.isOk).toBe(true);
    expect(state.document.history.disabled).toBe(false);
});

test("canceling while a guided repick is pending cancels its picker without mutating the feature", async () => {
    const state = setupGuidedLoft();
    const before = JSON.stringify(state.body.features);
    const position = state.document.history.position();
    const { command, done } = await edit(state);
    let cancelled = false;
    state.document.picker = {
        pickShape: (_prompt: unknown, controller: AsyncController) =>
            new Promise<VisualShapeData[]>((resolve) => {
                controller.onCancelled(() => {
                    cancelled = true;
                    resolve([]);
                });
            }),
    } as unknown as IPicker;
    const pick = command.pickBoundary();
    await command.cancel();
    await pick;
    await done;
    expect(cancelled).toBe(true);
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.document.history.position()).toBe(position);
    expect(state.document.history.disabled).toBe(false);
});
