// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AutosaveHolds,
    I18n,
    type IApplication,
    type ICameraController,
    type IDocument,
    Plane,
    PubSub,
    Result,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { promptControlBSpline } from "../../src/sketch/editor/controlBSplinePrompt";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { promptSketchText } from "../../src/sketch/editor/textPrompt";
import {
    axisLineRefs,
    ConstraintKind,
    SKETCH_X_AXIS_ID,
    type SketchData,
} from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { copySketchSelection } from "../../src/sketch/utilityOperations";
import "./setup";

interface TestContext {
    app: IApplication;
    doc: IDocument;
    view: ReturnType<typeof createMockView>;
    camera: {
        cameraPosition: XYZ;
        cameraTarget: XYZ;
        cameraUp: XYZ;
        cameraType: "perspective" | "orthographic";
        lookAt: ReturnType<typeof rs.fn>;
        fitContent: ReturnType<typeof rs.fn>;
    };
    clearSelection: ReturnType<typeof rs.fn>;
    setNodeOnTop: ReturnType<typeof rs.fn>;
    oldHandler: unknown;
    restoreFactory: () => void;
}

function mockShapeFactory() {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    return () => {
        if (previous) {
            Object.defineProperty(globalThis, "shapeFactory", previous);
        } else {
            delete (globalThis as any).shapeFactory;
        }
    };
}

function setup(): TestContext {
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: -200, z: 200 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitZ,
        cameraType: "perspective" as "perspective" | "orthographic",
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const app = createMockApplication();
    const clearSelection = rs.fn();
    const setNodeOnTop = rs.fn();
    const doc = new TestDocument({ application: app, selection: { clearSelection } as any });
    doc.visual = createMockVisualWithDocument(doc, {
        viewHandler: { canRotate: true } as any,
        context: { setNodeOnTop },
    }) as any;
    const view = createMockView({
        document: doc,
        cameraController: camera as unknown as ICameraController,
    });
    (app as any).activeView = view;
    return {
        app,
        doc,
        view,
        camera,
        clearSelection,
        setNodeOnTop,
        oldHandler: doc.visual.eventHandler,
        restoreFactory: mockShapeFactory(),
    };
}

test("confirming the same clockwise expression in the dimension dialog preserves its side", () => {
    const { doc, restoreFactory } = setup();
    const previous = PubSub.default.pub;
    let dialog: { content: HTMLElement; buttons: any[] } | undefined;
    PubSub.default.pub = ((topic: string, ...args: any[]) => {
        if (topic === "showDialog") dialog = { content: args[1], buttons: args[2] };
    }) as typeof previous;
    Object.assign(shapeFactory, { line: () => Result.ok(new MockShape()) });
    try {
        doc.variables.setItems([{ id: "tilt", name: "tilt", type: "angle", expression: "30" }]);
        const start = { entityId: 1, pointIndex: 0 },
            end = { entityId: 1, pointIndex: 1 };
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "line", params: [0, 0, 5 * Math.sqrt(3), -5] }],
                constraints: [
                    { id: 2, kind: ConstraintKind.Fix, refs: [start], datums: [0, 0] },
                    { id: 3, kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 },
                    {
                        id: 4,
                        kind: ConstraintKind.Angle,
                        refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
                        datum: "tilt",
                        angleSide: -1,
                    },
                ],
            },
        });
        const editor = SketchEditor.enter(node);
        editor.editDatum(4);
        expect(dialog).not.toBeUndefined();
        const input = dialog!.content.querySelector("input");
        expect(input).not.toBeNull();
        expect(input!.value).toBe("tilt");
        expect(dialog!.buttons[0].shouldClose()).toBe(true);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(-5, 6);
        expect(node.data.constraints.find((c) => c.id === 4)).toMatchObject({ datum: "tilt", angleSide: -1 });
        editor.exit();
        node.dispose();
    } finally {
        PubSub.default.pub = previous;
        SketchEditor.exit();
        restoreFactory();
        doc.dispose();
    }
});

test.each([-20, -30])("session entry follows a pending tilt 30 -> %s change", (degrees) => {
    const { doc, restoreFactory } = setup();
    const variable = { id: "tilt", name: "tilt", type: "angle" as const, expression: "30" };
    Object.assign(shapeFactory, { line: () => Result.ok(new MockShape()) });
    try {
        doc.variables.setItems([variable]);
        const start = { entityId: 1, pointIndex: 0 };
        const end = { entityId: 1, pointIndex: 1 };
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "line", params: [0, 0, 5 * Math.sqrt(3), 5] }],
                constraints: [
                    { id: 2, kind: ConstraintKind.Fix, refs: [start], datums: [0, 0] },
                    { id: 3, kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 },
                    {
                        id: 4,
                        kind: ConstraintKind.Angle,
                        refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
                        datum: "tilt",
                    },
                ],
            },
        });
        // Not attached to the tree: enter with geometry still at the previous table's value.
        doc.variables.setItems([{ ...variable, expression: String(degrees) }]);
        const editor = SketchEditor.enter(node);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((degrees * Math.PI) / 180), 6);
        expect(editor.solver.toData().constraints.find((c) => c.id === 4)?.datum).toBe("tilt");
        editor.exit();
        node.dispose();
    } finally {
        SketchEditor.exit();
        restoreFactory();
        doc.dispose();
    }
});

