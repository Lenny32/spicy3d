// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type ICameraController, Plane, Result, type ShapeMeshData, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { SketchCopyCommand } from "../../src/sketch/commands/sketchCopy";
import { SketchExtendCommand } from "../../src/sketch/commands/sketchExtend";
import { SketchMirrorCommand } from "../../src/sketch/commands/sketchMirror";
import { SketchMoveCommand } from "../../src/sketch/commands/sketchMove";
import { SketchOffsetCommand } from "../../src/sketch/commands/sketchOffset";
import { SketchPasteCommand } from "../../src/sketch/commands/sketchPaste";
import { SketchRotateCommand } from "../../src/sketch/commands/sketchRotate";
import { SketchSplitCommand } from "../../src/sketch/commands/sketchSplit";
import { SketchTrimCommand } from "../../src/sketch/commands/sketchTrim";
import { sketchClipboard } from "../../src/sketch/commands/sketchUtilityCommand";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { extendCurve, offsetCurve, splitCurve, trimCurve } from "../../src/sketch/geometryEditing";
import { ConstraintKind, type SketchData, type SketchEntityData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { copySketchSelection, type SketchTransform } from "../../src/sketch/utilityOperations";
import "./setup";

const source: SketchEntityData = { id: 1, type: "line", params: [0, 0, 100, 0] };
const boundary: SketchEntityData = { id: 2, type: "line", params: [60, -50, 60, 50] };
const target: SketchEntityData = { id: 3, type: "line", params: [150, -50, 150, 50] };

function setup(data: SketchData = { entities: [source, boundary, target], constraints: [] }) {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: () => {} } as never });
    let meshId = 0;
    const displayMesh = rs.fn((_meshes: ShapeMeshData[]) => ++meshId);
    const removeMesh = rs.fn((_id: number) => {});
    doc.visual = createMockVisualWithDocument(doc, { context: { displayMesh, removeMesh } });
    const view = createMockView({
        document: doc,
        cameraController: {
            cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
            cameraTarget: XYZ.zero,
            cameraUp: XYZ.unitY,
            cameraType: "perspective",
            lookAt: () => {},
            fitContent: () => {},
        } as unknown as ICameraController,
    });
    app.activeView = view;
    const shape = () => Result.ok({ isEqual: () => false });
    rs.stubGlobal("shapeFactory", { line: shape, circle: shape, arc: shape, wire: shape, combine: shape });
    const node = new SketchNode({ document: doc, plane: Plane.XY, data });
    const editor = SketchEditor.enter(node);
    const handler = doc.visual.eventHandler as SketchEventHandler;
    const event = (x: number, y: number, button = 0) =>
        ({ offsetX: x + 400, offsetY: 300 - y, button }) as PointerEvent;
    return {
        doc,
        node,
        editor,
        handler,
        displayMesh,
        removeMesh,
        move: (x: number, y = 0) => handler.pointerMove(view, event(x, y)),
        click: async (x: number, y = 0) => {
            handler.pointerDown(view, event(x, y));
            await Promise.resolve();
        },
        pressEscape: () => handler.keyDown(view, new KeyboardEvent("keydown", { key: "Escape" })),
    };
}

afterEach(() => {
    sketchClipboard.value = undefined;
    SketchEditor.exit();
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
});

