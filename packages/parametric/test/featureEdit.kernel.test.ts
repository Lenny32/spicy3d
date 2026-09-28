// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    type AsyncController,
    Config,
    type IEdge,
    type IEventHandler,
    type IFace,
    type IPicker,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    Signal,
    type VisualShapeData,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import type { ExtrudeEditCommand } from "../src/commands/extrudeEditCommand";
import { FeatureChainPreview, LIVE_PREVIEW_BUDGET_MS } from "../src/commands/featureEditPreview";
import type { RevolveEditCommand } from "../src/commands/revolveEditCommand";
import { captureEdgeRef } from "../src/features/edgeRef";
import type {
    ExtrudeFeatureData,
    FeatureData,
    FilletFeatureData,
    RevolveFeatureData,
} from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
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

const TOP_PLANE = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 20 }), normal: XYZ.unitZ, xvec: XYZ.unitX });

/** A selection that keeps what is set and notifies like the real one (the fillet session listens). */
function trackingSelection() {
    let shapes: VisualShapeData[] = [];
    const onShapeChanged = new Signal<(selected: VisualShapeData[]) => void>();
    return {
        setSelectedNodes: () => 0,
        setSelectedShapes: (next: VisualShapeData[]) => {
            shapes = [...next];
            onShapeChanged.emit(shapes);
            return shapes.length;
        },
        getSelectedNodes: () => [],
        getSelectedNodeLength: () => 0,
        getSelectedShapes: () => shapes,
        getSelectedVisualNodes: () => [],
        clearSelection: () => {
            shapes = [];
            onShapeChanged.emit(shapes);
        },
        onNodeChanged: new Signal(),
        onShapeChanged,
        dispose: () => {},
    };
}

/** The document, with a picker whose session is driven by `script` (the handler stands in for the user). */
function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc, {
        context: {
            // A node visual for the body, so the fillet session can preselect its edges.
            getVisual: ((node: unknown) => ({ node, worldTransform: () => Matrix4.identity() })) as never,
        },
    });
    doc.selection = trackingSelection() as never;
    app.activeView = createMockView({ document: doc });
    let script: (handler: IEventHandler, controller: AsyncController) => void = (_handler, controller) =>
        controller.cancel();
    doc.picker = {
        pickAsync: async (handler: IEventHandler, _tip: unknown, controller: AsyncController) => {
            script(handler, controller);
        },
    } as unknown as IPicker;
    return {
        doc,
        app,
        drive: (next: typeof script) => {
            script = next;
        },
    };
}

