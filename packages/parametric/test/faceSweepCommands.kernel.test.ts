// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IPicker, Matrix4, Plane, ShapeTypes, type VisualShapeData, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { FaceSweepCommand, type FaceSweepEditCommand } from "../src/commands/faceSweepCommand";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src/commands";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
async function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    const fixture = loadDocumentFixtures().find((entry) => entry.name === "v2/parametric11-face-sweep.json");
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Missing face sweep fixture");
    await doc.modelManager.deserialize(structuredClone(fixture.data["models"]));
    const body = doc.modelManager.findNode((node) => node.id === "body-face-sweep") as ParametricBodyNode;
    const section = doc.modelManager.findNode((node) => node.id === "sketch-section") as SketchNode;
    const path = doc.modelManager.findNode((node) => node.id === "sketch-path") as SketchNode;
    expect(body).toBeInstanceOf(ParametricBodyNode);
    expect(body.shape.isOk).toBe(true);
    return { app, doc, body, section, path };
}
function pick(node: ParametricBodyNode | SketchNode, kind: number): VisualShapeData {
    const ranges = kind === ShapeTypes.face ? node.mesh.faces?.range : node.mesh.edges?.range;
    const shape = ranges?.find(
        (range) =>
            kind !== ShapeTypes.face ||
            node instanceof SketchNode ||
            !(range.shape as unknown as import("@spicy3d/core").IFace).surface().isPlanar(),
    )?.shape;
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function edit(state: Awaited<ReturnType<typeof setup>>) {
    const done = state.body.editFeature(state.body.features[1].id);
    await tick();
    const session = state.app.executingCommand as FaceSweepEditCommand;
    expect(session).not.toBeUndefined();
    expect(session.operation).toBe("option.command.operation.join");
    return { session, done };
}
test("creation previews without mutation and appends a rib as exactly one undo step", async () => {
    const state = await setup();
    state.body.setFeaturesEmitShapeChanged(state.body.features.slice(0, 1));
    const before = state.doc.history.position();
    const command = new FaceSweepCommand();
    picker(state.doc, command, [
        pick(state.body, ShapeTypes.face),
        pick(state.section, ShapeTypes.face),
        pick(state.path, ShapeTypes.edge),
    ]);
    const done = command.execute(state.app);
    await tick();
    expect(command["previewValid"]).toBe(true);
    expect(state.body.features).toHaveLength(1);
    expect(state.doc.history.position()).toBe(before);
    command.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ type: "faceSweep", operation: "join" });
    expect(state.body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
    expect(state.section.visible).toBe(false);
    state.doc.history.undo();
    expect(state.body.features).toHaveLength(1);
    expect(state.section.visible).toBe(true);
    state.doc.history.redo();
    expect(state.body.features).toHaveLength(2);
    expect(state.body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
});
test("an operation edit previews without mutation and confirms as one undo step", async () => {
    const state = await setup();
    const before = JSON.stringify(state.body.features);
    const { session, done } = await edit(state);
    session.operation = "option.command.operation.cut";
    expect(JSON.stringify(state.body.features)).toBe(before);
    session.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ operation: "cut" });
    expect(state.body.shape.value.volume()).toBeCloseTo(1990.5 * Math.PI, 3);
    state.doc.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
});
test("cancel restores visibility and leaves payload and history untouched", async () => {
    const state = await setup();
    const before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    session.operation = "option.command.operation.cut";
    await session.cancel();
    await done;
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
    expect(state.doc.history.disabled).toBe(false);
    expect(state.body.shape.value.volume()).toBeCloseTo(2010.5 * Math.PI, 3);
});
test("an off-support path repick cannot commit through Confirm", async () => {
    const state = await setup();
    const broken = new SketchNode({
        document: state.doc,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 5 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: { entities: [{ id: 1, type: "arc", params: [0, 0, 11, 0, 0, 11] }], constraints: [] },
    });
    state.doc.modelManager.addNode(broken);
    const before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    picker(state.doc, session, [pick(broken, ShapeTypes.edge)]);
    await session.pickPath();
    session.confirm();
    expect(state.app.executingCommand).toBe(session);
    expect(JSON.stringify(state.body.features)).toBe(before);
    await session.cancel();
    await done;
    expect(state.doc.history.position()).toBe(position);
    expect(JSON.stringify(state.body.features)).toBe(before);
});

test("canceling creation leaves the preceding solid, visibility and undo position intact", async () => {
    const state = await setup();
    state.body.setFeaturesEmitShapeChanged(state.body.features.slice(0, 1));
    const before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const command = new FaceSweepCommand();
    picker(state.doc, command, [
        pick(state.body, ShapeTypes.face),
        pick(state.section, ShapeTypes.face),
        pick(state.path, ShapeTypes.edge),
    ]);
    const done = command.execute(state.app);
    await tick();
    expect(command["previewValid"]).toBe(true);
    await command.cancel();
    await done;
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
    expect(state.doc.history.disabled).toBe(false);
    expect(state.section.visible).toBe(true);
    expect(state.body.shape.value.volume()).toBeCloseTo(2000 * Math.PI, 3);
});
test("confirming an unchanged edit creates no empty undo step", async () => {
    const state = await setup();
    const position = state.doc.history.position(),
        before = JSON.stringify(state.body.features);
    const { session, done } = await edit(state);
    session.confirm();
    await done;
    expect(state.doc.history.position()).toBe(position);
    expect(JSON.stringify(state.body.features)).toBe(before);
});
test("a genuine curved path repick previews and commits once, with undo restoring the old path", async () => {
    const state = await setup();
    const replacement = new SketchNode({
        document: state.doc,
        plane: state.path.plane,
        data: {
            entities: [{ id: 77, type: "arc", params: [0, 0, 10, 0, -5, Math.sqrt(75)] }],
            constraints: [],
        },
    });
    state.doc.modelManager.addNode(replacement);
    const before = JSON.stringify(state.body.features),
        oldVolume = state.body.shape.value.volume();
    const { session, done } = await edit(state);
    picker(state.doc, session, [pick(replacement, ShapeTypes.edge)]);
    await session.pickPath();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(session["previewValid"]).toBe(true);
    session.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ path: { nodeId: replacement.id } });
    expect(state.body.shape.value.volume()).toBeGreaterThan(oldVolume);
    state.doc.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.body.shape.value.volume()).toBeCloseTo(oldVolume, 5);
});
