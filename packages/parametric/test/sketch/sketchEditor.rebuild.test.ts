// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type AsyncController,
    AutosaveHolds,
    DocumentRebuilds,
    EditSessions,
    type I18nKeys,
    type ICameraController,
    type IEventHandler,
    type IFace,
    Matrix4,
    Plane,
    Result,
    ShapeTypes,
    type VisualShapeData,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { registerFeature } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import type { PlanePickHandler } from "../../src/sketch/commands/planePickHandler";
import { CreateSketch, EnterSketch } from "../../src/sketch/commands/sketchCommands";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

let doc: TestDocument;
let sketch: SketchNode;
let body: ParametricBodyNode;
let evaluated: number[];

beforeEach(() => {
    evaluated = [];
    const app = createMockApplication();
    doc = new TestDocument({ application: app, selection: createMockSelection() });
    doc.visual = createMockVisualWithDocument(doc, { viewHandler: { canRotate: true } as never });
    app.activeView = createMockView({
        document: doc,
        cameraController: {
            cameraPosition: new XYZ({ x: 0, y: -200, z: 200 }),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitZ,
            cameraType: "perspective",
            lookAt: rs.fn(),
            fitContent: rs.fn(),
        } as unknown as ICameraController,
    });
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(new MockShape()) });
    sketch = new SketchNode({ document: doc, plane: Plane.XY, data: { entities: [], constraints: [] } });
    doc.modelManager.addNode(sketch);
    registerFeature("test-editor-rebuild", {
        display: "body.parametricBody",
        parameters: () => [],
        setParameter: (feature) => feature,
        nodeIds: (feature: { index: number }) => (feature.index === 13 ? [sketch.id] : []),
        evaluate: (feature: { index: number }) => {
            evaluated.push(feature.index);
            return Result.ok(new MockShape({ id: `shape-${evaluated.length}` }));
        },
    });
    body = new ParametricBodyNode({
        document: doc,
        featuresJson: JSON.stringify(
            Array.from({ length: 16 }, (_, index) => ({
                id: `f${index}`,
                index,
                type: "test-editor-rebuild",
            })),
        ),
    });
    doc.modelManager.addNode(body);
});

afterEach(async () => {
    SketchEditor.exit();
    await DocumentRebuilds.settled(doc);
    doc.dispose();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

test("the solver activates only after async rollback; exit restores and holds autosave until completion", async () => {
    const entering = SketchEditor.enterAsync(sketch);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body.isRebuilding).toBe(true);
    expect(SketchEditor.getActive()).toBeUndefined();
    expect(AutosaveHolds.isHeld).toBe(true);
    const editor = await entering;
    expect(editor).not.toBeUndefined();
    if (!editor) throw new Error("Sketch entry failed");
    expect(SketchEditor.getActive()).toBe(editor);
    expect(body.rollbackIndex).toBe(13);
    expect(evaluated).toEqual(Array.from({ length: 13 }, (_, index) => index));
    const preview = body.shape.value;
    editor.exit();
    expect(body.isRebuilding).toBe(true);
    expect(body.rollbackIndex).toBe(13);
    expect(body.shape.value).toBe(preview);
    expect(AutosaveHolds.isHeld).toBe(true);
    await DocumentRebuilds.settled(doc);
    expect(body.isRebuilding).toBe(false);
    expect(body.rollbackIndex).toBeUndefined();
    expect(body.shape.value).not.toBe(preview);
    expect(evaluated).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(AutosaveHolds.isHeld).toBe(false);
});

test("a cached large rollback enters and exits synchronously without another feature evaluation", async () => {
    void body.shape;
    DocumentRebuilds.flush(doc);
    expect(evaluated).toHaveLength(16);
    const entering = SketchEditor.enterAsync(sketch);
    const active = SketchEditor.getActive();
    expect(active?.node).toBe(sketch);
    expect(body.rollbackIndex).toBe(13);
    expect(body.isRebuilding).toBe(false);
    expect(evaluated).toHaveLength(16);
    expect(await entering).toBe(active);
    SketchEditor.exit();
    expect(body.rollbackIndex).toBeUndefined();
    expect(body.isRebuilding).toBe(false);
    expect(evaluated).toHaveLength(16);
});

test("cancelling entry during a yield restores every body without activating a solver", async () => {
    const entering = SketchEditor.enterAsync(sketch);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body.isRebuilding).toBe(true);
    SketchEditor.exit();
    expect(await entering).toBeUndefined();
    expect(SketchEditor.getActive()).toBeUndefined();
    expect(sketch.editingSession).toBe(false);
    expect(body.rollbackIndex).toBeUndefined();
    expect(body.isRebuilding).toBe(false);
    expect(body.shape.isOk).toBe(true);
    expect(AutosaveHolds.isHeld).toBe(false);
});

