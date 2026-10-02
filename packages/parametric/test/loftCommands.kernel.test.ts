// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    I18n,
    type IFace,
    type IPicker,
    Matrix4,
    Plane,
    PubSub,
    ShapeTypes,
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
import { LoftFeatureCommand } from "../src/commands/loftCommand";
import type { LoftEditCommand } from "../src/commands/loftEditCommand";
import type { LoftFeatureData } from "../src/features/feature";
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

const planeAt = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

const square = (h: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [-h, -h, h, -h] },
        { id: 2, type: "line", params: [h, -h, h, h] },
        { id: 3, type: "line", params: [h, h, -h, h] },
        { id: 4, type: "line", params: [-h, h, -h, -h] },
    ],
    constraints: [],
});

function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    doc.selection = createMockSelection();
    app.activeView = createMockView({ document: doc });
    const base = new SketchNode({ document: doc, plane: planeAt(0), data: square(10) });
    const top = new SketchNode({ document: doc, plane: planeAt(20), data: square(5) });
    doc.modelManager.addNode(base);
    doc.modelManager.addNode(top);
    return { app, doc, base, top };
}

function profileOf(sketch: SketchNode): IFace {
    const faces = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(faces).toHaveLength(1);
    return faces[0].shape as unknown as IFace;
}

/**
 * A picker answering each section pick with the next sketch's profile, then pressing the command's
 * Confirm (an empty pick with a successful controller, as the real picker ends).
 */
function pickSections(
    doc: TestDocument,
    command: LoftFeatureCommand,
    sketches: SketchNode[],
    onFirstPick?: () => void,
    open = false,
) {
    const queue = [...sketches];
    let first = true;
    doc.picker = {
        pickShape: async () => {
            if (first) onFirstPick?.();
            first = false;
            const sketch = queue.shift();
            if (sketch === undefined) {
                command.confirm();
                return [];
            }
            const pick = {
                shape: open
                    ? (sketch.shape.value.findSubShapes(ShapeTypes.edge)[0] ?? sketch.shape.value)
                    : profileOf(sketch),
                owner: { node: sketch },
                transform: Matrix4.identity(),
                indexes: [0],
            } as unknown as VisualShapeData;
            return [pick];
        },
    } as unknown as IPicker;
}

const bodies = (doc: TestDocument) =>
    doc.modelManager.findNodes((n) => n instanceof ParametricBodyNode) as ParametricBodyNode[];

describe("loft command (real kernel)", () => {
    test("an edge from a multi-profile sketch asks for a profile face using translated text", async () => {
        const { app, doc, base, top } = setup();
        const data = square(10);
        base.setDataEmitShapeChanged({
            ...data,
            entities: [
                ...data.entities,
                ...data.entities.map((entity) => ({
                    ...entity,
                    id: entity.id + 4,
                    params: entity.params.map((value, index) => (index % 2 === 0 ? value + 40 : value)),
                })),
            ],
        });
        class UncachedLoftCommand extends LoftFeatureCommand {
            protected override isPropertyCached(): boolean {
                return false;
            }
        }
        const command = new UncachedLoftCommand();
        command.solid = false;
        const pub = rs.spyOn(PubSub.default, "pub");
        try {
            pickSections(doc, command, [base, top], undefined, true);
            await command.execute(app);
            expect(pub).toHaveBeenCalledWith("showFloatTip", {
                level: "warn",
                msg: I18n.translate("parametric.loft.selectProfileFace"),
            });
            expect(bodies(doc)).toHaveLength(0);
            expect(base.visible).toBe(true);
        } finally {
            pub.mockRestore();
            doc.dispose();
        }
    });

    test("lofts the picked sections into a new body and hides their sketches", async () => {
        const { app, doc, base, top } = setup();
        const command = new LoftFeatureCommand();
        pickSections(doc, command, [base, top]);

        await command.execute(app);

        expect(bodies(doc)).toHaveLength(1);
        const body = bodies(doc)[0];
        expect(body.shape.isOk).toBe(true);
        const feature = body.features[0] as LoftFeatureData;
        expect(feature.type).toBe("loft");
        expect(feature.sections.map((section) => section.sketchId)).toEqual([base.id, top.id]);
        expect(feature.sections.every((section) => section.profile !== undefined)).toBe(true);
        // Defaults are left out, as the program writes them.
        expect(feature).not.toHaveProperty("solid");
        expect(feature).not.toHaveProperty("ruled");
        expect([base.visible, top.visible]).toEqual([false, false]);

        doc.history.undo();

        expect(bodies(doc)).toHaveLength(0);
        expect([base.visible, top.visible]).toEqual([true, true]);
    });

    test("stores the options set in the panel", async () => {
        const { app, doc, base, top } = setup();
        const command = new LoftFeatureCommand();
        // Set in the open session: options set before it starts are replaced by the remembered ones.
        pickSections(doc, command, [base, top], () => {
            command.solid = false;
            command.ruled = true;
        });

        await command.execute(app);

        expect(bodies(doc)[0].features[0]).toMatchObject({ solid: false, ruled: true });
    });

    test("picking open curves creates a surface using the existing sketch-only section payload", async () => {
        const { app, doc, base, top } = setup();
        const openData: SketchData = {
            entities: [{ id: 1, type: "line", params: [-10, 0, 10, 0] }],
            constraints: [],
        };
        base.setDataEmitShapeChanged(openData);
        top.setDataEmitShapeChanged(openData);
        const command = new LoftFeatureCommand();
        pickSections(
            doc,
            command,
            [base, top],
            () => {
                command.solid = false;
            },
            true,
        );
        await command.execute(app);
        expect(bodies(doc)).toHaveLength(1);
        const body = bodies(doc)[0];
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.shapeType).toBe(ShapeTypes.shell);
        expect(body.features[0]).toMatchObject({
            solid: false,
            sections: [{ sketchId: base.id }, { sketchId: top.id }],
        });
        expect(
            (body.features[0] as LoftFeatureData).sections.every((section) => section.profile === undefined),
        ).toBe(true);
        expect([base.visible, top.visible]).toEqual([false, false]);
        doc.history.undo();
        expect(bodies(doc)).toHaveLength(0);
        expect([base.visible, top.visible]).toEqual([true, true]);
    });

    test("a single section creates nothing", async () => {
        const { app, doc, base } = setup();
        const command = new LoftFeatureCommand();
        pickSections(doc, command, [base]);

        await command.execute(app);

        expect(bodies(doc)).toHaveLength(0);
        expect(base.visible).toBe(true);
    });

    test.each(["duplicate", "coplanar"])("rejects %s sections without changing the model", async (kind) => {
        const { app, doc, base, top } = setup();
        const second =
            kind === "duplicate"
                ? base
                : new SketchNode({ document: doc, plane: planeAt(0), data: square(5) });
        if (kind === "coplanar") doc.modelManager.addNode(second);
        const command = new LoftFeatureCommand();
        pickSections(doc, command, [base, second]);
        const position = doc.history.position();
        const errors: string[] = [];
        const onToast = (_message: unknown, error?: unknown) => errors.push(String(error));
        PubSub.default.sub("showToast", onToast);
        try {
            await command.execute(app);

            expect(bodies(doc)).toHaveLength(0);
            expect([base.visible, second.visible, top.visible]).toEqual([true, true, true]);
            expect(doc.history.position()).toEqual(position);
            expect(errors).toEqual([expect.stringContaining("same plane")]);
        } finally {
            PubSub.default.remove("showToast", onToast);
        }
    });
});

