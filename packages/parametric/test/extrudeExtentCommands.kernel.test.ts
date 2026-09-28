// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The extent options of the extrude sessions (issue #59) against the real kernel: the create
 * command's "To object" (a clicked face, highlighted, with Auto resolving the operation) and
 * "Through all" (across the target list of #57), and the #55 edit session switching extents.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    type AsyncController,
    type IEventHandler,
    type IFace,
    type IPicker,
    Matrix4,
    Plane,
    PubSub,
    ShapeTypes,
    VisualConfig,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { ExtrudeFeatureCommand } from "../src/commands/extrudeCommand";
import type { ExtrudeDragData, ExtrudeDragState, ExtrudePreview } from "../src/commands/extrudeDragStep";
import type { ExtrudeEditCommand } from "../src/commands/extrudeEditCommand";
import {
    EXTENT_DISTANCE,
    EXTENT_FACE_OPACITY,
    EXTENT_THROUGH_ALL,
    EXTENT_TO_OBJECT,
} from "../src/commands/extrudeExtentOptions";
import type { ExtrudeFeatureData } from "../src/features/feature";
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

const volume = (body: ParametricBodyNode) => {
    expect(body.shape.isOk).toBe(true);
    return Math.abs(body.shape.value.volume());
};

/** Two 20×20×10 blocks (x 0…20 and 30…50) and a picker whose drag session `drive` scripts. */
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
        return body;
    };
    return {
        app,
        doc,
        left: block("left", 0),
        right: block("right", 30),
        drive: (next: typeof script) => {
            script = next;
        },
    };
}

type Scene = ReturnType<typeof scene>;

/** A create command on `sketch` (at z 10) as the drag step leaves it, with its drag data. */
function extrudeCommand(s: Scene, sketch: SketchNode) {
    const cmd = new ExtrudeFeatureCommand();
    (cmd as any)._application = s.app;
    (cmd as any).stepDatas = [
        { shapes: [], nodes: [sketch], type: "shape" },
        { shapes: [], nodes: [sketch], plane: planeAtZ(10), type: "input" },
    ];
    const state = (dist: number): ExtrudeDragState => ({
        node: sketch,
        faces: [],
        origin: planeAtZ(10).origin,
        normal: XYZ.unitZ,
        anchor: planeAtZ(10).origin,
        dist,
        startOffset: 0,
        arrowHovered: false,
    });
    const data = (): ExtrudeDragData => (cmd as any).getDragData();
    const preview = (dist = 0): ExtrudePreview => (cmd as any).buildPreview(state(dist));
    const commit = () => (cmd as any).executeMainTask();
    return { cmd, data, preview, commit };
}

/** What the viewport reports for `body`'s face facing `normal`. */
function faceHit(body: ParametricBodyNode, normal: XYZ) {
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((f) => f.surface().isPlanar() && f.normal(0, 0)[1].dot(normal) > 1 - 1e-6);
    expect(index).toBeGreaterThanOrEqual(0);
    return {
        shape: faces[index],
        owner: { node: body },
        transform: Matrix4.identity(),
        indexes: [index],
    } as never;
}