function addSketch(doc: TestDocument, id: string, plane: Plane, data: SketchData) {
    const sketch = new SketchNode({ document: doc, id, plane, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

function profileOf(sketch: SketchNode): IFace {
    const profiles = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(profiles).toHaveLength(1);
    return profiles[0].shape as unknown as IFace;
}

/** A 40×40 block of `depth`, with a 10×10×10 boss joined on z = 20 (floating when the block is lower). */
function blockWithBoss(doc: TestDocument, depth = 20): ParametricBodyNode {
    const base = addSketch(doc, "sk1", Plane.XY, rect(-20, -20, 20, 20));
    const boss = addSketch(doc, "sk2", TOP_PLANE, rect(-5, -5, 5, 5));
    const body = new ParametricBodyNode({
        document: doc,
        id: "b1",
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: base.id,
                depth,
                profiles: [captureProfileRef(profileOf(base))],
            },
            {
                id: "e2",
                type: "extrude",
                sketchId: boss.id,
                depth: 10,
                operation: "fuse",
                profiles: [captureProfileRef(profileOf(boss))],
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

function topOf(shape: IShape | undefined): number {
    expect(shape).not.toBeUndefined();
    return shape!.boundingBox().max.z;
}

function withDepth(body: ParametricBodyNode, id: string, depth: number): FeatureData {
    return { ...(body.features.find((x) => x.id === id) as ExtrudeFeatureData), depth };
}

describe("FeatureChainPreview", () => {
    test("rollback shows only the edited step; live replays the steps after it", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        const edited = withDepth(body, "e1", 30);

        const rollback = new FeatureChainPreview(body, 0, "rollback").evaluate(edited, false);
        expect(rollback.partial).toBe(true);
        expect(topOf(rollback.shape)).toBeCloseTo(30);

        // The boss (z 20…30) is swallowed by the taller block; with a lower block it shows.
        const lower = withDepth(body, "e1", 5);
        const live = new FeatureChainPreview(body, 0, "live").evaluate(lower, false);
        expect(live.partial).toBe(false);
        expect(topOf(live.shape)).toBeCloseTo(30);
        const lowerRollback = new FeatureChainPreview(body, 0, "rollback").evaluate(lower, false);
        expect(topOf(lowerRollback.shape)).toBeCloseTo(5);
        [rollback, live, lowerRollback].forEach((x) => x.shape?.dispose());
    });

    test("previewing leaves the body untouched", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        const json = body.featuresJson;
        const shape = body.shape.value;

        const result = new FeatureChainPreview(body, 0, "live").evaluate(withDepth(body, "e1", 5), false);
        result.shape?.dispose();

        expect(body.featuresJson).toBe(json);
        expect(body.shape.value).toBe(shape);
        expect(topOf(body.shape.value)).toBeCloseTo(30);
    });

    test("auto previews the later steps mid-drag only while they rebuild fast enough", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);

        const cheap = rs.spyOn(body, "rebuildCostAfter").mockReturnValue(LIVE_PREVIEW_BUDGET_MS / 2);
        expect(new FeatureChainPreview(body, 0, "auto").includesTail(true)).toBe(true);
        cheap.mockReturnValue(LIVE_PREVIEW_BUDGET_MS * 10);
        const slow = new FeatureChainPreview(body, 0, "auto");
        expect(slow.includesTail(true)).toBe(false);
        // Once the value settles the preview is the real result again.
        expect(slow.includesTail(false)).toBe(true);
        cheap.mockRestore();
    });

    test("the last step has nothing after it to replay", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        const preview = new FeatureChainPreview(body, 1, "live");
        expect(preview.hasTail).toBe(false);
        const result = preview.evaluate(withDepth(body, "e2", 20), false);
        expect(result.partial).toBe(false);
        expect(topOf(result.shape)).toBeCloseTo(40);
        result.shape?.dispose();
    });

    test("the default mode follows the setting", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        const previous = Config.instance.featureEditPreview;
        try {
            Config.instance.featureEditPreview = "rollback";
            expect(new FeatureChainPreview(body, 0).mode).toBe("rollback");
        } finally {
            Config.instance.featureEditPreview = previous;
        }
    });

    test("rebuild cost is measured per feature on evaluation", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        expect(body.rebuildCostAfter(0)).toBeGreaterThan(0);
        expect(body.rebuildCostAfter(1)).toBe(0);
    });
});

