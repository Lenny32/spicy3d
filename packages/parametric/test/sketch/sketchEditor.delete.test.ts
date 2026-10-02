// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type ICameraController, Plane, Result, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { ConstructionConstraintCommand } from "../../src/sketch/commands/sketchConstraints";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

function setup() {
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitY,
        cameraType: "perspective" as "perspective" | "orthographic",
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: rs.fn() } as any });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const view = createMockView({ document: doc, cameraController: camera as unknown as ICameraController });
    (app as any).activeView = view;

    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
            combine: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    const restoreFactory = () => {
        if (previous) {
            Object.defineProperty(globalThis, "shapeFactory", previous);
        } else {
            delete (globalThis as any).shapeFactory;
        }
    };
    return { doc, view, restoreFactory };
}

function pointerEvent(x: number, y: number): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0 } as PointerEvent;
}

describe("SketchEditor entity deletion", () => {
    test("Delete removes the hovered entity with its constraints and anchors", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            const constraintId = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 10,
            });
            editor.dimensionAnchors.set(constraintId, { kind: "offset", offset: 20 });
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            // hover the line, then delete it (mock view: screen (405, 300) -> uv (5, 0))
            handler.pointerMove(view, pointerEvent(405, 300));
            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Delete" }));

            expect(editor.solver.entities()).toEqual([]);
            expect(editor.solver.toData().constraints).toEqual([]);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(node.data.entities).toEqual([]);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Delete without a hover highlight does nothing", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);

            (doc.visual.eventHandler as SketchEventHandler).keyDown(
                view,
                new KeyboardEvent("keydown", { key: "Delete" }),
            );
            expect(editor.solver.entities().length).toBe(1);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Delete is ignored while a pick is active", async () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerMove(view, pointerEvent(405, 300));
            const promise = editor.pickEntity("prompt.pickSketchEntity", "line");
            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Backspace" }));
            expect(editor.solver.entities().length).toBe(1);

            editor.cancelPick();
            await expect(promise).resolves.toBeUndefined();
            editor.exit();
        } finally {
            restoreFactory();
        }
    });
});

test("offset targets can be hovered, selected, construction-toggled and deleted but never dragged", async () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 100, 0] },
                    { id: 2, type: "line", params: [0, 20, 100, 20], derivation: "offset" },
                ],
                constraints: [
                    {
                        id: 30,
                        kind: ConstraintKind.Offset,
                        datum: 20,
                        refs: [1, 2].map((entityId) => ({ entityId, pointIndex: 0 })),
                    },
                ],
            },
        });
        const editor = SketchEditor.enter(node);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const target = editor.solver.entity(2)!;
        const beginDrag = rs.spyOn(editor.solver, "beginDrag");
        // Even a click on its endpoint selects the target without entering a drag.
        handler.pointerDown(view, pointerEvent(400, 280));
        handler.pointerMove(view, pointerEvent(410, 270));
        handler.pointerUp(view, pointerEvent(410, 270));
        expect(beginDrag).not.toHaveBeenCalled();
        expect(editor.selectedEntityIds).toEqual([2]);
        expect(editor.solver.entity(2)).toEqual(target);
        expect(() => editor.solver.setPointPosition({ entityId: 2, pointIndex: 0 }, 3, 4)).toThrow(/Detach/);
        const command = new ConstructionConstraintCommand();
        await command.execute(doc.application);
        expect(editor.solver.entity(2)!.construction).toBe(true);
        expect(node.data.entities[1].construction).toBe(true);
        expect(editor.solver.toData().constraints).toHaveLength(1);
        handler.pointerMove(view, pointerEvent(450, 280));
        handler.keyDown(view, new KeyboardEvent("keydown", { key: "Delete" }));
        expect(editor.solver.entities().map((e) => e.id)).toEqual([1]);
        expect(node.data.constraints).toEqual([]);
        expect(node.data.entities.map((e) => e.id)).toEqual([1]);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
        rs.restoreAllMocks();
    }
});

test("construction pick includes offset targets while ordinary constraint picks exclude them", async () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 100, 0] },
                    { id: 2, type: "line", params: [0, 20, 100, 20], derivation: "offset" },
                ],
                constraints: [
                    {
                        id: 30,
                        kind: ConstraintKind.Offset,
                        datum: 20,
                        refs: [1, 2].map((entityId) => ({ entityId, pointIndex: 0 })),
                    },
                ],
            },
        });
        const editor = SketchEditor.enter(node);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const ordinary = editor.pickEntity("prompt.pickSketchEntity");
        expect(handler.hitTestEntity(view, pointerEvent(450, 280))).toBeUndefined();
        editor.cancelPick();
        await expect(ordinary).resolves.toBeUndefined();
        const command = new ConstructionConstraintCommand();
        const running = command.execute(doc.application);
        expect(handler.hitTestEntity(view, pointerEvent(450, 280))).toBe(2);
        handler.pointerDown(view, pointerEvent(450, 280));
        await running;
        expect(editor.solver.entity(2)!.construction).toBe(true);
        expect(node.data.constraints).toHaveLength(1);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test("editor variable failure warns even when cached geometry and commit are unchanged", () => {
    const { doc, restoreFactory } = setup();
    const variables = (gap: number) => [
        { id: "gap", name: "gap", expression: String(gap), type: "length" as const },
    ];
    try {
        doc.variables.setItems(variables(2));
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "circle", params: [0, 0, 10], construction: true },
                    { id: 2, type: "circle", params: [0, 0, 12], derivation: "offset" },
                ],
                constraints: [
                    {
                        id: 30,
                        kind: ConstraintKind.Offset,
                        datum: "gap",
                        refs: [1, 2].map((entityId) => ({ entityId, pointIndex: 0 })),
                    },
                ],
            },
        });
        doc.modelManager.addNode(node);
        const editor = SketchEditor.enter(node);
        const before = node.dataJson;
        doc.variables.setItems(variables(-50));
        expect(node.shape.isOk).toBe(true);
        expect(node.dataJson).toBe(before);
        expect(node.warningCount).toBe(1);
        expect(node.offsetWarnings[0]).toMatch(/Offset constraint 30:.*collapse/);
        editor.exit();
        expect(node.shape.isOk).toBe(true);
        expect(node.warningCount).toBe(1);
        doc.variables.setItems(variables(3));
        expect(node.shape.isOk).toBe(true);
        expect(node.warningCount).toBe(0);
        expect(node.data.entities[1].params).toEqual([0, 0, 13]);
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});