test.each([
    { initial: 30, edited: -30, redo: false, next: -20 },
    { initial: 30, edited: -30, redo: true, next: 20 },
    { initial: -30, edited: 30, redo: false, next: 20 },
    { initial: -30, edited: 30, redo: true, next: -20 },
])("session angle follows parameter replay: %j", ({ initial, edited, redo, next }) => {
    const { doc, restoreFactory } = setup();
    const variable = { id: "tilt", name: "tilt", type: "angle" as const, expression: String(initial) };
    const start = { entityId: 1, pointIndex: 0 };
    const end = { entityId: 1, pointIndex: 1 };
    const radians = (initial * Math.PI) / 180;
    Object.assign(shapeFactory, { line: () => Result.ok(new MockShape()) });
    let node: SketchNode | undefined;
    try {
        doc.variables.setItems([variable]);
        node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 10 * Math.cos(radians), 10 * Math.sin(radians)] },
                ],
                constraints: [
                    { id: 2, kind: ConstraintKind.Fix, refs: [start], datums: [0, 0] },
                    { id: 3, kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 },
                    {
                        id: 4,
                        kind: ConstraintKind.Angle,
                        refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
                        datum: "tilt",
                    },
                ],
            },
        });
        const editor = SketchEditor.enter(node);
        const undoCount = doc.history.undoCount();
        const changeTilt = (degrees: number) =>
            Transaction.execute(doc, "Edit tilt", () =>
                doc.variables.setItems([{ ...variable, expression: String(degrees) }]),
            );
        changeTilt(edited);
        expect(doc.history.undoCount()).toBe(undoCount + 1);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((edited * Math.PI) / 180), 6);
        doc.history.undo();
        expect(doc.variables.evaluate().scope.get("tilt")?.value).toBe(initial);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin(radians), 6);
        expect(doc.history.undoCount()).toBe(undoCount);
        if (redo) doc.history.redo();
        const restored = redo ? edited : initial;
        expect(doc.variables.evaluate().scope.get("tilt")?.value).toBe(restored);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((restored * Math.PI) / 180), 6);
        changeTilt(next);
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((next * Math.PI) / 180), 6);
        // Reopening must use the restored parameter table and persisted angle semantics.
        doc.history.undo();
        expect(editor.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((restored * Math.PI) / 180), 6);
        editor.exit();
        const reopened = SketchEditor.enter(node);
        expect(reopened.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((restored * Math.PI) / 180), 6);
        changeTilt(next);
        expect(reopened.solver.pointOf(end)[1]).toBeCloseTo(10 * Math.sin((next * Math.PI) / 180), 6);
        expect(node.data.entities[0].params[3]).toBeCloseTo(10 * Math.sin((next * Math.PI) / 180), 6);
    } finally {
        SketchEditor.exit();
        node?.dispose();
        restoreFactory();
        doc.dispose();
    }
});

test.each([
    { initial: 30, redo: false },
    { initial: 30, redo: true },
    { initial: -30, redo: false },
    { initial: -30, redo: true },
])("session follows variable-only replay after an outside edit: %j", ({ initial, redo }) => {
    const { doc, restoreFactory } = setup();
    const variable = { id: "tilt", name: "tilt", type: "angle" as const, expression: String(initial) };
    const start = { entityId: 1, pointIndex: 0 };
    const end = { entityId: 1, pointIndex: 1 };
    const radians = (initial * Math.PI) / 180;
    Object.assign(shapeFactory, { line: () => Result.ok(new MockShape()) });
    try {
        doc.variables.setItems([variable]);
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 10 * Math.cos(radians), 10 * Math.sin(radians)] },
                ],
                constraints: [
                    { id: 2, kind: ConstraintKind.Fix, refs: [start], datums: [0, 0] },
                    { id: 3, kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 },
                    {
                        id: 4,
                        kind: ConstraintKind.Angle,
                        refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
                        datum: "tilt",
                    },
                ],
            },
        });
        doc.modelManager.addNode(node);
        const changeTilt = (degrees: number) =>
            Transaction.execute(doc, "Edit tilt", () =>
                doc.variables.setItems([{ ...variable, expression: String(degrees) }]),
            );
        const expectTilt = (editor: SketchEditor, degrees: number) => {
            const y = 10 * Math.sin((degrees * Math.PI) / 180);
            expect(doc.variables.evaluate().scope.get("tilt")?.value).toBe(degrees);
            expect(editor.solver.pointOf(end)[1]).toBeCloseTo(y, 6);
            expect(node.data.entities[0].params[3]).toBeCloseTo(y, 6);
        };
        changeTilt(-initial);
        expect(node.data.entities[0].params[3]).toBeCloseTo(-10 * Math.sin(radians), 6);
        const editor = SketchEditor.enter(node);
        const undoCount = doc.history.undoCount();
        doc.history.undo();
        expectTilt(editor, initial);
        expect(doc.history.undoCount()).toBe(undoCount - 1);
        expect(doc.history.redoCount()).toBe(1);
        if (redo) {
            doc.history.redo();
            expectTilt(editor, -initial);
            expect(doc.history.undoCount()).toBe(undoCount);
            expect(doc.history.redoCount()).toBe(0);
        }
        const restored = redo ? -initial : initial;
        const next = redo ? initial / 2 : -initial / 2;
        changeTilt(next);
        expectTilt(editor, next);
        doc.history.undo();
        expectTilt(editor, restored);
        // Reopen after replay with the restored parameter table.
        editor.exit();
        const reopened = SketchEditor.enter(node);
        expectTilt(reopened, restored);
        changeTilt(next);
        expectTilt(reopened, next);
        reopened.exit();
        expect(node.data.entities[0].params[3]).toBeCloseTo(10 * Math.sin((next * Math.PI) / 180), 6);
    } finally {
        SketchEditor.exit();
        restoreFactory();
        doc.dispose();
    }
});

