// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * An extrude acting on several bodies (issue #57) against the real kernel: a cut through two
 * blocks cuts both by default, Ctrl+click leaves one out, the other target follows the extrude's
 * edits through its `extrudeTarget` entry, and the whole thing undoes, saves, reloads, and edits
 * (the #55 session) as one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type AsyncController,
    type IEventHandler,
    type IFace,
    type IPicker,
    Matrix4,
    migrateDocument,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import {
    createHandlerMockView,
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    createPointerEvent,
    loadDocumentFixtures,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { ExtrudeFeatureCommand, extrudeTargetsInfo } from "../src/commands/extrudeCommand";
import type { ExtrudeDragState, ExtrudePreview } from "../src/commands/extrudeDragStep";
import type { ExtrudeEditCommand } from "../src/commands/extrudeEditCommand";
import type {
    BooleanFeatureData,
    ExtrudeFeatureData,
    ExtrudeTargetFeatureData,
} from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src/commands";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

const planeAtZ = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

/** 20×20×10 blocks: 4000 mm³; the slot takes 10×10×5 = 500 mm³ out of each. */
const BLOCK = 4000;
const SLOT_SHARE = 500;

const volume = (body: ParametricBodyNode) => {
    expect(body.shape.isOk).toBe(true);
    return Math.abs(body.shape.value.volume());
};

/**
 * Two 20×20×10 blocks side by side (x 0…20 and 30…50, z 0…10), and a picker whose drag session
 * is driven by `drive` (the handler stands in for the user).
 */
function scene() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    let script: (handler: IEventHandler, controller: AsyncController) => void = (_handler, controller) =>
        controller.cancel();
    doc.picker = {
        pickAsync: async (handler: IEventHandler, _tip: unknown, controller: AsyncController) => {
            script(handler, controller);
        },
    } as unknown as IPicker;
    const block = (id: string, x0: number) => {
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(x0, 0, x0 + 20, 20) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            id,
            features: [{ id: `${id}-base`, type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(volume(body)).toBeCloseTo(BLOCK, 3);
        return body;
    };
    const left = block("left", 0);
    const right = block("right", 30);
    const command = () => {
        const cmd = new ExtrudeFeatureCommand();
        (cmd as any)._application = app;
        return cmd;
    };
    return {
        app,
        doc,
        left,
        right,
        command,
        drive: (next: typeof script) => {
            script = next;
        },
    };
}

type Scene = ReturnType<typeof scene>;

/** A 30×10 slot sketch on the blocks' top faces, spanning both (x 10…40, y 5…15). */
function slotSketch(s: Scene) {
    const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(10, 5, 40, 15) });
    s.doc.modelManager.addNode(sketch);
    return sketch;
}

/** The drag state the preview gets for the whole slot sketch at `dist`. */
const dragState = (sketch: SketchNode, dist: number): ExtrudeDragState => ({
    node: sketch,
    faces: [],
    origin: planeAtZ(10).origin,
    normal: XYZ.unitZ,
    anchor: planeAtZ(10).origin,
    dist,
    startOffset: 0,
    arrowHovered: false,
});

/** A command set up to commit the slot at `depth`, with a live preview taken first (as the drag does). */
function slotCommand(s: Scene, sketch: SketchNode, depth: number, operation?: string) {
    const cmd = s.command();
    if (operation !== undefined) cmd.operation = operation as never;
    cmd.depth = depth;
    (cmd as any).stepDatas = [
        { shapes: [], nodes: [sketch], type: "shape" },
        { shapes: [], nodes: [sketch], plane: planeAtZ(10), type: "input" },
    ];
    const preview = (): ExtrudePreview => (cmd as any).buildPreview(dragState(sketch, depth));
    const commit = () => (cmd as any).executeMainTask();
    return { cmd, preview, commit };
}

describe("an extrude through two bodies", () => {
    test("cuts both by default: the host keeps the extrude, the other gets its entry", () => {
        const s = scene();
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), -5);

        const shown = preview();
        expect(cmd.targetsInfo).toBe(extrudeTargetsInfo("cut", 2));
        expect(cmd.hasTargets).toBe(true);
        expect(cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        // Both results stand in for their bodies, the red tool drawn once over them.
        expect(shown.hide).toEqual([s.left, s.right]);
        expect(shown.overlays).toHaveLength(1);

        commit();

        expect(s.left.features).toHaveLength(2);
        expect(s.left.features[1]).toMatchObject({ type: "extrude", operation: "cut" });
        const slot = s.left.features[1] as ExtrudeFeatureData;
        expect(s.right.features).toHaveLength(2);
        expect(s.right.features[1]).toMatchObject({
            type: "extrudeTarget",
            bodyId: s.left.id,
            featureId: slot.id,
        });
        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(s.right.rebuildStatus().features!.every((x) => x.error === undefined)).toBe(true);
    });

    test("Ctrl+click leaves one body out: it is untouched, and in again: it is cut", () => {
        const s = scene();
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), -5);
        preview();

        expect((cmd as any).toggleTarget(s.right)).toBe(true);
        const shown = preview();
        expect(cmd.targetsInfo).toBe(extrudeTargetsInfo("cut", 1));
        expect(shown.hide).toEqual([s.left]);

        commit();

        expect(s.left.features).toHaveLength(2);
        expect(s.right.features).toHaveLength(1);
        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);
    });

    test("leaving out the host moves the extrude to the other body", () => {
        const s = scene();
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), -5);
        preview();
        (cmd as any).toggleTarget(s.left);
        preview();
        commit();

        expect(s.left.features).toHaveLength(1);
        expect(s.right.features[1]).toMatchObject({ type: "extrude", operation: "cut" });
        expect(volume(s.left)).toBeCloseTo(BLOCK, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });

    test("leaving every body out makes a new body", () => {
        const s = scene();
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), -5);
        preview();
        (cmd as any).toggleTarget(s.left);
        (cmd as any).toggleTarget(s.right);
        preview();
        expect(cmd.hasTargets).toBe(false);
        expect(cmd.autoOperationLabel).toBe("option.command.operation.auto.new");

        commit();

        expect(s.left.features).toHaveLength(1);
        expect(s.right.features).toHaveLength(1);
        expect(s.doc.modelManager.findNodes((n) => n instanceof ParametricBodyNode)).toHaveLength(3);
    });

    test("a Ctrl+clicked body the tool does not reach is added (a cut there changes nothing)", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(2, 2, 8, 8) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, preview, commit } = slotCommand(s, sketch, -5);
        preview();
        expect(cmd.targetsInfo).toBe(extrudeTargetsInfo("cut", 1));
        (cmd as any).toggleTarget(s.right);
        preview();
        expect(cmd.targetsInfo).toBe(extrudeTargetsInfo("cut", 2));

        commit();

        expect(s.right.features[1]).toMatchObject({ type: "extrudeTarget", bodyId: s.left.id });
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);
        expect(volume(s.left)).toBeCloseTo(BLOCK - 36 * 5, 3);
    });

    test("undo takes the cut off both bodies in one step, redo puts it back on both", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();

        s.doc.history.undo();
        expect(s.left.features).toHaveLength(1);
        expect(s.right.features).toHaveLength(1);
        expect(volume(s.left)).toBeCloseTo(BLOCK, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);

        s.doc.history.redo();
        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });

    test("an edit of the extrude in its host rebuilds the other target", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;

        s.left.setFeatureParameter(slot.id, "depth", -8);

        expect(volume(s.left)).toBeCloseTo(BLOCK - 800, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - 800, 3);

        s.left.setFeatureSuppressed(slot.id, true);
        expect(volume(s.left)).toBeCloseTo(BLOCK, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);
    });

    test("two extrudes cutting each other's body settle (no endless rebuild)", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;
        // A second, lower slot hosted in the right block and cutting the left one too: each
        // body now reads the other's feature list and watches the other.
        const lower = new SketchNode({ document: s.doc, plane: planeAtZ(5), data: rect(10, 5, 40, 15) });
        s.doc.modelManager.addNode(lower);
        const second: ExtrudeFeatureData = {
            id: "second",
            type: "extrude",
            sketchId: lower.id,
            depth: -2,
            operation: "cut",
        };
        s.right.setFeaturesEmitShapeChanged([...s.right.features, second]);
        s.left.setFeaturesEmitShapeChanged([
            ...s.left.features,
            { id: "second-target", type: "extrudeTarget", bodyId: s.right.id, featureId: second.id },
        ]);
        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE - 200, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE - 200, 3);

        // An edit on either side settles: the other body re-evaluates its entry once.
        s.left.setFeatureParameter(slot.id, "depth", -4);
        expect(volume(s.left)).toBeCloseTo(BLOCK - 400 - 200, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - 400 - 200, 3);
        s.right.setFeatureParameter(second.id, "depth", -3);
        expect(volume(s.left)).toBeCloseTo(BLOCK - 400 - 300, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - 400 - 300, 3);
    });

    test("removing the extrude from its host removes its entries too", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;

        s.left.removeFeature(slot.id);

        expect(s.right.features).toHaveLength(1);
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);
    });

    test("a deleted host fails the entry with a clear error; undo brings the cut back", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const entry = s.right.features[1] as ExtrudeTargetFeatureData;

        Transaction.execute(s.doc, "delete", () => s.left.parent!.remove(s.left));

        const status = s.right.rebuildStatus();
        expect(status.features!.find((x) => x.id === entry.id)?.error).toBe("Linked extrude not found");

        s.doc.history.undo();
        expect(s.right.rebuildStatus().features!.find((x) => x.id === entry.id)?.error).toBeUndefined();
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });

    test("a deleted other target just drops out: the host is untouched", () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();

        Transaction.execute(s.doc, "delete", () => s.right.parent!.remove(s.right));

        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(s.left.rebuildStatus().features!.every((x) => x.error === undefined)).toBe(true);
    });

    test("saves and loads with both bodies cut", async () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const saved = structuredClone(s.doc.modelManager.serialize());

        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as never;
        await doc.modelManager.deserialize(saved);

        const bodies = doc.modelManager.findNodes(
            (n) => n instanceof ParametricBodyNode,
        ) as ParametricBodyNode[];
        expect(bodies.map((x) => x.id).sort()).toEqual(["left", "right"]);
        for (const body of bodies) expect(volume(body)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });

    test("a join through two touching bodies merges them into the host", () => {
        const s = scene();
        // A bridge standing on both blocks' top faces, joining them.
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), 5);
        preview();
        expect(cmd.targetsInfo).toBe(extrudeTargetsInfo("fuse", 2));

        commit();

        expect(s.left.features.map((x) => x.type)).toEqual(["extrude", "extrude", "boolean"]);
        expect((s.left.features[2] as BooleanFeatureData).toolIds).toEqual([s.right.id]);
        // The merged body is both blocks plus the 30×10×5 bridge.
        expect(volume(s.left)).toBeCloseTo(2 * BLOCK + 1500, 3);
        // Consumed as a tool, like any boolean tool.
        expect(s.right.parent).toBe(s.left);
    });
});