describe("the create command's extents", () => {
    test("To object: nothing previews until a face is clicked, then Auto cuts down to it", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(5, 5, 10, 10) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, data, preview, commit } = extrudeCommand(s, sketch);

        cmd.extent = EXTENT_TO_OBJECT;
        expect(cmd.isToObject).toBe(true);
        expect(cmd.isDistance).toBe(false);
        expect(data().depthLocked!()).toBe(true);
        expect(data().extentReady!()).toBe(false);
        expect(preview().meshes).toEqual([]);

        expect(data().pickExtentFace!(faceHit(s.left, XYZ.unitZ.multiply(-1)))).toBe(true);
        expect(data().extentReady!()).toBe(true);
        const shown = preview();
        expect(cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        // The clicked face is drawn highlighted over the preview, besides the red tool.
        const highlight = shown.overlays?.find((x) => x.color === VisualConfig.selectedFaceColor);
        expect(highlight?.opacity).toBe(EXTENT_FACE_OPACITY);
        expect(shown.hide).toEqual([s.left]);

        commit();

        const hole = s.left.features[1] as ExtrudeFeatureData;
        expect(hole).toMatchObject({
            type: "extrude",
            operation: "cut",
            extent: { type: "toObject", nodeId: "left" },
        });
        expect(volume(s.left)).toBeCloseTo(4000 - 25 * 10, 3);
        expect(volume(s.right)).toBeCloseTo(4000, 3);
    });

    test("To object without a face is refused at commit", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(5, 5, 10, 10) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, commit } = extrudeCommand(s, sketch);
        cmd.extent = EXTENT_TO_OBJECT;
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            commit();
            expect(pub.mock.calls.some((x) => x[0] === "showToast")).toBe(true);
        } finally {
            pub.mockRestore();
        }
        expect(s.left.features).toHaveLength(1);
        expect(s.doc.modelManager.findNodes((n) => n instanceof ParametricBodyNode)).toHaveLength(2);
    });

    test("Through all: the slot cuts both blocks through, one entry on the other", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(10, 5, 40, 15) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, preview, commit } = extrudeCommand(s, sketch);

        cmd.extent = EXTENT_THROUGH_ALL;
        const shown = preview();
        expect(cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        expect(shown.hide).toEqual([s.left, s.right]);

        commit();

        expect(s.left.features[1]).toMatchObject({ extent: { type: "throughAll" }, operation: "cut" });
        expect(s.right.features[1]).toMatchObject({ type: "extrudeTarget", bodyId: "left" });
        expect(volume(s.left)).toBeCloseTo(3000, 3);
        expect(volume(s.right)).toBeCloseTo(3000, 3);
    });

    test("Through all with New body has nothing to go through: refused, nothing added", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(5, 5, 10, 10) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, commit } = extrudeCommand(s, sketch);
        cmd.extent = EXTENT_THROUGH_ALL;
        cmd.operation = "option.command.operation.new";
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            commit();
            expect(pub.mock.calls.some((x) => x[0] === "showToast")).toBe(true);
        } finally {
            pub.mockRestore();
        }
        expect(s.doc.modelManager.findNodes((n) => n instanceof ParametricBodyNode)).toHaveLength(2);
        expect(sketch.visible).toBe(true);
    });

    test("back to Distance: the extent is left out of the feature (the format-2 shape)", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(5, 5, 10, 10) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, preview, commit } = extrudeCommand(s, sketch);
        cmd.extent = EXTENT_THROUGH_ALL;
        cmd.extent = EXTENT_DISTANCE;
        cmd.depth = -4;
        preview(-4);
        commit();

        expect(s.left.features[1]).not.toHaveProperty("extent");
        expect(volume(s.left)).toBeCloseTo(4000 - 25 * 4, 3);
    });
});

describe("the edit session's extents", () => {
    const confirm = (s: Scene, handler: IEventHandler) =>
        handler.keyDown?.(s.app.activeView!, new KeyboardEvent("keydown", { key: "Enter" }));

    /** The block with a hole cut down to its bottom face, through the create command. */
    function withHole(s: Scene) {
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(10), data: rect(5, 5, 10, 10) });
        s.doc.modelManager.addNode(sketch);
        const { cmd, data, preview, commit } = extrudeCommand(s, sketch);
        cmd.extent = EXTENT_TO_OBJECT;
        data().pickExtentFace!(faceHit(s.left, XYZ.unitZ.multiply(-1)));
        preview();
        commit();
        expect(volume(s.left)).toBeCloseTo(3750, 3);
        return s.left.features[1] as ExtrudeFeatureData;
    }

    test("opens on the stored extent with the face highlighted; switching to a distance stores the depth", async () => {
        const s = scene();
        const hole = withHole(s);
        let opened: string | undefined;
        let highlighted = false;
        s.drive((handler) => {
            const command = s.app.executingCommand as ExtrudeEditCommand;
            opened = command.extent;
            const shown = (handler as any).data.buildPreview((handler as any).state) as ExtrudePreview;
            highlighted = shown.overlays?.some((x) => x.color === VisualConfig.selectedFaceColor) === true;
            command.extent = EXTENT_DISTANCE;
            command.depth = -4;
            confirm(s, handler);
        });

        await s.left.editFeature(hole.id);

        expect(opened).toBe(EXTENT_TO_OBJECT);
        expect(highlighted).toBe(true);
        expect(s.left.features[1]).not.toHaveProperty("extent");
        expect(volume(s.left)).toBeCloseTo(4000 - 25 * 4, 3);

        s.doc.history.undo();
        expect((s.left.features[1] as ExtrudeFeatureData).extent?.type).toBe("toObject");
        expect(volume(s.left)).toBeCloseTo(3750, 3);
    });

    test("a clicked face replaces the stored one, with its offset", async () => {
        const s = scene();
        const hole = withHole(s);
        // The other block lowered to z -4…6: its top face's plane is at z 6.
        s.right.setFeatureParameter("right-base", "startOffset", -4);
        s.drive((handler) => {
            const command = s.app.executingCommand as ExtrudeEditCommand;
            // Up to that plane, stopped 1 short: the hole goes from the sketch (z 10) down to z 7.
            (handler as any).data.pickExtentFace(faceHit(s.right, XYZ.unitZ));
            command.extentOffset = -1;
            confirm(s, handler);
        });

        await s.left.editFeature(hole.id);

        const edited = s.left.features[1] as ExtrudeFeatureData;
        expect(edited.extent).toMatchObject({ type: "toObject", nodeId: "right", offset: -1 });
        expect(s.left.featureItems().map((x) => x.error)).toEqual([undefined, undefined]);
        expect(volume(s.left)).toBeCloseTo(4000 - 25 * 3, 3);
    });
});