const DATA: SketchData = {
    entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
    constraints: [],
};

test("text placement is one undo step and its outlines support selection, transforms and deletion", () => {
    const { doc, restoreFactory } = setup();
    Object.assign(shapeFactory, {
        bezier: () => Result.ok({ isEqual: () => false }),
        supportsBSplineEdges: true,
        bspline: () => Result.ok({ isEqual: () => false }),
        combine: () => Result.ok(new MockShape()),
    });
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
        const editor = SketchEditor.enter(node);
        const before = doc.history.undoCount();
        const added = editor.solver.addText({
            value: "Ao",
            x: 20,
            y: 10,
            height: 5,
            angle: 0,
            frame: { width: 30, height: 10 },
        });
        expect(added.isOk).toBe(true);
        editor.solve(true);
        editor.commit();
        expect(doc.history.undoCount()).toBe(before + 1);
        const placed = node.data;
        const ids = placed.texts!.map((text) => text.id);
        expect(ids.length).toBeGreaterThan(0);
        editor.selectEntities(ids);
        expect(editor.selectedEntityIds).toEqual(ids);
        const clipboard = copySketchSelection(placed, editor.selectedEntityIds);
        expect(clipboard.isOk).toBe(true);
        expect(clipboard.value.texts).toHaveLength(ids.length);
        expect(editor.applyTransform(ids, { kind: "move", delta: [5, 7] })).toBe(true);
        expect(node.data.entities[0]).toEqual(DATA.entities[0]);
        expect(node.data.texts![0].x).toBeCloseTo(placed.texts![0].x + 5, 10);
        doc.history.undo();
        expect(node.data).toEqual(placed);
        editor.deleteEntities(ids);
        expect(node.data).toEqual(DATA);
        expect(editor.solver.entities()).toEqual(DATA.entities);
        doc.history.undo();
        expect(node.data).toEqual(placed);
        doc.history.undo();
        expect(node.data).toEqual(DATA);
        expect(editor.solver.entities()).toEqual(DATA.entities);
        doc.history.redo();
        expect(node.data).toEqual(placed);
        editor.exit();
        const reopened = SketchEditor.enter(node);
        expect(reopened.solver.toData()).toEqual(placed);
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

describe("SketchEditor session statics", () => {
    afterEach(() => {
        rs.restoreAllMocks();
    });

    test("unchanged commits preserve stored JSON, geometry and history across key order and empty defaults", () => {
        const { doc, restoreFactory } = setup();
        Object.assign(shapeFactory, { combine: () => Result.ok(new MockShape()) });
        try {
            const node = new SketchNode({
                document: doc,
                plane: Plane.XY,
                dataJson: JSON.stringify({
                    anchors: [],
                    externalRefs: [],
                    refPositions: {},
                    constraints: [],
                    entities: [{ params: [0, 0, 10, 0], construction: false, type: "line", id: 1 }],
                }),
            });
            const stored = node.dataJson;
            const shape = node.shape;
            expect(shape.isOk).toBe(true);
            const revision = node.geometryRevision;
            const position = doc.history.position();
            const rebuild = rs.spyOn(node, "setDataEmitShapeChanged");
            for (let cycle = 0; cycle < 3; cycle++) {
                const editor = SketchEditor.enter(node);
                editor.commit();
                editor.exit();
            }
            expect(node.dataJson).toBe(stored);
            expect(node.shape).toBe(shape);
            expect(node.geometryRevision).toBe(revision);
            expect(doc.history.position()).toBe(position);
            expect(rebuild).not.toHaveBeenCalled();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("label-only commits undo and redo across sessions without invalidating geometry", () => {
        const { doc, restoreFactory } = setup();
        Object.assign(shapeFactory, { combine: () => Result.ok(new MockShape()) });
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 10,
            });
            editor.commit();
            const shape = node.shape;
            expect(shape.isOk).toBe(true);
            const revision = node.geometryRevision;
            const count = doc.history.undoCount();
            const rebuild = rs.spyOn(node, "setDataEmitShapeChanged");
            editor.dimensionAnchors.set(id, { kind: "offset", offset: 25 });
            editor.commit();
            expect(doc.history.undoCount()).toBe(count + 1);
            expect(node.data.anchors).toEqual([{ id, anchor: { kind: "offset", offset: 25 } }]);
            editor.exit();
            const reopened = SketchEditor.enter(node);
            doc.history.undo();
            expect(node.data.anchors).toBeUndefined();
            expect(reopened.dimensionAnchors.size).toBe(0);
            doc.history.redo();
            expect(reopened.dimensionAnchors.get(id)).toEqual({ kind: "offset", offset: 25 });
            expect(node.shape).toBe(shape);
            expect(node.geometryRevision).toBe(revision);
            expect(rebuild).not.toHaveBeenCalled();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a genuine coordinate edit still regenerates and records the sketch", () => {
        const { doc, restoreFactory } = setup();
        Object.assign(shapeFactory, { combine: () => Result.ok(new MockShape()) });
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const before = node.geometryRevision;
            const rebuild = rs.spyOn(node, "setDataEmitShapeChanged");
            editor.solver.reset({
                entities: [{ id: 1, type: "line", params: [0, 0, 20, 0] }],
                constraints: [],
            });
            editor.commit();
            expect(rebuild).toHaveBeenCalledTimes(1);
            expect(node.data.entities[0].params).toEqual([0, 0, 20, 0]);
            expect(node.geometryRevision).toBeGreaterThan(before);
            doc.history.undo();
            expect(node.data.entities[0].params).toEqual([0, 0, 10, 0]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("enter returns the editor and makes it the active editor", () => {
        const { doc, view, camera, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);

            expect(SketchEditor.getActive()).toBe(editor);
            expect(SketchEditor.getActive()).toBe(editor);
            expect(camera.lookAt).toHaveBeenCalledTimes(1);
            const [eye, target] = camera.lookAt.mock.calls[0] as unknown as [XYZ, XYZ];
            const distance = camera.cameraPosition.distanceTo(camera.cameraTarget);
            expect(eye.x).toBeCloseTo(0, 6);
            expect(eye.y).toBeCloseTo(0, 6);
            expect(eye.z).toBeCloseTo(distance, 6);
            expect(target.x).toBe(0);
            expect(camera.cameraType).toBe("orthographic");
            expect(camera.fitContent).toHaveBeenCalledTimes(1);
            expect(view.workplane).toBe(node.plane);
            expect(doc.visual.eventHandler).toBeInstanceOf(SketchEventHandler);
            expect((doc.visual.viewHandler as any).canRotate).toBe(false);
            editor.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("enter clears the current selection highlight", () => {
        const { doc, clearSelection, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);

            expect(clearSelection).toHaveBeenCalledTimes(1);
            editor.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a session holds autosave (bodies are rolled back) until it ends", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            expect(AutosaveHolds.isHeld).toBe(false);

            const editor = SketchEditor.enter(node);
            expect(AutosaveHolds.isHeld).toBe(true);

            editor.exit();
            expect(AutosaveHolds.isHeld).toBe(false);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("an enter that fails after the session started releases its autosave hold", () => {
        const { app, doc, restoreFactory } = setup();
        (app as { mainWindow: unknown }).mainWindow = {
            ribbon: {
                openTab: () => {
                    throw new Error("no ribbon");
                },
                closeTab: () => {},
            },
        };
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });

            expect(() => SketchEditor.enter(node)).toThrow("no ribbon");

            expect(AutosaveHolds.isHeld).toBe(false);
        } finally {
            (app as { mainWindow: unknown }).mainWindow = undefined;
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("entering a second sketch exits the first one", () => {
        const { doc, restoreFactory } = setup();
        try {
            const n1 = new SketchNode({ document: doc, plane: Plane.XY });
            const n2 = new SketchNode({ document: doc, plane: Plane.YZ });
            const first = SketchEditor.enter(n1);
            const exitSpy = rs.spyOn(first, "exit");

            const second = SketchEditor.enter(n2);

            expect(exitSpy).toHaveBeenCalledTimes(1);
            expect(SketchEditor.getActive()).toBe(second);
            expect(SketchEditor.getActive()).not.toBe(first);
            second.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("editing forces a hidden sketch visible and exit restores the previous visibility", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            node.visible = false; // a consumed sketch
            const undoCount = doc.history.undoCount();

            const editor = SketchEditor.enter(node);
            expect(node.visible).toBe(true);

            editor.exit();
            expect(node.visible).toBe(false);
            // The visibility round-trip of an edit session stays out of the undo history.
            expect(doc.history.undoCount()).toBe(undoCount);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("editing renders the sketch on top and exit restores normal rendering", () => {
        const { doc, setNodeOnTop, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });

            const editor = SketchEditor.enter(node);
            expect(setNodeOnTop).toHaveBeenCalledWith([node], true);

            editor.exit();
            expect(setNodeOnTop).toHaveBeenLastCalledWith([node], false);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("editor.exit commits node data and restores camera, workplane, handler", () => {
        const { doc, view, camera, oldHandler, restoreFactory } = setup();
        try {
            const oldWorkplane = view.workplane;
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.exit();

            expect(SketchEditor.getActive()).toBeUndefined();
            expect(SketchEditor.getActive()).toBeUndefined();
            expect(node.data.entities).toEqual([{ id: 1, type: "line", params: [0, 0, 10, 0] }]);
            expect(doc.visual.eventHandler).toBe(oldHandler);
            expect(view.workplane).toBe(oldWorkplane);
            expect(camera.cameraType).toBe("perspective");
            expect(camera.lookAt).toHaveBeenCalledTimes(2);
            expect((doc.visual.viewHandler as any).canRotate).toBe(true);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("without a session getActive is undefined and exit is a no-op", () => {
        const { restoreFactory } = setup();
        try {
            expect(SketchEditor.getActive()).toBeUndefined();
            SketchEditor.exit();
            expect(SketchEditor.getActive()).toBeUndefined();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("dimension anchors are committed to node data and restored on re-enter", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 10,
            });
            editor.dimensionAnchors.set(id, { kind: "offset", offset: 25 });
            editor.exit();

            expect(node.data.anchors).toEqual([{ id, anchor: { kind: "offset", offset: 25 } }]);

            const reopened = SketchEditor.enter(node);
            expect(reopened.dimensionAnchors.get(id)).toEqual({ kind: "offset", offset: 25 });
            reopened.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("anchors of deleted constraints are dropped on re-enter", () => {
        const { doc, restoreFactory } = setup();
        try {
            const data: SketchData = {
                entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
                constraints: [],
                anchors: [{ id: 99, anchor: { kind: "offset", offset: 25 } }],
            };
            const node = new SketchNode({ document: doc, plane: Plane.XY, data });

            const editor = SketchEditor.enter(node);

            expect(editor.dimensionAnchors.size).toBe(0);
            editor.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("undo/redo during a session resyncs solver and anchors from node data", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 10,
            });
            editor.dimensionAnchors.set(id, { kind: "offset", offset: 25 });
            editor.commit();
            expect(editor.solver.toData().constraints.length).toBe(1);

            doc.history.undo();
            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.dimensionAnchors.size).toBe(0);

            doc.history.redo();
            expect(editor.solver.toData().constraints.length).toBe(1);
            expect(editor.dimensionAnchors.get(id)).toEqual({ kind: "offset", offset: 25 });
            editor.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a type-flipped external ref drops its constraints, their anchors, and warns", () => {
        const { doc, restoreFactory } = setup();
        try {
            const data: SketchData = {
                entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
                constraints: [],
                externalRefs: [
                    {
                        entityId: -100,
                        nodeId: "missing-src",
                        edge: {
                            kind: "line",
                            start: { x: 0, y: 5, z: 0 },
                            end: { x: 10, y: 5, z: 0 },
                        },
                        role: "reference",
                        snapshot: [0, 5, 10, 5],
                        type: "line",
                    },
                ],
            };
            const node = new SketchNode({ document: doc, plane: Plane.XY, data });
            const editor = SketchEditor.enter(node);
            const constraintId = editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: -100, pointIndex: 0 },
                ],
            });
            editor.dimensionAnchors.set(constraintId, { kind: "offset", offset: 25 });
            const pub = rs.spyOn(PubSub.default, "pub");

            // the same ref comes back with a different entity type (line → circle):
            // the reseed cascades its constraints away untransacted
            node.setDataEmitShapeChanged({
                entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
                constraints: [],
                externalRefs: [
                    {
                        entityId: -100,
                        nodeId: "missing-src",
                        edge: {
                            kind: "circle",
                            center: { x: 5, y: 5, z: 0 },
                            radius: 3,
                            axis: { x: 0, y: 0, z: 1 },
                        },
                        role: "reference",
                        snapshot: [5, 5, 3],
                        type: "circle",
                    },
                ],
            });

            expect(editor.solver.toData().constraints).toEqual([]);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(pub).toHaveBeenCalledWith("statusBarTip", "sketch.externalRefTypeChanged");
            editor.exit();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a failed truncated replay reverts that body's rollback and warns", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            doc.modelManager.addNode(node);
            // The sketch is consumed at feature index 1, but feature 0 cannot replay
            // (its sketch is gone): rolling back to the sketch's timeline position
            // fails, so the body must stay on the full chain instead of letting
            // plane/external-ref resolution read the later geometry as capture-time.
            const body = new ParametricBodyNode({
                document: doc,
                features: [
                    { id: "e0", type: "extrude", sketchId: "missing-sketch", depth: 10 },
                    { id: "e1", type: "extrude", sketchId: node.id, depth: 10 },
                ],
            });
            doc.modelManager.addNode(body);
            const pub = rs.spyOn(PubSub.default, "pub");

            const editor = SketchEditor.enter(node);

            expect(body.rollbackIndex).toBeUndefined();
            expect(pub).toHaveBeenCalledWith("statusBarTip", "sketch.rollbackFailed");
            editor.exit();
            expect(body.rollbackIndex).toBeUndefined();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a throwing rollback body is reverted in place and the session still starts", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            doc.modelManager.addNode(node);
            const makeBody = (id: string) => {
                const body = new ParametricBodyNode({
                    document: doc,
                    features: [{ id: `${id}-e0`, type: "extrude", sketchId: node.id, depth: 10 }],
                });
                doc.modelManager.addNode(body);
                return body;
            };
            const good = makeBody("good");
            const bad = makeBody("bad");
            const goodCalls: (number | undefined)[] = [];
            good.setRollbackIndex = (index) => {
                goodCalls.push(index);
                return true;
            };
            const badCalls: (number | undefined)[] = [];
            bad.setRollbackIndex = (index) => {
                badCalls.push(index);
                if (index !== undefined) throw new Error("rebuild exploded");
                return true;
            };
            const pub = rs.spyOn(PubSub.default, "pub");

            // The throwing body must not strand `good` (already rolled back) by
            // escaping before the rollback map reaches startSession's catch.
            const editor = SketchEditor.enter(node);

            expect(goodCalls).toEqual([0]);
            expect(badCalls).toEqual([0, undefined]);
            expect(pub).toHaveBeenCalledWith("statusBarTip", "sketch.rollbackFailed");
            expect(node.editingSession).toBe(true);

            editor.exit();
            expect(goodCalls).toEqual([0, undefined]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a throwing statusBarTip subscriber does not strand the rollback handoff", () => {
        const { doc, restoreFactory } = setup();
        // PubSub.pub isolates subscriber exceptions globally: the rollbackFailed
        // tip's subscriber throws here; pub must log the error, keep the other
        // tips flowing, and return normally so the rollback map still reaches
        // startSession.
        const consoleError = rs.spyOn(console, "error").mockImplementation(() => {});
        const subscriber = (tip: string) => {
            if (tip === "sketch.rollbackFailed") throw new Error("subscriber exploded");
        };
        PubSub.default.sub("statusBarTip", subscriber);
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            doc.modelManager.addNode(node);
            const makeBody = (id: string) => {
                const body = new ParametricBodyNode({
                    document: doc,
                    features: [{ id: `${id}-e0`, type: "extrude", sketchId: node.id, depth: 10 }],
                });
                doc.modelManager.addNode(body);
                return body;
            };
            const good = makeBody("good");
            const bad = makeBody("bad");
            const goodCalls: (number | undefined)[] = [];
            good.setRollbackIndex = (index) => {
                goodCalls.push(index);
                return true;
            };
            bad.setRollbackIndex = (index) => {
                if (index !== undefined) throw new Error("rebuild exploded");
                return true;
            };

            // The failing body triggers the rollbackFailed tip; its subscriber throwing
            // must not escape applyTimelineRollback — otherwise startSession's catch
            // would see no rollback map and strand `good` in its truncated state.
            const editor = SketchEditor.enter(node);

            expect(goodCalls).toEqual([0]);
            expect(node.editingSession).toBe(true);
            expect(consoleError).toHaveBeenCalledWith(
                'PubSub: a subscriber of "statusBarTip" threw',
                expect.any(Error),
            );

            editor.exit();
            expect(goodCalls).toEqual([0, undefined]);
        } finally {
            SketchEditor.exit();
            PubSub.default.remove("statusBarTip", subscriber);
            restoreFactory();
        }
    });

    test("a constructor failure after the session starts unwinds the whole session", () => {
        const { doc, view, camera, oldHandler, setNodeOnTop, restoreFactory } = setup();
        // the editor's own solve is the last stateful constructor step (the solver's
        // internal initial solve happens earlier, inside startSession)
        rs.spyOn(SketchEditor.prototype, "solve").mockImplementation(() => {
            throw new Error("solver exploded");
        });
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            node.visible = false; // a consumed sketch
            doc.modelManager.addNode(node);
            const body = new ParametricBodyNode({
                document: doc,
                features: [{ id: "e0", type: "extrude", sketchId: node.id, depth: 10 }],
            });
            doc.modelManager.addNode(body);
            const bodyCalls: (number | undefined)[] = [];
            body.setRollbackIndex = (index) => {
                bodyCalls.push(index);
                return true;
            };
            const oldWorkplane = view.workplane;

            // solve() is the last stateful constructor step; activeEditor is never
            // published, so the constructor itself must undo every earlier step.
            expect(() => SketchEditor.enter(node)).toThrow("solver exploded");

            expect(SketchEditor.getActive()).toBeUndefined();
            expect(node.editingSession).toBe(false);
            expect(bodyCalls).toEqual([0, undefined]);
            expect(camera.cameraType).toBe("perspective");
            expect(view.workplane).toBe(oldWorkplane);
            expect(doc.visual.eventHandler).toBe(oldHandler);
            expect((doc.visual.viewHandler as any).canRotate).toBe(true);
            expect(setNodeOnTop).toHaveBeenLastCalledWith([node], false);
            expect(node.visible).toBe(false);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("exit exits the active session", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            SketchEditor.enter(node);

            SketchEditor.exit();

            expect(SketchEditor.getActive()).toBeUndefined();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("exit with a throwing commit still completes the session teardown", () => {
        const { doc, oldHandler, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            node.visible = false; // a consumed sketch
            const editor = SketchEditor.enter(node);
            rs.spyOn(editor, "commit").mockImplementation(() => {
                throw new Error("commit exploded");
            });

            expect(() => editor.exit()).toThrow("commit exploded");

            // the teardown must not be stranded by the commit failure
            expect(SketchEditor.getActive()).toBeUndefined();
            expect((editor as any).disposed).toBe(true);
            expect(node.editingSession).toBe(false);
            expect(node.showProfileFaces).toBe(true);
            expect(node.visible).toBe(false);
            expect(doc.visual.eventHandler).toBe(oldHandler);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("dispose restores later bodies when an earlier body's restore throws", () => {
        const { doc, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            doc.modelManager.addNode(node);
            const makeBody = (id: string) => {
                const body = new ParametricBodyNode({
                    document: doc,
                    features: [{ id: `${id}-e0`, type: "extrude", sketchId: node.id, depth: 10 }],
                });
                doc.modelManager.addNode(body);
                return body;
            };
            // restore order is insertion order for unrelated bodies, so bad
            // restores first and its throw must not strand good
            const bad = makeBody("bad");
            const good = makeBody("good");
            const badCalls: (number | undefined)[] = [];
            const goodCalls: (number | undefined)[] = [];
            bad.setRollbackIndex = (index) => {
                badCalls.push(index);
                if (index === undefined) throw new Error("restore exploded");
                return true;
            };
            good.setRollbackIndex = (index) => {
                goodCalls.push(index);
                return true;
            };

            const editor = SketchEditor.enter(node);
            expect(badCalls).toEqual([0]);
            expect(goodCalls).toEqual([0]);

            editor.exit();

            expect(badCalls).toEqual([0, undefined]);
            expect(goodCalls).toEqual([0, undefined]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });
});

test("control settings confirm/cancel and pole dragging are separate undoable editor commits", () => {
    const { doc, restoreFactory } = setup();
    const factory = shapeFactory as any;
    factory.supportsBSplineEdges = true;
    factory.bspline = () => Result.ok({ isEqual: () => false });
    const originalPub = PubSub.default.pub;
    let dialog: { content: HTMLElement; buttons: any[] } | undefined;
    PubSub.default.pub = ((topic: string, ...args: any[]) => {
        if (topic === "showDialog") dialog = { content: args[1], buttons: args[2] };
        else (originalPub as any).call(PubSub.default, topic, ...args);
    }) as typeof originalPub;
    try {
        const data: SketchData = {
            entities: [
                {
                    id: 1,
                    type: "bspline",
                    params: [1, 0, 1, 1, 0, 1],
                    control: {
                        degree: 2,
                        knots: [0, 1],
                        multiplicities: [3, 3],
                        weights: [1, Math.SQRT1_2, 1],
                    },
                },
            ],
            constraints: [],
        };
        const node = new SketchNode({ document: doc, plane: Plane.XY, data });
        const editor = SketchEditor.enter(node);
        const count = doc.history.undoCount();
        promptControlBSpline(editor, 1);
        expect(dialog).not.toBeUndefined();
        const weights = dialog!.content.querySelector<HTMLInputElement>('[name="weights"]');
        expect(weights).not.toBeNull();
        weights!.value = "1, 0, 1";
        expect(dialog!.buttons[0].shouldClose()).toBe(false);
        expect(node.data).toEqual(data);
        weights!.value = "1, 1, 1";
        dialog!.buttons[1].onclick();
        expect(doc.history.undoCount()).toBe(count);
        promptControlBSpline(editor, 1);
        const next = dialog!.content.querySelector<HTMLInputElement>('[name="weights"]');
        expect(next).not.toBeNull();
        next!.value = "1, 1, 1";
        expect(dialog!.buttons[0].shouldClose()).toBe(true);
        expect(node.data.entities[0].control?.weights).toEqual([1, 1, 1]);
        expect(doc.history.undoCount()).toBe(count + 1);
        editor.solver.setPointPosition({ entityId: 1, pointIndex: 1 }, 2, 3);
        editor.solve(true);
        editor.commit();
        expect(node.data.entities[0].params).toEqual([1, 0, 2, 3, 0, 1]);
        doc.history.undo();
        expect(editor.solver.entity(1)?.params).toEqual(data.entities[0].params);
        expect(editor.solver.entity(1)?.control?.weights).toEqual([1, 1, 1]);
        doc.history.undo();
        expect(node.data).toEqual(data);
        expect(editor.solver.entity(1)?.control).toEqual(data.entities[0].control);
        doc.history.redo();
        doc.history.redo();
        expect(editor.solver.entity(1)?.params).toEqual([1, 0, 2, 3, 0, 1]);
    } finally {
        PubSub.default.pub = originalPub;
        SketchEditor.exit();
        restoreFactory();
    }
});

test("text rotation handle previews, cancels and commits as one undo step", () => {
    const { doc, view, restoreFactory } = setup();
    Object.assign(shapeFactory, {
        bezier: () => Result.ok({ isEqual: () => false }),
        combine: () => Result.ok(new MockShape()),
    });
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
        const editor = SketchEditor.enter(node);
        const added = editor.solver.addText({
            value: "H",
            x: 20,
            y: 20,
            height: 5,
            angle: 0,
            frame: { width: 20, height: 10 },
        });
        expect(added.isOk).toBe(true);
        editor.commit();
        editor.selectEntities([added.value]);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const uv = rs.spyOn(handler as any, "pointerToUV");
        rs.spyOn(handler as any, "worldTolerance").mockReturnValue(0.5);
        const before = doc.history.undoCount(),
            initial = node.data;
        uv.mockReturnValue([30, 35]);
        handler.pointerDown(view, new PointerEvent("pointerdown", { button: 0 }));
        uv.mockReturnValue([5, 30]);
        handler.pointerMove(view, new PointerEvent("pointermove"));
        expect(editor.annotations.hasGeometryPreview).toBe(true);
        expect(node.data).toEqual(initial);
        handler.keyDown(view, new KeyboardEvent("keydown", { key: "Escape" }));
        expect(editor.annotations.hasGeometryPreview).toBe(false);
        expect(doc.history.undoCount()).toBe(before);
        uv.mockReturnValue([30, 35]);
        handler.pointerDown(view, new PointerEvent("pointerdown", { button: 0 }));
        uv.mockReturnValue([5, 30]);
        handler.pointerMove(view, new PointerEvent("pointermove"));
        handler.pointerUp(view, new PointerEvent("pointerup"));
        expect(node.data.texts![0].angle).toBeCloseTo(90, 8);
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        expect(node.data).toEqual(initial);
    } finally {
        rs.restoreAllMocks();
        SketchEditor.exit();
        restoreFactory();
    }
});

test("explicit text defaults do not rewrite an unchanged saved record or create history", () => {
    const { doc, restoreFactory } = setup();
    Object.assign(shapeFactory, {
        bezier: () => Result.ok({ isEqual: () => false }),
        combine: () => Result.ok(new MockShape()),
    });
    try {
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [],
                constraints: [],
                texts: [
                    {
                        id: 50,
                        value: "H",
                        x: 0,
                        y: 0,
                        height: 5,
                        angle: 0,
                        frame: { width: 20, height: 10 },
                        profileIds: [51],
                    },
                ],
            },
        });
        const editor = SketchEditor.enter(node),
            before = doc.history.position(),
            stored = node.dataJson;
        expect(
            editor.solver.updateText(50, {
                font: "sans",
                alignment: "left",
                verticalAlignment: "bottom",
                spacing: 0,
                flipHorizontal: false,
                flipVertical: false,
            }).isOk,
        ).toBe(true);
        editor.commit();
        expect(node.dataJson).toBe(stored);
        expect(doc.history.position()).toBe(before);
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test("text prompt translates errors and rejects blank number fields", () => {
    const { doc, restoreFactory } = setup();
    const originalPub = PubSub.default.pub;
    let dialog: { content: HTMLElement; buttons: any[] } | undefined;
    PubSub.default.pub = ((topic: string, ...args: any[]) => {
        if (topic === "showDialog") dialog = { content: args[1], buttons: args[2] };
        else (originalPub as any).call(PubSub.default, topic, ...args);
    }) as typeof originalPub;
    try {
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: { entities: [], constraints: [] },
        });
        const editor = SketchEditor.enter(node);
        promptSketchText(editor, {
            value: "A",
            x: 0,
            y: 0,
            height: 5,
            angle: 0,
            frame: { width: 20, height: 10 },
        } as any);
        expect(dialog).not.toBeUndefined();
        const field = (name: string) => dialog!.content.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        const message = dialog!.content.querySelector("p")!;
        field("x").value = "";
        field("x").dispatchEvent(new Event("input", { bubbles: true }));
        expect(message.textContent).toBe(I18n.translate("error.sketch.invalidTextSize"));
        expect(dialog!.buttons[0].shouldClose()).toBe(false);
        expect(message.textContent).toBe(I18n.translate("error.sketch.invalidTextSize"));
        expect(editor.solver.texts()).toHaveLength(0);
    } finally {
        PubSub.default.pub = originalPub;
        SketchEditor.exit();
        restoreFactory();
    }
});
