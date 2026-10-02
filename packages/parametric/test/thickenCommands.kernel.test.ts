// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    I18n,
    type IFace,
    type IPicker,
    Matrix4,
    Plane,
    PubSub,
    ShapeTypes,
    Transaction,
    type VisualShapeData,
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
import { ThickenFeatureCommand } from "../src/commands/thickenCommand";
import type { ThickenEditCommand } from "../src/commands/thickenEditCommand";
import type { ThickenFeatureData } from "../src/features/feature";
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

const square: SketchData = {
    entities: [
        { id: 1, type: "line", params: [-10, -10, 10, -10] },
        { id: 2, type: "line", params: [10, -10, 10, 10] },
        { id: 3, type: "line", params: [10, 10, -10, 10] },
        { id: 4, type: "line", params: [-10, 10, -10, -10] },
    ],
    constraints: [],
};

/** A document with a parametric 20 x 20 x 10 box; `displayed` counts the preview meshes shown. */
function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    const displayed: number[] = [];
    doc.visual = createMockVisualWithDocument(doc, {
        context: {
            displayMesh: () => {
                displayed.push(displayed.length + 1);
                return displayed.length;
            },
        },
    });
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    const sketch = new SketchNode({
        document: doc,
        plane: new Plane({ origin: XYZ.zero, normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: square,
    });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "e1", type: "extrude", sketchId: sketch.id, depth: 10 }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return { app, doc, body, displayed };
}

function topFacePick(body: ParametricBodyNode): VisualShapeData {
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
    expect(index).toBeGreaterThanOrEqual(0);
    return {
        shape: faces[index],
        owner: { node: body },
        transform: Matrix4.identity(),
        indexes: [index],
    } as unknown as VisualShapeData;
}

/**
 * A picker answering the body pick with `body`, each face pick with the next of `faces`, then
 * pressing the command's Confirm (an empty pick with a successful controller).
 */
function pickFaces(
    doc: TestDocument,
    command: ThickenFeatureCommand,
    body: ParametricBodyNode,
    faces: VisualShapeData[],
    onBodyPicked?: () => void,
) {
    const queue = [...faces];
    doc.picker = {
        pickNode: async () => {
            onBodyPicked?.();
            return [body];
        },
        pickShape: async () => {
            const face = queue.shift();
            if (face === undefined) {
                command.confirm();
                return [];
            }
            return [face];
        },
    } as unknown as IPicker;
}