describe("the parametric v2 fixture", () => {
    test("loads with its one cut through both bodies", async () => {
        const fixture = loadDocumentFixtures().find((x) => x.name === "v1/parametric2-extrude-targets.json");
        expect(fixture).not.toBeUndefined();
        const data = migrateDocument(fixture!.data).value;
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as never;
        await doc.modelManager.deserialize(structuredClone(data["models"]));

        const body = (id: string) => doc.modelManager.findNode((n) => n.id === id) as ParametricBodyNode;
        expect(volume(body("body-left"))).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
        expect(volume(body("body-right"))).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });
});

describe("the edit session's target list", () => {
    /** A Ctrl+click on `body`'s first face, through the drag handler. */
    function ctrlClick(s: Scene, handler: IEventHandler, body: ParametricBodyNode) {
        const face = body.shape.value.findSubShapes(ShapeTypes.face)[0] as IFace;
        const hit = { shape: face, owner: { node: body }, indexes: [0], transform: Matrix4.identity() };
        const view = createHandlerMockView({ document: s.doc, detectShapes: () => [hit] as never });
        handler.pointerDown?.(view, createPointerEvent({ ctrlKey: true }));
        handler.pointerUp?.(view, createPointerEvent({ ctrlKey: true }));
    }

    const confirm = (s: Scene, handler: IEventHandler) =>
        handler.keyDown?.(s.app.activeView!, new KeyboardEvent("keydown", { key: "Enter" }));

    test("lists the stored targets; Ctrl+click removes one, confirming takes its entry off in one step", async () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;
        let listed: string | undefined;
        let after: string | undefined;
        let previewHid: unknown[] = [];
        s.drive((handler) => {
            const command = s.app.executingCommand as ExtrudeEditCommand;
            listed = command.targetsInfo;
            ctrlClick(s, handler, s.right);
            after = command.targetsInfo;
            // The removed target previews without the cut, standing in for its body.
            const preview = (handler as any).data.buildPreview((handler as any).state) as ExtrudePreview;
            previewHid = preview.hide ?? [];
            confirm(s, handler);
        });

        await s.left.editFeature(slot.id);

        expect(listed).toBe(extrudeTargetsInfo("cut", 2));
        expect(after).toBe(extrudeTargetsInfo("cut", 1));
        expect(previewHid).toEqual([s.left, s.right]);
        expect(s.right.features).toHaveLength(1);
        expect(volume(s.right)).toBeCloseTo(BLOCK, 3);
        expect(volume(s.left)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);

        s.doc.history.undo();
        expect(s.right.features).toHaveLength(2);
        expect(volume(s.right)).toBeCloseTo(BLOCK - SLOT_SHARE, 3);
    });

    test("Ctrl+click adds a body, and the depth edit reaches every target", async () => {
        const s = scene();
        const { cmd, preview, commit } = slotCommand(s, slotSketch(s), -5);
        preview();
        (cmd as any).toggleTarget(s.right);
        preview();
        commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;
        expect(s.right.features).toHaveLength(1);
        s.drive((handler) => {
            const command = s.app.executingCommand as ExtrudeEditCommand;
            ctrlClick(s, handler, s.right);
            command.depth = -8;
            confirm(s, handler);
        });

        await s.left.editFeature(slot.id);

        expect(s.right.features[1]).toMatchObject({ type: "extrudeTarget", featureId: slot.id });
        expect(volume(s.left)).toBeCloseTo(BLOCK - 800, 3);
        expect(volume(s.right)).toBeCloseTo(BLOCK - 800, 3);
    });

    test("editing the entry in the other body opens the extrude's own session in its host", async () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const entry = s.right.features[1] as ExtrudeTargetFeatureData;
        expect(s.right.featureItems()[1].editable).toBe(true);
        s.drive((handler) => {
            (s.app.executingCommand as ExtrudeEditCommand).depth = -8;
            confirm(s, handler);
        });

        await s.right.editFeature(entry.id);

        expect((s.left.features[1] as ExtrudeFeatureData).depth).toBe(-8);
        expect(volume(s.right)).toBeCloseTo(BLOCK - 800, 3);
    });

    test("the host cannot be Ctrl+clicked out: the extrude lives in its list", async () => {
        const s = scene();
        slotCommand(s, slotSketch(s), -5).commit();
        const slot = s.left.features[1] as ExtrudeFeatureData;
        let info: string | undefined;
        s.drive((handler) => {
            ctrlClick(s, handler, s.left);
            info = (s.app.executingCommand as ExtrudeEditCommand).targetsInfo;
            confirm(s, handler);
        });

        await s.left.editFeature(slot.id);

        expect(info).toBe(extrudeTargetsInfo("cut", 2));
        expect(s.right.features).toHaveLength(2);
    });
});