describe("utility operations", () => {
    test("move can switch to a user-picked anchor while active", async () => {
        const { handler, editor, click } = setup();
        handler.selectEntities([1]);
        const command = new SketchMoveCommand();
        const run = command.executeAsync();
        await Promise.resolve();
        command.pickAnchor();
        await Promise.resolve();
        await Promise.resolve();
        expect(editor.isPicking).toBe(true);
        await click(10, 0);
        expect(editor.isPicking).toBe(true);
        await click(30, 20);
        await run;
        expect(editor.solver.entity(1)!.params).toEqual([20, 20, 120, 20]);
    });

    test("numeric input changes refresh the preview before commit", async () => {
        const { handler, editor, node, pressEscape } = setup();
        handler.selectEntities([1]);
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const command = new SketchMoveCommand();
        const run = command.executeAsync();
        await Promise.resolve();
        command.numeric = true;
        command.dx = 12;
        const mesh = preview.mock.calls.at(-1)![0][0] as { position: Float32Array };
        expect(Array.from(mesh.position)).toEqual([12, 0, 0, 112, 0, 0]);
        expect(node.data.entities[0].params).toEqual(source.params);
        pressEscape();
        await run;
    });
    test.each([
        { name: "move", transform: { kind: "move", delta: [10, 20] } as SketchTransform, copy: false },
        {
            name: "rotate",
            transform: { kind: "rotate", center: [0, 0], angle: Math.PI / 2 } as SketchTransform,
            copy: false,
        },
        { name: "mirror copy", transform: { kind: "mirror", axis: boundary } as SketchTransform, copy: true },
        {
            name: "mirror replace",
            transform: { kind: "mirror", axis: boundary } as SketchTransform,
            copy: false,
        },
        { name: "paste", transform: { kind: "move", delta: [10, 20] } as SketchTransform, copy: false },
    ])("$name commits one undoable edit", ({ name, transform, copy }) => {
        const { editor, node, doc } = setup();
        const before = node.data;
        const clipboard = copySketchSelection(before, [1, 3]);
        expect(clipboard.isOk).toBe(true);
        expect(
            editor.applyTransform([1, 3], transform, name === "paste" ? clipboard.value : undefined, copy),
        ).toBe(true);
        const after = node.data;
        expect(after).not.toEqual(before);
        expect(after.entities).toHaveLength(copy || name === "paste" ? 5 : 3);
        doc.history.undo();
        expect(node.data).toEqual(before);
        expect(editor.solver.toData()).toEqual(before);
        doc.history.redo();
        expect(node.data).toEqual(after);
        expect(editor.solver.toData()).toEqual(after);
    });

    test("a failed utility solve rolls back geometry and constraints", () => {
        const { editor, node } = setup();
        const before = node.data;
        rs.spyOn(editor, "solve").mockReturnValue({ result: "Diverged", dofs: 4 });
        expect(editor.applyTransform([1], { kind: "move", delta: [10, 20] })).toBe(false);
        expect(editor.solver.toData()).toEqual(before);
        expect(node.data).toEqual(before);
    });

    test("move previews a multi-selection and cancels without changing it", async () => {
        const { handler, editor, node, move, pressEscape } = setup();
        handler.selectEntities([1, 3]);
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const run = new SketchMoveCommand().executeAsync();
        await Promise.resolve();
        const before = node.data;
        move(200, 30);
        expect(preview.mock.calls.at(-1)![0]).toHaveLength(2);
        expect(node.data).toEqual(before);
        pressEscape();
        await run;
        expect(node.data).toEqual(before);
        expect(preview.mock.calls.at(-1)![0]).toEqual([]);
    });

    test("numeric move applies the configured displacement to the selection", async () => {
        const { handler, editor } = setup();
        handler.selectEntities([1, 3]);
        const command = new SketchMoveCommand();
        command.numeric = true;
        command.dx = 12;
        command.dy = -7;
        const run = command.executeAsync();
        await Promise.resolve();
        command.apply();
        await run;
        expect(editor.solver.entity(1)!.params).toEqual([12, -7, 112, -7]);
        expect(editor.solver.entity(3)!.params).toEqual([162, -57, 162, 43]);
    });

    test("copy survives a sketch session and paste places the selection center at the pick", async () => {
        const first = setup();
        first.handler.selectEntities([1]);
        await new SketchCopyCommand().executeAsync();
        const copied = first.node.data;
        expect(first.editor.solver.toData()).toEqual(copied);
        SketchEditor.exit();
        const second = setup({ entities: [], constraints: [] });
        const run = new SketchPasteCommand().executeAsync();
        second.move(200, 20);
        expect(second.node.data.entities).toEqual([]);
        await second.click(200, 20);
        await run;
        expect(second.node.data.entities[0].params).toEqual([150, 20, 250, 20]);
    });

    test("mirror uses a picked construction line and creates symmetry constraints", async () => {
        const { handler, editor, click } = setup();
        handler.selectEntities([1]);
        const run = new SketchMirrorCommand().executeAsync();
        await Promise.resolve();
        await click(60, 40);
        await run;
        expect(editor.solver.entities()).toHaveLength(4);
        expect(editor.solver.entity(4)!.params).toEqual([120, 0, 20, 0]);
        expect(
            editor.solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Symmetric),
        ).toHaveLength(2);
    });

    test.each([
        false,
        true,
    ])("rotate supports numeric relative/absolute angles (absolute=%s)", async (absolute) => {
        const { handler, editor, click } = setup();
        handler.selectEntities([1]);
        const command = new SketchRotateCommand();
        command.numeric = true;
        command.angle = 90;
        command.absolute = absolute;
        const run = command.executeAsync();
        await Promise.resolve();
        await click(0, 0);
        await click(0, 50);
        command.apply();
        await run;
        const params = editor.solver.entity(1)!.params;
        expect(params[2]).toBeCloseTo(absolute ? 100 : 0, 7);
        expect(params[3]).toBeCloseTo(absolute ? 0 : 100, 7);
    });
});