describe("feature edit sessions", () => {
    test("every interactive feature kind is marked editable in the feature list", () => {
        const { doc } = setup();
        const body = blockWithBoss(doc);
        expect(body.featureItems().map((x) => x.editable)).toEqual([true, true]);
    });

    test("extrude: the arrow starts at the stored depth, confirming stores the new one as one step", async () => {
        const { doc, app, drive } = setup();
        const body = blockWithBoss(doc);
        let startDepth: number | undefined;
        drive((handler, controller) => {
            const drag = handler as unknown as { state: { dist: number }; setDepth(dist: number): void };
            startDepth = drag.state.dist;
            (app.executingCommand as ExtrudeEditCommand).depth = 12;
            expect(drag.state.dist).toBe(12);
            handler.keyDown?.(app.activeView!, new KeyboardEvent("keydown", { key: "Enter" }));
            expect(controller.result?.status).toBe("success");
        });

        await body.editFeature("e1");

        expect(startDepth).toBe(20);
        expect((body.features[0] as ExtrudeFeatureData).depth).toBe(12);
        expect(app.executingCommand).toBeUndefined();
        expect(doc.history.disabled).toBe(false);
        doc.history.undo();
        expect((body.features[0] as ExtrudeFeatureData).depth).toBe(20);
    });

    test("extrude: cancelling leaves the model and the history as they were", async () => {
        const { doc, app, drive } = setup();
        const body = blockWithBoss(doc);
        const json = body.featuresJson;
        const undoCount = doc.history.undoCount();
        drive((_handler, controller) => {
            (app.executingCommand as ExtrudeEditCommand).depth = 12;
            controller.cancel();
        });

        await body.editFeature("e1");

        expect(body.featuresJson).toBe(json);
        expect(doc.history.undoCount()).toBe(undoCount);
    });

    test("extrude: confirming an untouched edit records nothing", async () => {
        const { doc, app, drive } = setup();
        const body = blockWithBoss(doc);
        const undoCount = doc.history.undoCount();
        drive((handler) =>
            handler.keyDown?.(app.activeView!, new KeyboardEvent("keydown", { key: "Enter" })),
        );

        await body.editFeature("e1");

        expect(doc.history.undoCount()).toBe(undoCount);
    });

    test("extrude: the operation of a combining extrude can change, a first extrude has none", async () => {
        const { doc, app, drive } = setup();
        const body = blockWithBoss(doc);
        let combinesFirst: boolean | undefined;
        drive((_handler, controller) => {
            combinesFirst = (app.executingCommand as ExtrudeEditCommand).combines;
            controller.cancel();
        });
        await body.editFeature("e1");
        expect(combinesFirst).toBe(false);

        drive((handler) => {
            const command = app.executingCommand as ExtrudeEditCommand;
            expect(command.combines).toBe(true);
            command.operation = "option.command.operation.cut";
            handler.keyDown?.(app.activeView!, new KeyboardEvent("keydown", { key: "Enter" }));
        });
        await body.editFeature("e2");
        expect((body.features[1] as ExtrudeFeatureData).operation).toBe("cut");
    });

    test("revolve: the handle starts at the stored angle and commits the new one", async () => {
        const { doc, app, drive } = setup();
        const sketch = addSketch(doc, "sk1", Plane.XY, rect(5, 0, 15, 10));
        const feature: RevolveFeatureData = {
            id: "r1",
            type: "revolve",
            sketchId: sketch.id,
            axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
            angle: 90,
        };
        const body = new ParametricBodyNode({ document: doc, features: [feature] });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);

        let startAngle: number | undefined;
        drive((handler) => {
            startAngle = (handler as unknown as { angle: number }).angle;
            (app.executingCommand as RevolveEditCommand).angle = 180;
            expect((handler as unknown as { angle: number }).angle).toBe(180);
            handler.keyDown?.(app.activeView!, new KeyboardEvent("keydown", { key: "Enter" }));
        });

        await body.editFeature("r1");

        expect(startAngle).toBe(90);
        expect((body.features[0] as RevolveFeatureData).angle).toBe(180);
    });

    test("fillet: edits on the rolled-back body with its edges preselected, then restores the chain", async () => {
        const { doc, app, drive } = setup();
        const sketch = addSketch(doc, "sk1", Plane.XY, rect(-20, -20, 20, 20));
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "e1",
                    type: "extrude",
                    sketchId: sketch.id,
                    depth: 20,
                    profiles: [captureProfileRef(profileOf(sketch))],
                },
            ],
        });
        doc.modelManager.addNode(body);
        const edge = body.shape.value.findSubShapes(ShapeTypes.edge)[0] as IEdge;
        const edgeId = body.edgeIdAt(0);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "f1", type: "fillet", radius: 2, edges: [captureEdgeRef(edge, edgeId, false)] },
        ]);
        expect(body.shape.isOk).toBe(true);

        let rolledBack: number | undefined;
        let preselected = 0;
        drive((_handler, controller) => {
            rolledBack = body.rollbackIndex;
            preselected = doc.selection.getSelectedShapes().length;
            (app.executingCommand as unknown as { value: number }).value = 3;
            controller.success();
        });

        await body.editFeature("f1");

        expect(rolledBack).toBe(1);
        expect(preselected).toBe(1);
        expect(body.rollbackIndex).toBeUndefined();
        const fillet = body.features[1] as FilletFeatureData;
        expect(fillet.radius).toBe(3);
        expect(fillet.edges).toHaveLength(1);
        expect(body.shape.isOk).toBe(true);
        doc.history.undo();
        expect((body.features[1] as FilletFeatureData).radius).toBe(2);
    });
});