describe("loft edit session (real kernel)", () => {
    function loftBody(doc: TestDocument, base: SketchNode, top: SketchNode) {
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "l1", type: "loft", sections: [{ sketchId: base.id }, { sketchId: top.id }] }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        return body;
    }

    /** Starts the session, lets it open, then hands its command to `act`. */
    async function editWith(
        app: ReturnType<typeof setup>["app"],
        body: ParametricBodyNode,
        act: (c: LoftEditCommand) => void,
    ) {
        const done = body.editFeature("l1");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const session = app.executingCommand as LoftEditCommand | undefined;
        expect(session).not.toBeUndefined();
        expect(session!.solid).toBe(true);
        act(session!);
        await done;
    }

    test("confirming replaces the options as one undo step", async () => {
        const { app, doc, base, top } = setup();
        const body = loftBody(doc, base, top);

        await editWith(app, body, (session) => {
            session.solid = false;
            session.confirm();
        });

        expect(body.features[0]).toMatchObject({ solid: false });
        expect(body.shape.value.shapeType).not.toBe(ShapeTypes.solid);
        doc.history.undo();
        expect(body.features[0]).not.toHaveProperty("solid");
        expect(body.shape.value.shapeType).toBe(ShapeTypes.solid);
    });

    test("open-section edits reject solid output and confirm valid surface options with undo", async () => {
        const { app, doc, base, top } = setup();
        const data: SketchData = {
            entities: [{ id: 1, type: "line", params: [-10, 0, 10, 0] }],
            constraints: [],
        };
        base.setDataEmitShapeChanged(data);
        top.setDataEmitShapeChanged(data);
        const feature: LoftFeatureData = {
            id: "l1",
            type: "loft",
            solid: false,
            sections: [{ sketchId: base.id }, { sketchId: top.id }],
        };
        const body = new ParametricBodyNode({ document: doc, featuresJson: JSON.stringify([feature]) });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        const done = body.editFeature("l1");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const session = app.executingCommand as LoftEditCommand;
        expect(session.solid).toBe(false);
        session.solid = true;
        session.confirm();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(app.executingCommand).toBe(session);
        expect(body.features[0]).toEqual(feature);
        session.solid = false;
        session.ruled = true;
        session.confirm();
        await done;
        expect(body.features[0]).toMatchObject({ solid: false, ruled: true });
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.shapeType).toBe(ShapeTypes.shell);
        doc.history.undo();
        expect(body.features[0]).toEqual(feature);
    });

    test("confirming a valid loft edit permits a downstream feature failure", async () => {
        const { app, doc, base, top } = setup();
        const body = loftBody(doc, base, top);
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "bad", type: "extrude", sketchId: "missing", depth: 1 },
        ]);
        expect(body.featureItems()[1].error).toBe("Sketch not found");
        const before = doc.history.undoCount();
        await editWith(app, body, (session) => {
            session.ruled = true;
            session.confirm();
        });
        expect(body.features[0]).toMatchObject({ ruled: true });
        expect(body.featureItems()[1].error).toBe("Sketch not found");
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        expect(body.features[0]).not.toHaveProperty("ruled");
    });

    test("cancelling leaves the feature untouched", async () => {
        const { app, doc, base, top } = setup();
        const body = loftBody(doc, base, top);
        const before = JSON.stringify(body.features);

        await editWith(app, body, (session) => {
            session.ruled = true;
            void session.cancel();
        });

        expect(JSON.stringify(body.features)).toBe(before);
    });
});