describe("geometry edit transactions", () => {
    test("a failed solve restores the sketch and creates no history entry", () => {
        const { editor, node, doc } = setup({ entities: [source], constraints: [] });
        const before = node.data;
        rs.spyOn(editor, "solve").mockReturnValue({ result: "Diverged", dofs: 4 });
        const edit = splitCurve(source, [30, 0]);
        expect(edit.isOk).toBe(true);
        expect(editor.applyGeometryEdit(edit.value)).toBe(false);
        expect(editor.solver.toData()).toEqual(before);
        expect(node.data).toEqual(before);
        doc.history.undo();
        expect(node.data).toEqual(before);
    });

    test.each([
        { name: "trim", proposal: () => trimCurve(source, [boundary], [80, 0]), count: 1 },
        { name: "split", proposal: () => splitCurve(source, [40, 0]), count: 2 },
        { name: "extend", proposal: () => extendCurve(source, target, [90, 0]), count: 1 },
        { name: "offset", proposal: () => offsetCurve(source, 5), count: 2 },
    ])("$name is one undoable edit", ({ proposal, count }) => {
        const { editor, doc, node } = setup({ entities: [source], constraints: [] });
        const before = node.data;
        const edit = proposal();
        expect(edit.isOk).toBe(true);
        expect(editor.applyGeometryEdit(edit.value)).toBe(true);
        expect(node.data.entities).toHaveLength(count);
        const after = node.data;
        expect(after).not.toEqual(before);
        doc.history.undo();
        expect(node.data).toEqual(before);
        expect(editor.solver.toData()).toEqual(before);
        doc.history.redo();
        expect(node.data).toEqual(after);
        expect(editor.solver.toData()).toEqual(after);
    });

    test("trim removes dimension anchors; undo restores constraints and anchors", () => {
        const data: SketchData = {
            entities: [source],
            constraints: [
                { id: 1, kind: ConstraintKind.Fix, refs: [{ entityId: 1, pointIndex: 1 }], datums: [100, 0] },
            ],
            anchors: [{ id: 1, anchor: { kind: "offset", offset: 10 } }],
        };
        const { editor, doc } = setup(data);
        const edit = trimCurve(source, [boundary], [80, 0]);
        expect(edit.isOk).toBe(true);
        expect(editor.applyGeometryEdit(edit.value)).toBe(true);
        expect(editor.dimensionAnchors.size).toBe(0);
        expect(editor.solver.toData().constraints).toEqual([]);
        doc.history.undo();
        expect(editor.dimensionAnchors.get(1)).toEqual({ kind: "offset", offset: 10 });
        expect(editor.solver.toData().constraints).toEqual(data.constraints);
    });
});

describe("geometry command interaction", () => {
    test("trim previews only the removed segment, repeats, and undoes each click", async () => {
        const { editor, node, doc, move, click, pressEscape } = setup();
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const run = new SketchTrimCommand().executeAsync();
        const before = node.data;
        move(80);
        expect(node.data).toEqual(before);
        expect(preview).toHaveBeenCalled();
        const mesh = preview.mock.calls.at(-1)![0][0];
        expect(mesh).toHaveProperty("color", 0xff5555);
        expect(Array.from((mesh as { position: Float32Array }).position)).toEqual([60, 0, 0, 100, 0, 0]);
        await click(80);
        expect(editor.isPicking).toBe(true);
        expect(node.data.entities.find((e) => e.type === "line" && e.params[1] === 0)?.params).toEqual([
            0, 0, 60, 0,
        ]);
        await click(20);
        expect(node.data.entities).toHaveLength(2);
        doc.history.undo();
        expect(node.data.entities).toHaveLength(3);
        doc.history.undo();
        expect(node.data).toEqual(before);
        pressEscape();
        await run;
        expect(editor.isPicking).toBe(false);
        expect(preview.mock.calls.at(-1)?.[0]).toEqual([]);
        expect(SketchEditor.getActive()).toBe(editor);
    });

    test("extend keeps the selected target for repeated edits", async () => {
        const { editor, node, move, click, pressEscape } = setup();
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const run = new SketchExtendCommand().executeAsync();
        await click(150, 20);
        move(90);
        expect(preview.mock.calls.at(-1)?.[0]).toHaveLength(1);
        await click(90);
        expect(node.data.entities.find((e) => e.params[1] === 0)?.params).toEqual([0, 0, 150, 0]);
        expect(editor.isPicking).toBe(true);
        pressEscape();
        await run;
    });

    test.each([
        1, -1,
    ])("offset previews a fixed distance on side %s and leaves source unchanged", async (side) => {
        const { editor, node, move, click } = setup();
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const command = new SketchOffsetCommand();
        command.distance = 5;
        const run = command.executeAsync();
        await click(20);
        move(20, side * 20);
        const mesh = preview.mock.calls.at(-1)![0][0] as { position: Float32Array };
        expect(Array.from(mesh.position)).toEqual([0, side * 5, 0, 100, side * 5, 0]);
        expect(node.data.entities).toHaveLength(3);
        await click(20, side * 20);
        await run;
        expect(node.data.entities).toHaveLength(4);
        expect(node.data.entities[0]).toEqual(source);
        expect(node.data.entities[3].params).toEqual([0, side * 5, 100, side * 5]);
        expect(node.data.constraints).toEqual([]);
    });

    test("split cancellation removes preview meshes without changing geometry", async () => {
        const { editor, node, move, pressEscape, removeMesh } = setup();
        const preview = rs.spyOn(editor.annotations, "setGeometryPreview");
        const run = new SketchSplitCommand().executeAsync();
        const before = node.data;
        move(30);
        expect(preview.mock.calls.at(-1)?.[0]).toHaveLength(3);
        const removedBefore = removeMesh.mock.calls.length;
        pressEscape();
        await run;
        expect(removeMesh.mock.calls.length).toBeGreaterThan(removedBefore);
        expect(node.data).toEqual(before);
        expect(preview.mock.calls.at(-1)?.[0]).toEqual([]);
    });
});
