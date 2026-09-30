// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IPicker, Matrix4, Plane, ShapeTypes, type VisualShapeData, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { SweepFeatureCommand } from "../src/commands/sweepCommand";
import type { SweepEditCommand } from "../src/commands/sweepEditCommand";
import type { SweepFeatureData } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
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

function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    const section = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 1] }], constraints: [] },
    });
    const path = new SketchNode({
        document: doc,
        plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: { entities: [{ id: 11, type: "line", params: [0, 0, 0, -10] }], constraints: [] },
    });
    doc.modelManager.addNode(section);
    doc.modelManager.addNode(path);
    return { app, doc, section, path };
}
function pick(node: SketchNode, kind: number): VisualShapeData {
    const shape =
        kind === ShapeTypes.face ? node.mesh.faces?.range[0]?.shape : node.mesh.edges?.range[0]?.shape;
    expect(shape).not.toBeUndefined();
    return {
        shape,
        owner: { node },
        transform: Matrix4.identity(),
        indexes: [9876],
    } as unknown as VisualShapeData;
}
function picker(doc: TestDocument, command: { confirm: () => void }, picks: VisualShapeData[]) {
    const queue = [...picks];
    doc.picker = {
        pickShape: async () => {
            const value = queue.shift();
            if (value) return [value];
            command.confirm();
            return [];
        },
    } as unknown as IPicker;
}
const bodies = (doc: TestDocument) =>
    doc.modelManager.findNodes((node) => node instanceof ParametricBodyNode) as ParametricBodyNode[];
async function create() {
    const state = setup();
    const command = new SweepFeatureCommand();
    picker(state.doc, command, [pick(state.section, ShapeTypes.face), pick(state.path, ShapeTypes.edge)]);
    await command.execute(state.app);
    expect(bodies(state.doc)).toHaveLength(1);
    return { ...state, body: bodies(state.doc)[0] };
}
async function edit(state: Awaited<ReturnType<typeof create>>) {
    const done = state.body.editFeature(state.body.features[0].id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session = state.app.executingCommand as SweepEditCommand;
    expect(session).not.toBeUndefined();
    expect(session.solid).toBe(true);
    return { session, done };
}

describe("interactive associative sweep (real kernel)", () => {
    test("captures actual edge topology, previews, and commits creation as one undo step", async () => {
        const { doc, section, path, body } = await create();
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(10 * Math.PI, 5);
        expect(body.features[0]).toMatchObject({
            type: "sweep",
            section: { sketchId: section.id },
            path: { nodeId: path.id, edges: [{ edgeId: `sketch:${path.id}:path:ent11` }] },
        });
        expect([section.visible, path.visible]).toEqual([false, true]);
        doc.history.undo();
        expect(bodies(doc)).toHaveLength(0);
        expect(section.visible).toBe(true);
        doc.history.redo();
        expect(bodies(doc)).toHaveLength(1);
        expect(bodies(doc)[0].shape.value.volume()).toBeCloseTo(10 * Math.PI, 5);
    });

    test("editing options previews without mutation, confirms once, and undo restores the solid", async () => {
        const state = await create();
        const before = JSON.stringify(state.body.features);
        const { session, done } = await edit(state);
        session.solid = false;
        expect(JSON.stringify(state.body.features)).toBe(before);
        session.confirm();
        await done;
        expect(state.body.features[0]).toMatchObject({ solid: false });
        expect(state.body.shape.value.findSubShapes(ShapeTypes.face)).toHaveLength(1);
        state.doc.history.undo();
        expect(JSON.stringify(state.body.features)).toBe(before);
        expect(state.body.shape.value.volume()).toBeCloseTo(10 * Math.PI, 5);
    });

    test("cancel restores visibility/history and leaves feature payload untouched", async () => {
        const state = await create();
        const visibility = rs.spyOn(state.doc.visual.context, "setVisible");
        const before = JSON.stringify(state.body.features);
        const position = state.doc.history.position();
        const { session, done } = await edit(state);
        session.solid = false;
        await session.cancel();
        await done;
        expect(JSON.stringify(state.body.features)).toBe(before);
        expect(state.doc.history.position()).toBe(position);
        expect(state.doc.history.disabled).toBe(false);
        expect([state.section.visible, state.path.visible]).toEqual([false, true]);
        expect(visibility).toHaveBeenCalledWith(state.section, false);
        visibility.mockRestore();
    });

    test("a disconnected repick cannot commit through Confirm; cancel preserves the valid feature", async () => {
        const state = await create();
        const broken = new SketchNode({
            document: state.doc,
            plane: state.path.plane,
            data: {
                entities: [
                    { id: 21, type: "line", params: [0, 0, 0, -5] },
                    { id: 22, type: "line", params: [5, -5, 5, -10] },
                ],
                constraints: [],
            },
        });
        state.doc.modelManager.addNode(broken);
        const before = JSON.stringify(state.body.features);
        const position = state.doc.history.position();
        const { session, done } = await edit(state);
        const edges = broken.mesh.edges?.range.map((range) => range.shape) ?? [];
        expect(edges).toHaveLength(2);
        picker(
            state.doc,
            session,
            edges.map(
                (shape) =>
                    ({
                        shape,
                        owner: { node: broken },
                        transform: Matrix4.identity(),
                        indexes: [1234],
                    }) as unknown as VisualShapeData,
            ),
        );
        await session.pickPath();
        let completed = false;
        const completion = done.then(() => {
            completed = true;
        });
        session.confirm();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(completed).toBe(false);
        expect(JSON.stringify(state.body.features)).toBe(before);
        await session.cancel();
        await completion;
        expect(state.doc.history.position()).toBe(position);
        expect(state.body.shape.isOk).toBe(true);
    });

    test("path repick completes its picker before committing the edit as one undo step", async () => {
        const state = await create();
        const replacement = new SketchNode({
            document: state.doc,
            plane: state.path.plane,
            data: { entities: [{ id: 31, type: "line", params: [0, 0, 0, -20] }], constraints: [] },
        });
        state.doc.modelManager.addNode(replacement);
        const original = (state.body.features[0] as SweepFeatureData).path.nodeId;
        const { session, done } = await edit(state);
        picker(state.doc, session, [pick(replacement, ShapeTypes.edge)]);
        await session.pickPath();
        expect((state.body.features[0] as SweepFeatureData).path.nodeId).toBe(original);
        session.confirm();
        await done;
        expect((state.body.features[0] as SweepFeatureData).path.nodeId).toBe(replacement.id);
        expect(state.body.shape.value.volume()).toBeCloseTo(20 * Math.PI, 5);
        state.doc.history.undo();
        expect((state.body.features[0] as SweepFeatureData).path.nodeId).toBe(original);
        expect(state.body.shape.value.volume()).toBeCloseTo(10 * Math.PI, 5);
    });
});
