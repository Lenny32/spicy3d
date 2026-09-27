// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type DialogButton,
    type I18nKeys,
    type ICameraController,
    Plane,
    PubSub,
    Result,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import {
    AngleDimensionCommand,
    DistanceDimensionCommand,
    HorizontalDistanceCommand,
    PointLineDistanceCommand,
    RadiusDimensionCommand,
    VerticalDistanceCommand,
} from "../../src/sketch/commands/sketchDimensions";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { ConstraintKind, SKETCH_X_AXIS_ID } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

type DialogCapture = {
    title?: I18nKeys;
    content?: HTMLElement;
    buttons?: DialogButton[] | (() => void);
};

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

    const dialog: DialogCapture = {};
    const originalPub = PubSub.default.pub as unknown as (key: string, ...args: any[]) => void;
    PubSub.default.pub = ((key: string, ...args: any[]) => {
        if (key === "showDialog") {
            [dialog.title, dialog.content, dialog.buttons] = args as [
                I18nKeys,
                HTMLElement,
                DialogButton[] | (() => void),
            ];
            return;
        }
        originalPub.call(PubSub.default, key, ...args);
    }) as any;
    const restorePub = () => {
        PubSub.default.pub = originalPub as any;
    };

    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            arc: () => Result.ok({ isEqual: () => false }),
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
    return { app, doc, view, dialog, restorePub, restoreFactory };
}

function dialogInput(dialog: DialogCapture): HTMLInputElement {
    const el = dialog.content?.querySelector("input");
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
}

/** Simulates confirming the dialog; returns whether the dialog would close. */
function confirmDialog(dialog: DialogCapture, text: string): boolean {
    const buttons = dialog.buttons as DialogButton[];
    const confirm = buttons.find((b) => b.content === "common.confirm");
    expect(confirm).toBeDefined();
    dialogInput(dialog).value = text;
    const shouldClose = confirm!.shouldClose?.() !== false;
    if (shouldClose) confirm!.onclick?.();
    return shouldClose;
}

function pointerEvent(x: number, y: number): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0, shiftKey: false } as PointerEvent;
}

/** Lets the command's awaited picks advance between simulated clicks. */
async function tick() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Runs the distance command through its three picks (point, point, position). */
async function placeDistanceDimension(app: any, doc: any, view: any): Promise<void> {
    const handler = doc.visual.eventHandler as SketchEventHandler;
    const run = new DistanceDimensionCommand().execute(app);
    handler.pointerDown(view, pointerEvent(400, 300));
    await tick();
    handler.pointerDown(view, pointerEvent(500, 300));
    await tick();
    handler.pointerDown(view, pointerEvent(450, 250));
    await run;
}

function cancelDialog(dialog: DialogCapture): void {
    const buttons = dialog.buttons as DialogButton[];
    const cancel = buttons.find((b) => b.content === "common.cancel");
    expect(cancel).toBeDefined();
    cancel!.onclick?.();
}