test("a second entry waits for the cancelled preparation to unwind before taking ownership", async () => {
    const first = SketchEditor.enterAsync(sketch);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = SketchEditor.enterAsync(sketch);
    expect(await first).toBeUndefined();
    const editor = await second;
    expect(editor).not.toBeUndefined();
    expect(SketchEditor.getActive()).toBe(editor);
    expect(sketch.editingSession).toBe(true);
    expect(body.rollbackIndex).toBe(13);
    expect(body.isRebuilding).toBe(false);
});

test("disposing the document during entry cancels work and releases the preparation hold", async () => {
    const entering = SketchEditor.enterAsync(sketch);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body.isRebuilding).toBe(true);
    doc.dispose();
    expect(await entering).toBeUndefined();
    expect(SketchEditor.getActive()).toBeUndefined();
    expect(DocumentRebuilds.pending(doc)).toBe(false);
    expect(AutosaveHolds.isHeld).toBe(false);
});

function pickedSketchCommand(): EnterSketch {
    doc.picker.pickNode = rs.fn(async (_prompt: I18nKeys, controller: AsyncController) => {
        controller.success();
        return [sketch];
    });
    return new EnterSketch();
}

function createOnBodyCommand(): CreateSketch {
    // A last-good display can exist without reusable intermediate cache entries.
    // Face capture must not start an unrelated cold full-chain load before this rollback.
    body.setPrivateValue("shape", Result.ok(new MockShape({ id: "last-good-display" })));
    const face = Object.assign(new MockShape({ shapeType: ShapeTypes.face }), {
        normal: () => [XYZ.zero, XYZ.unitZ],
    }) as unknown as IFace;
    face.transformedMul = () => face;
    const picked = {
        shape: face,
        owner: {},
        indexes: [0],
        transform: Matrix4.identity(),
    } as unknown as VisualShapeData;
    Object.assign(doc.visual.context, { getNode: () => body });
    // Simulate a face picked at an earlier timeline position, without warming that chain.
    rs.spyOn(body, "rollbackIndex", "get").mockReturnValueOnce(13);
    doc.picker.pickAsync = rs.fn(
        async (handler: IEventHandler, _prompt: I18nKeys, controller: AsyncController) => {
            (handler as PlanePickHandler).result = { kind: "face", data: picked };
            controller.success();
        },
    );
    return new CreateSketch();
}

test.each([
    "enter",
    "create",
] as const)("cancelling %s during uncached rollback awaits its cleanup", async (kind) => {
    const command = kind === "enter" ? pickedSketchCommand() : createOnBodyCommand();
    const running = command.execute(doc.application);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body.isRebuilding).toBe(true);
    expect(body.rollbackIndex).toBe(13);
    expect(evaluated.length).toBeLessThan(13);
    expect(SketchEditor.getActive()).toBeUndefined();
    expect(AutosaveHolds.isHeld).toBe(true);
    await command.cancel();
    expect(command.isCompleted).toBe(true);
    expect(command.isCanceled).toBe(true);
    expect(SketchEditor.getActive()).toBeUndefined();
    expect(body.rollbackIndex).toBeUndefined();
    expect(body.isRebuilding).toBe(false);
    expect(EditSessions.isActive(doc)).toBe(false);
    expect(AutosaveHolds.isHeld).toBe(false);
    expect(
        doc.modelManager
            .findNodes((node) => node instanceof SketchNode)
            .map((node) => (node as SketchNode).editingSession),
    ).not.toContain(true);
    await running;
});

test("cancelling an older command cannot cancel a newer entry task", async () => {
    const command = pickedSketchCommand();
    const running = command.execute(doc.application);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body.isRebuilding).toBe(true);
    const newer = new SketchNode({ document: doc, plane: Plane.XY, data: { entities: [], constraints: [] } });
    doc.modelManager.addNode(newer);
    const entering = SketchEditor.enterAsync(newer);
    await command.cancel();
    await running;
    const editor = await entering;
    expect(editor?.node).toBe(newer);
    expect(SketchEditor.getActive()).toBe(editor);
    expect(sketch.editingSession).toBe(false);
    expect(newer.editingSession).toBe(true);
    expect(body.rollbackIndex).toBeUndefined();
});