describe("thicken command (real kernel)", () => {
    test("shells the picked body open at the picked face, as one undo step", async () => {
        const { app, doc, body, displayed } = setup();
        const command = new ThickenFeatureCommand();
        pickFaces(doc, command, body, [topFacePick(body)], () => {
            command.thickness = -2;
        });

        await command.execute(app);

        expect(body.features).toHaveLength(2);
        const feature = body.features[1] as ThickenFeatureData;
        expect(feature).toMatchObject({ type: "thicken", thickness: -2 });
        expect(feature.openFaces).toHaveLength(1);
        // Defaults are left out, as the program writes them.
        expect(feature).not.toHaveProperty("joinType");
        expect(feature).not.toHaveProperty("mode");
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);
        expect(displayed.length).toBeGreaterThan(0);

        doc.history.undo();

        expect(body.features).toHaveLength(1);
        expect(body.shape.value.volume()).toBeCloseTo(4000, 3);
    });

    test("picking a face again closes it; no open face hollows the solid", async () => {
        const { app, doc, body } = setup();
        const command = new ThickenFeatureCommand();
        const top = topFacePick(body);
        pickFaces(doc, command, body, [top, top], () => {
            command.thickness = -2;
            command.joinType = "option.command.joinType.intersection";
        });

        await command.execute(app);

        const feature = body.features[1] as ThickenFeatureData;
        expect(feature).not.toHaveProperty("openFaces");
        expect(feature).toMatchObject({ joinType: "intersection" });
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 6, 3);
    });

    test("tolerant checkbox persists the envelope option in one undo step", async () => {
        const { app, doc, body } = setup();
        const command = new ThickenFeatureCommand();
        pickFaces(doc, command, body, [topFacePick(body)], () => {
            command.thickness = -2;
            command.tolerant = true;
        });
        await command.execute(app);
        expect(body.features[1]).toMatchObject({ type: "thicken", thickness: -2, tolerant: true });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);
        doc.history.undo();
        expect(body.features).toHaveLength(1);
    });

    test("an expression thickness is stored as typed", async () => {
        const { app, doc, body } = setup();
        Transaction.execute(doc, "edit variables", () => {
            doc.variables.setItems([{ id: "v1", name: "wall_t", expression: "2", type: "length" }]);
        });
        const command = new ThickenFeatureCommand();
        pickFaces(doc, command, body, [topFacePick(body)], () => {
            command.thickness = "-wall_t";
        });

        await command.execute(app);

        expect(body.features[1]).toMatchObject({ thickness: "-wall_t" });
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 8, 3);
    });

    test("a face picked on an open shell is refused with a tip, and the shell is thickened whole", async () => {
        const { app, doc } = setup();
        const sketches = [0, 20].map((z) => {
            const sketch = new SketchNode({
                document: doc,
                plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
                data: { entities: [{ id: 1, type: "circle", params: [0, 0, 10] }], constraints: [] },
            });
            doc.modelManager.addNode(sketch);
            return sketch;
        });
        const tube = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "l1",
                    type: "loft",
                    sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                    solid: false,
                },
            ],
        });
        doc.modelManager.addNode(tube);
        expect(tube.shape.isOk).toBe(true);
        const [face] = tube.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        expect(face).not.toBeUndefined();
        const pick = {
            shape: face,
            owner: { node: tube },
            transform: Matrix4.identity(),
            indexes: [0],
        } as unknown as VisualShapeData;
        const publish = rs.spyOn(PubSub.default, "pub");
        try {
            const command = new ThickenFeatureCommand();
            pickFaces(doc, command, tube, [pick], () => {
                command.thickness = 2;
            });

            await command.execute(app);

            expect(publish).toHaveBeenCalledWith("showFloatTip", {
                level: "warn",
                msg: I18n.translate("prompt.thicken.openFacesSolidOnly"),
            });
            expect(tube.features).toHaveLength(2);
            expect(tube.features[1]).not.toHaveProperty("openFaces");
            expect(tube.shape.value.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        } finally {
            publish.mockRestore();
        }
    });

    test("a thickness that does not resolve adds nothing", async () => {
        const { app, doc, body } = setup();
        const command = new ThickenFeatureCommand();
        pickFaces(doc, command, body, [topFacePick(body)], () => {
            command.thickness = "missing_t";
        });

        await command.execute(app);

        expect(body.features).toHaveLength(1);
    });
});

describe("thicken edit session (real kernel)", () => {
    function thickened() {
        const context = setup();
        context.body.setFeaturesEmitShapeChanged([
            ...context.body.features,
            { id: "t1", type: "thicken", thickness: -2 },
        ]);
        expect(context.body.shape.value.volume()).toBeCloseTo(4000 - 16 * 16 * 6, 3);
        return context;
    }

    async function editWith(
        app: ReturnType<typeof setup>["app"],
        body: ParametricBodyNode,
        act: (c: ThickenEditCommand) => void,
    ) {
        const done = body.editFeature("t1");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const session = app.executingCommand as ThickenEditCommand | undefined;
        expect(session).not.toBeUndefined();
        expect(session!.thickness).toBe(-2);
        act(session!);
        await done;
    }

    test("confirming replaces the thickness and join type as one undo step", async () => {
        const { app, doc, body } = thickened();

        await editWith(app, body, (session) => {
            session.thickness = -3;
            session.joinType = "option.command.joinType.intersection";
            session.confirm();
        });

        expect(body.features[1]).toMatchObject({ thickness: -3, joinType: "intersection" });
        expect(body.shape.value.volume()).toBeCloseTo(4000 - 14 * 14 * 4, 3);
        doc.history.undo();
        expect(body.features[1]).toEqual({ id: "t1", type: "thicken", thickness: -2 });
    });

    test("editing can enable and remove the stored tolerant option", async () => {
        const { app, body } = thickened();
        await editWith(app, body, (session) => {
            session.tolerant = true;
            session.confirm();
        });
        expect(body.features[1]).toMatchObject({ tolerant: true, thickness: -2 });
        expect(body.shape.isOk).toBe(true);
        await editWith(app, body, (session) => {
            expect(session.tolerant).toBe(true);
            session.tolerant = false;
            session.confirm();
        });
        expect(body.features[1]).not.toHaveProperty("tolerant");
        expect(body.shape.isOk).toBe(true);
    });

    test("cancelling leaves the feature untouched", async () => {
        const { app, body } = thickened();
        const before = JSON.stringify(body.features);

        await editWith(app, body, (session) => {
            session.thickness = -4;
            void session.cancel();
        });

        expect(JSON.stringify(body.features)).toBe(before);
    });
});
