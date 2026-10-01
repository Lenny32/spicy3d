// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type I18nKeys,
    type IFace,
    type IPicker,
    Plane,
    type VisualShapeData,
    XYZ,
} from "@spicy3d/core";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { EmbossCommand, type EmbossEditCommand } from "../src/commands/embossCommand";
import type { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch";
import { embossFixture, rectangle } from "./_helpers/emboss";
import "../src/commands";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
const documents: ReturnType<typeof embossFixture>["doc"][] = [];
afterEach(() => {
    for (const doc of documents.splice(0)) doc.dispose();
});
function setup(creating = false) {
    const state = embossFixture(!creating);
    documents.push(state.doc);
    expect(state.body.shape.isOk).toBe(true);
    return state;
}
function pick(
    node: SketchNode | ParametricBodyNode,
    test: (face: IFace) => boolean = () => true,
): VisualShapeData {
    const range = node.mesh.faces?.range.find((range) => test(range.shape as unknown as IFace));
    expect(range).not.toBeUndefined();
    if (!range) throw new Error("Missing pick range");
    return {
        shape: range.shape,
        owner: { node },
        transform: node.worldTransform(),
        indexes: [9876],
    } as unknown as VisualShapeData;
}
const top = (face: IFace) => Math.abs(face.boundingBox().min.z - 20) < 1e-6;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function picker(state: ReturnType<typeof setup>, groups: VisualShapeData[][]) {
    state.doc.picker = { pickShape: async () => groups.shift() ?? [] } as unknown as IPicker;
}
async function edit(state: ReturnType<typeof setup>) {
    const done = state.body.editFeature("emboss");
    await tick();
    const session = state.app.executingCommand as EmbossEditCommand;
    expect(session).not.toBeUndefined();
    expect(session.depth).toBe(2);
    return { session, done };
}

test("creation previews without writes and confirms as one undo step including sketch visibility", async () => {
    const state = setup(true),
        position = state.doc.history.position();
    const command = new EmbossCommand();
    picker(state, [[pick(state.body, top)], [pick(state.sketch)]]);
    const done = command.execute(state.app);
    await tick();
    expect(command["previewValid"]).toBe(true);
    expect(command["previewIds"].length).toBeGreaterThan(0);
    expect(state.body.features).toHaveLength(1);
    expect(state.doc.history.position()).toBe(position);
    command.depth = 3;
    command.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ type: "emboss", depth: 3, deboss: false });
    expect(state.body.shape.value.volume()).toBeCloseTo(32300, 3);
    expect(state.sketch.visible).toBe(false);
    state.doc.history.undo();
    expect(state.body.features).toHaveLength(1);
    expect(state.sketch.visible).toBe(true);
    expect(state.doc.history.position()).toBe(position);
    state.doc.history.redo();
    expect(state.body.shape.value.volume()).toBeCloseTo(32300, 3);
});

test.each([
    true,
    false,
])("cancel leaves creation=%s payload, volume, visibility and history unchanged", async (creating) => {
    const state = setup(creating);
    const before = JSON.stringify(state.doc.modelManager.serialize()),
        position = state.doc.history.position();
    const command = creating ? new EmbossCommand() : undefined;
    if (command) picker(state, [[pick(state.body, top)], [pick(state.sketch)]]);
    const done = command ? command.execute(state.app) : state.body.editFeature("emboss");
    await tick();
    const session = command ?? (state.app.executingCommand as EmbossEditCommand);
    expect(session["previewValid"]).toBe(true);
    session.depth = 5;
    session.deboss = true;
    await session.cancel();
    await done;
    expect(JSON.stringify(state.doc.modelManager.serialize())).toBe(before);
    expect(state.doc.history.position()).toBe(position);
    expect(state.doc.history.disabled).toBe(false);
    expect(state.body.shape.value.volume()).toBeCloseTo(creating ? 32000 : 32200, 3);
    expect(session["previewIds"]).toEqual([]);
});

test("editing depth and mode previews and commits once, with undo restoring both", async () => {
    const state = setup(),
        before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    session.depth = 3;
    session.deboss = true;
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
    session.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ depth: 3, deboss: true });
    expect(state.body.shape.value.volume()).toBeCloseTo(31700, 3);
    state.doc.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
});

test("invalid depth blocks confirmation and unchanged edits create no undo step", async () => {
    const state = setup(),
        before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    session.depth = -2;
    expect(session["previewValid"]).toBe(false);
    session.confirm();
    expect(state.app.executingCommand).toBe(session);
    expect(JSON.stringify(state.body.features)).toBe(before);
    session.depth = 2;
    session.confirm();
    await done;
    expect(state.doc.history.position()).toBe(position);
});

test("profile replacement previews independently and preserves the old input on undo", async () => {
    const state = setup();
    const replacement = new SketchNode({
        document: state.doc,
        plane: state.sketch.plane,
        data: rectangle(5, 5, 10, 10, 301),
    });
    state.doc.modelManager.addNode(replacement);
    const before = JSON.stringify(state.body.features);
    const { session, done } = await edit(state);
    picker(state, [[pick(replacement)]]);
    await session.pickProfiles();
    expect(session["previewValid"]).toBe(true);
    expect(JSON.stringify(state.body.features)).toBe(before);
    session.confirm();
    await done;
    expect(state.body.features[1]).toMatchObject({ sketchId: replacement.id });
    expect(state.body.shape.value.volume()).toBeCloseTo(32050, 3);
    state.doc.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
});

test("target reselection uses the entering solid, restores rollback and commits once", async () => {
    const state = setup();
    // A vertical sketch projects onto either parallel wall of the base.
    const replacement = new SketchNode({
        document: state.doc,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 50, z: 0 }), normal: XYZ.unitY, xvec: XYZ.unitX }),
        data: rectangle(10, -15, 20, -5, 401),
    });
    state.doc.modelManager.addNode(replacement);
    const before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    picker(state, [[pick(replacement)]]);
    await session.pickProfiles();
    expect(session["previewValid"]).toBe(false);
    let rolledBack = false;
    state.doc.picker = {
        pickShape: async () => {
            rolledBack =
                state.body.rollbackIndex === 1 && Math.abs(state.body.shape.value.volume() - 32000) < 1e-6;
            return [pick(state.body, (face) => Math.abs(face.boundingBox().min.y - 40) < 1e-6)];
        },
    } as unknown as IPicker;
    await session.pickFaces();
    expect(rolledBack).toBe(true);
    expect(state.body.rollbackIndex).toBeUndefined();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(session["previewValid"]).toBe(true);
    session.confirm();
    await done;
    expect(state.body.shape.value.boundingBox().max.y).toBeCloseTo(42, 5);
    expect(state.body.shape.value.volume()).toBeCloseTo(32200, 3);
    state.doc.history.undo();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
});

test("cancel during target picking restores the full timeline without payload changes", async () => {
    const state = setup(),
        before = JSON.stringify(state.body.features),
        position = state.doc.history.position();
    const { session, done } = await edit(state);
    state.doc.picker = {
        pickShape: (_prompt: I18nKeys, controller: AsyncController) =>
            new Promise<VisualShapeData[]>((resolve) => controller.onCancelled(() => resolve([]))),
    } as unknown as IPicker;
    const picking = session.pickFaces();
    await tick();
    expect(state.body.rollbackIndex).toBe(1);
    await session.cancel();
    await picking;
    await done;
    expect(state.body.rollbackIndex).toBeUndefined();
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.doc.history.position()).toBe(position);
    expect(state.body.shape.value.volume()).toBeCloseTo(32200, 3);
});