// mock view maps screen (x, y) -> world (x - 400, 300 - y, 0) on the XY plane:
// a line (0,0)-(100,0) spans screen x 400..500 at y 300
describe("dimension commands", () => {
    test("distance constraint is created at placement, before the dialog is confirmed", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            // the dimension exists and the dialog is open — before any confirm
            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2PDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            // not committed to the node (and history) until the dialog is confirmed
            expect(node.data.constraints.length).toBe(0);

            // confirming the dialog only updates the datum
            expect(confirmDialog(dialog, "80")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(80);

            // invalid input keeps the dialog open and the current value
            expect(confirmDialog(dialog, "abc")).toBe(false);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(80);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on a clicked line dimensions its length", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const line = editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // the middle of the line (away from both endpoints), then a label position
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2PDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: line, pointIndex: 0 },
                { entityId: line, pointIndex: 1 },
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on a clicked circle dimensions its radius", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addCircle(0, 0, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // circle rim at world (30, 0) -> screen (430, 300)
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(430, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Radius);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension from a point to a clicked line is a point-line distance", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addCircle(50, 30, 10);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // circle center (450, 330), the middle of the line, then a label position
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 330));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(470, 280));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2LDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: 2, pointIndex: 0 },
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on two clicked lines dimensions their angle", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const horizontal = editor.solver.addLine(0, 0, 100, 0);
            const vertical = editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // the middle of each line (screen (450, 300) and (400, 250)), then a label position
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("90.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(constraints[0].refs.map((r) => r.entityId)).toEqual([
                horizontal,
                horizontal,
                vertical,
                vertical,
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test.each([
        // between the two lines' drawing directions: the 60° sector
        { name: "between the lines", x: 470, y: 280, display: "60.00", reversed: [false, false] },
        // across the second line, towards the reversed first line: the 120° sector
        { name: "beside the second line", x: 360, y: 270, display: "120.00", reversed: [true, false] },
        // opposite the 60° sector: 60° again, with both lines reversed
        { name: "opposite", x: 360, y: 330, display: "60.00", reversed: [true, true] },
    ])("angle dimension measures the sector the label is placed in ($name)", async ({
        x,
        y,
        display,
        reversed,
    }) => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const horizontal = editor.solver.addLine(0, 0, 100, 0);
            const slanted = editor.solver.addLine(0, 0, 50, 50 * Math.sqrt(3));
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // the middle of each line: (50, 0) -> screen (450, 300); (25, 43.3) -> (425, 256.7)
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(425, 256.7));
            await tick();
            handler.pointerDown(view, pointerEvent(x, y));
            await run;

            expect(dialogInput(dialog).value).toBe(display);
            const [constraint] = editor.solver.toData().constraints;
            expect(constraint.kind).toBe(ConstraintKind.Angle);
            const order = (id: number, flip: boolean) => [
                { entityId: id, pointIndex: flip ? 1 : 0 },
                { entityId: id, pointIndex: flip ? 0 : 1 },
            ];
            expect(constraint.refs).toEqual([
                ...order(horizontal, reversed[0]),
                ...order(slanted, reversed[1]),
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on two parallel lines dimensions the gap between them", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const bottom = editor.solver.addLine(0, 0, 100, 0);
            const top = editor.solver.addLine(0, 40, 100, 40);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 260));
            await tick();
            handler.pointerDown(view, pointerEvent(520, 280));
            await run;

            expect(dialogInput(dialog).value).toBe("40.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2LDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: top, pointIndex: 0 },
                { entityId: bottom, pointIndex: 0 },
                { entityId: bottom, pointIndex: 1 },
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on two preselected lines goes straight to placing their angle", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const horizontal = editor.solver.addLine(0, 0, 100, 0);
            const vertical = editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            editor.selectEntities([horizontal, vertical]);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // the only click places the label
            const run = new DistanceDimensionCommand().execute(app);
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("90.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(editor.selectedEntityIds).toEqual([]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension on a preselected point and line places their distance", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const line = editor.solver.addLine(0, 0, 100, 0);
            const point = editor.solver.addPoint(50, 30);
            editor.solve(true);
            editor.selectEntities([point, line]);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new DistanceDimensionCommand().execute(app);
            await tick();
            handler.pointerDown(view, pointerEvent(470, 280));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2LDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: point, pointIndex: 0 },
                { entityId: line, pointIndex: 0 },
                { entityId: line, pointIndex: 1 },
            ]);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension treats one preselected line as the first pick", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const line = editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            editor.selectEntities([line]);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // a click on empty space places the line's length
            const run = new DistanceDimensionCommand().execute(app);
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2PDistance);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("distance dimension ignores a second click on the line already picked", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(460, 300));
            await tick();
            expect(editor.solver.toData().constraints.length).toBe(0);
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            expect(editor.solver.toData().constraints[0].kind).toBe(ConstraintKind.P2PDistance);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editDatum re-opens the dialog with the current value and updates it", () => {
        const { doc, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 100,
            });
            editor.solve(true);

            editor.editDatum(id);
            expect(dialogInput(dialog).value).toBe("100.00");
            expect(confirmDialog(dialog, "75")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(75);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editDatum shows and reads a length in the project unit", () => {
        const { doc, dialog, restorePub, restoreFactory } = setup();
        try {
            doc.settings.lengthUnit = "cm";
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 100,
            });
            editor.solve(true);

            editor.editDatum(id);
            expect(dialogInput(dialog).value).toBe("10");
            expect(dialog.content?.textContent).toContain("cm");
            // 7.5 cm is 75 mm; `1 in` would be 25.4 mm whatever the project unit.
            expect(confirmDialog(dialog, "7.5")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(75);

            editor.editDatum(id);
            expect(confirmDialog(dialog, "1 in")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(25.4);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editDatum confirmed unchanged keeps the exact stored length", () => {
        const { doc, dialog, restorePub, restoreFactory } = setup();
        try {
            doc.settings.lengthUnit = "in";
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 100,
            });
            editor.solve(true);

            for (let i = 0; i < 5; i++) {
                editor.editDatum(id);
                expect(confirmDialog(dialog, dialogInput(dialog).value)).toBe(true);
            }
            expect(editor.solver.toData().constraints[0].datum).toBe(100);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("radius constraint is created at placement, before the dialog is confirmed", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addCircle(0, 0, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new RadiusDimensionCommand().execute(app);
            // circle rim at world (30, 0) -> screen (430, 300)
            handler.pointerDown(view, pointerEvent(430, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Radius);
            expect(constraints[0].datum).toBeCloseTo(30);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);

            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(45);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("radius dimension also applies to arcs", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const arc = editor.solver.addArc(0, 0, 30, 0, 0, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new RadiusDimensionCommand().execute(app);
            // arc rim at world (30, 0) -> screen (430, 300)
            handler.pointerDown(view, pointerEvent(430, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            // addArc adds a structural PointOnArc; the radius dimension is the other one
            const constraints = editor.solver.toData().constraints;
            const radiusConstraint = constraints.find((c) => c.kind === ConstraintKind.Radius);
            expect(radiusConstraint).toBeDefined();
            expect(radiusConstraint!.datum).toBeCloseTo(30);
            expect(editor.dimensionAnchors.has(radiusConstraint!.id)).toBe(true);

            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(
                editor.solver.toData().constraints.find((c) => c.id === radiusConstraint!.id)!.datum,
            ).toBeCloseTo(45);
            const params = editor.solver.entity(arc)!.params;
            expect(Math.hypot(params[2] - params[0], params[3] - params[1])).toBeCloseTo(45);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("confirming the dialog creates a single undo step", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();

            await placeDistanceDimension(app, doc, view);
            expect(confirmDialog(dialog, "80")).toBe(true);
            expect(doc.history.undoCount()).toBe(undosBefore + 1);

            doc.history.undo();
            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.solver.toData().entities.length).toBe(1);
            expect(node.data.constraints.length).toBe(0);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("cancelling the dialog rolls the constraint back without a history record", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();

            await placeDistanceDimension(app, doc, view);
            cancelDialog(dialog);

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(doc.history.undoCount()).toBe(undosBefore);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("dimension between coincident-shared endpoints belongs to the single line", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // three lines chained end-to-end: (0,0)-(100,0)-(200,0)-(300,0)
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(100, 0, 200, 0);
            editor.solver.addLine(200, 0, 300, 0);
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 1 },
                    { entityId: 2, pointIndex: 0 },
                ],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 2, pointIndex: 1 },
                    { entityId: 3, pointIndex: 0 },
                ],
            });
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // dimension the middle line by its endpoints: world (100,0)/(200,0)
            // -> screen (500,300)/(600,300), position at screen (550,250)
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(600, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(550, 250));
            await run;

            const distance = editor.solver
                .toData()
                .constraints.find((c) => c.kind === ConstraintKind.P2PDistance);
            expect(distance).toBeDefined();
            expect(distance!.refs).toEqual([
                { entityId: 2, pointIndex: 0 },
                { entityId: 2, pointIndex: 1 },
            ]);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("angle constraint stores radians, displays and edits degrees", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line 1 midpoint (world (50,0)), line 2 midpoint (world (0,50)), then a label position
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;

            // the dialog shows degrees; the solver datum is stored in radians
            expect(dialogInput(dialog).value).toBe("90.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(constraints[0].refs).toEqual([
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
                { entityId: 2, pointIndex: 0 },
                { entityId: 2, pointIndex: 1 },
            ]);
            expect(constraints[0].datum).toBeCloseTo(Math.PI / 2);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            expect(node.data.constraints.length).toBe(0);

            // confirming converts the entered degrees back to radians
            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(Math.PI / 4);

            // re-editing shows the current value in degrees again
            editor.editDatum(constraints[0].id);
            expect(dialogInput(dialog).value).toBe("45.00");
            expect(confirmDialog(dialog, "60")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(Math.PI / 3);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("horizontal distance accepts a negative datum and drives the signed span", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new HorizontalDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.HorizontalDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);

            // signed distances accept negative input (positiveOnly: false)
            expect(confirmDialog(dialog, "-50")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(-50);
            editor.solver.solve(true);
            const [x1] = editor.solver.pointOf({ entityId: 1, pointIndex: 0 });
            const [x2] = editor.solver.pointOf({ entityId: 1, pointIndex: 1 });
            expect(x2 - x1).toBeCloseTo(-50);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("vertical distance constraint is created at placement", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // worldToScreen maps (x, y) -> (x + 400, y + 300): endpoints at (400,300)/(400,400)
            const run = new VerticalDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 400));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.VerticalDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("point-line distance references the point and both line endpoints", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addCircle(50, 30, 10);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // circle center worldToScreen: (50,30) -> screen (450,330); then the line, then a label position
            const run = new PointLineDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 330));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(470, 280));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2LDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: 2, pointIndex: 0 },
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
            ]);
            // the point is left of the line direction: display +30, the solver stores the negation
            expect(constraints[0].datum).toBeCloseTo(-30);
            expect(editor.dimensionAnchors.get(constraints[0].id)?.kind).toBe("offset");

            // signed distance (display convention) between the circle center and the line
            const signedDist = () => {
                const [px, py] = editor.solver.pointOf({ entityId: 2, pointIndex: 0 });
                const [x1, y1] = editor.solver.pointOf({ entityId: 1, pointIndex: 0 });
                const [x2, y2] = editor.solver.pointOf({ entityId: 1, pointIndex: 1 });
                return ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) / Math.hypot(x2 - x1, y2 - y1);
            };
            // accepting the displayed value keeps the point on its side (no mirroring)
            expect(signedDist()).toBeCloseTo(30);

            expect(confirmDialog(dialog, "20")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(-20);
            editor.solver.solve(true);
            expect(signedDist()).toBeCloseTo(20);

            // a negative display value moves the point to the other side
            expect(confirmDialog(dialog, "-15")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(15);
            editor.solver.solve(true);
            expect(signedDist()).toBeCloseTo(-15);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("cancelling the angle dialog rolls the constraint back without a history record", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;
            cancelDialog(dialog);

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(doc.history.undoCount()).toBe(undosBefore);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("angle dimension accepts the datum X axis as a reference", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(10, 20, 60, 80);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line midpoint uv (35, 50) -> screen (435, 250); the X axis sits at v = 0
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(435, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 280));
            await run;

            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(constraints[0].refs).toEqual([
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
                { entityId: SKETCH_X_AXIS_ID, pointIndex: 0 },
                { entityId: SKETCH_X_AXIS_ID, pointIndex: 1 },
            ]);
            // direction (50, 60) against the X axis: the signed sweep from the
            // line to the axis is -atan2(60, 50) — the sign records the side
            expect(constraints[0].datum).toBeCloseTo(-Math.atan2(60, 50));
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editing an angle below the reference line keeps it on that side", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, -100); // points down: sweep -90° from line 1
            editor.solver.addConstraint({
                kind: ConstraintKind.Fix,
                refs: [{ entityId: 1, pointIndex: 0 }],
                datums: [0, 0],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 2, pointIndex: 0 },
                ],
            });
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line 1 at (450, 300); line 2 midpoint uv (0, -50) -> screen (400, 350)
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 350));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 330));
            await run;

            expect(dialogInput(dialog).value).toBe("90.00");
            expect(confirmDialog(dialog, "45")).toBe(true);

            // the line rotates to -45° on the SAME side instead of flipping to +45°
            // (which would read as 135° from the side the user is looking at)
            const [x1, y1] = editor.solver.pointOf({ entityId: 2, pointIndex: 0 });
            const [x2, y2] = editor.solver.pointOf({ entityId: 2, pointIndex: 1 });
            expect(Math.atan2(y2 - y1, x2 - x1)).toBeCloseTo(-Math.PI / 4, 6);
            expect(editor.solver.toData().constraints.at(-1)?.datum).toBeCloseTo(-Math.PI / 4);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    // Every placement step hands its pick a fresh controller, so the command panel's Cancel
    // button reaches the pick that is up and not the one before it.
    test("cancelling the command during the position pick abandons the dimension", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const command = new AngleDimensionCommand();
            const run = command.execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            expect(editor.isPicking).toBe(true);

            command.cancel();
            await tick();

            expect(editor.isPicking).toBe(false);
            // A click after the cancel must not revive the placement and settle the dimension.
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(dialog.content).toBeUndefined();
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });
});
