// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The extrude's Auto operation against the real kernel: how a tool volume meets a body
 * (`classifyContact`), and what the command commits and previews for a sketch on a body
 * face and for a press-pull — into the material = cut, outward = join, apart = new body.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    BoundingBox,
    type IFace,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    VisualConfig,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { ExtrudeFeatureCommand, OPERATION_AUTO } from "../src/commands/extrudeCommand";
import { classifyContact, type ExtrudeContact } from "../src/commands/extrudeContact";
import type { ExtrudePreview } from "../src/commands/extrudeDragStep";
import type { ExtrudeFeatureData } from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
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

describe("classifyContact", () => {
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): IShape => {
        const plane = new Plane({
            origin: new XYZ({ x: x0, y: y0, z: z0 }),
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
        });
        const solid = shapeFactory.box(plane, x1 - x0, y1 - y0, z1 - z0);
        expect(solid.isOk).toBe(true);
        return solid.value;
    };

    test.each<{ name: string; tool: () => IShape; expected: ExtrudeContact }>([
        {
            name: "a boss standing on the top face touches",
            tool: () => box(2, 2, 10, 8, 8, 15),
            expected: "touch",
        },
        {
            name: "a block sharing one edge touches",
            tool: () => box(10, 10, 0, 15, 15, 10),
            expected: "touch",
        },
        { name: "a tool fully inside overlaps", tool: () => box(2, 2, 2, 8, 8, 8), expected: "overlap" },
        {
            name: "a partially overlapping tool overlaps",
            tool: () => box(2, 2, 5, 8, 8, 15),
            expected: "overlap",
        },
        {
            name: "a tool enclosing the body overlaps",
            tool: () => box(-1, -1, -1, 11, 11, 11),
            expected: "overlap",
        },
        { name: "a tool above the body is apart", tool: () => box(2, 2, 11, 8, 8, 15), expected: "none" },
        {
            // The bounding boxes overlap, the shapes do not: the real test must say so.
            name: "a sphere off the corner is apart",
            tool: () => shapeFactory.sphere(new XYZ({ x: 12, y: 12, z: 12 }), 3).value,
            expected: "none",
        },
    ])("$name", ({ tool, expected }) => {
        const body = box(0, 0, 0, 10, 10, 10);
        const shape = tool();
        try {
            expect(classifyContact(shape, body)).toBe(expected);
        } finally {
            shape.dispose();
            body.dispose();
        }
    });

    test("the sphere's bounding box does meet the body's (so the pre-filter alone would be wrong)", () => {
        const body = box(0, 0, 0, 10, 10, 10);
        const sphere = shapeFactory.sphere(new XYZ({ x: 12, y: 12, z: 12 }), 3).value;
        try {
            expect(BoundingBox.isIntersect(sphere.boundingBox(), body.boundingBox())).toBe(true);
        } finally {
            sphere.dispose();
            body.dispose();
        }
    });
});

describe("ExtrudeFeatureCommand Auto against the kernel", () => {
    /** A 40×40×20 block (z 0…20) and a command ready to commit. */
    function scene() {
        const app = createMockApplication();
        const doc = new TestDocument({ application: app });
        doc.visual = createMockVisualWithDocument(doc) as never;
        (app as any).activeView = { document: doc };
        const base = new SketchNode({ document: doc, plane: Plane.XY, data: rect(-20, -20, 20, 20) });
        doc.modelManager.addNode(base);
        const profile = base.mesh.faces?.range.find((x) => x.shape.shapeType === ShapeTypes.face);
        expect(profile).not.toBeUndefined();
        const block = new ParametricBodyNode({
            document: doc,
            features: [
                {
                    id: "e1",
                    type: "extrude",
                    sketchId: base.id,
                    depth: 20,
                    profiles: [captureProfileRef(profile!.shape as unknown as IFace)],
                },
            ],
        });
        doc.modelManager.addNode(block);
        expect(block.shape.isOk).toBe(true);
        const command = () => {
            const cmd = new ExtrudeFeatureCommand();
            (cmd as any)._application = app;
            return cmd;
        };
        return { doc, block, command };
    }

    /** Extrudes a 10×10 sketch on `plane` by `depth` through the command's commit. */
    function extrudeSketch(
        s: ReturnType<typeof scene>,
        plane: Plane,
        depth: number,
        operation = OPERATION_AUTO,
    ) {
        const sketch = new SketchNode({ document: s.doc, plane, data: rect(-5, -5, 5, 5) });
        s.doc.modelManager.addNode(sketch);
        const cmd = s.command();
        cmd.operation = operation;
        cmd.depth = depth;
        (cmd as any).stepDatas = [
            { shapes: [], nodes: [sketch], type: "shape" },
            { shapes: [], nodes: [sketch], plane, type: "input" },
        ];
        (cmd as any).executeMainTask();
        return { sketch, cmd };
    }

    const otherBodies = (s: ReturnType<typeof scene>) =>
        s.doc.modelManager.findNodes((node) => node instanceof ParametricBodyNode && node !== s.block);

    test.each([
        {
            name: "dragged into the block commits a cut",
            depth: -5,
            operation: "cut",
            top: 20,
            volume: 32000 - 500,
        },
        {
            name: "dragged out of the block commits a join",
            depth: 5,
            operation: "fuse",
            top: 25,
            volume: 32000 + 500,
        },
    ])("a sketch on the top face $name", ({ depth, operation, top, volume }) => {
        const s = scene();
        extrudeSketch(s, planeAtZ(20), depth);

        expect(otherBodies(s)).toHaveLength(0);
        expect(s.block.features).toHaveLength(2);
        // The resolved operation is what is stored: Auto never reaches the file.
        expect((s.block.features[1] as ExtrudeFeatureData).operation).toBe(operation);
        expect(s.block.shape.isOk).toBe(true);
        expect(s.block.shape.value.boundingBox().max.z).toBeCloseTo(top);
        expect(Math.abs(s.block.shape.value.volume())).toBeCloseTo(volume, 3);
    });

    test("a sketch away from any body commits a new body", () => {
        const s = scene();
        extrudeSketch(s, planeAtZ(50), 5);

        expect(s.block.features).toHaveLength(1);
        const created = otherBodies(s) as ParametricBodyNode[];
        expect(created).toHaveLength(1);
        expect((created[0].features[0] as ExtrudeFeatureData).operation).toBeUndefined();
    });

    test("an explicit New body overrides Auto even into the material", () => {
        const s = scene();
        extrudeSketch(s, planeAtZ(20), -5, "option.command.operation.new");

        expect(s.block.features).toHaveLength(1);
        expect(otherBodies(s)).toHaveLength(1);
    });

    test("the live preview of a cut shows the hole plus the tool in red, standing in for the block", () => {
        const s = scene();
        const sketch = new SketchNode({ document: s.doc, plane: planeAtZ(20), data: rect(-5, -5, 5, 5) });
        s.doc.modelManager.addNode(sketch);
        const cmd = s.command();

        const preview: ExtrudePreview = (cmd as any).buildPreview({
            node: sketch,
            faces: [],
            origin: planeAtZ(20).origin,
            normal: XYZ.unitZ,
            anchor: planeAtZ(20).origin,
            dist: -5,
            startOffset: 0,
            arrowHovered: false,
        });

        expect(cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        expect(preview.hide).toEqual([s.block]);
        expect(preview.meshes.length).toBeGreaterThan(0);
        expect(preview.overlays).toHaveLength(1);
        expect(preview.overlays![0].color).toBe(VisualConfig.cutPreviewColor);
        expect(preview.overlays![0].onTop).toBe(true);
        // The overlay is the 10×10×5 tool, not the block.
        const position = preview.overlays![0].meshes[0].position;
        const zs = Array.from(position).filter((_, i) => i % 3 === 2);
        expect(Math.min(...zs)).toBeCloseTo(15);
        expect(Math.max(...zs)).toBeCloseTo(20);
    });

    /** Press-pulls the block's top face by `depth` through the command's commit. */
    function pressPullTop(s: ReturnType<typeof scene>, depth: number) {
        const faces = s.block.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        const index = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        expect(index).toBeGreaterThanOrEqual(0);
        const picked = {
            shape: faces[index],
            owner: { node: s.block },
            transform: Matrix4.identity(),
            indexes: [index],
            point: new XYZ({ x: 0, y: 0, z: 20 }),
        };
        const cmd = s.command();
        cmd.depth = depth;
        (cmd as any).stepDatas = [
            { shapes: [picked], nodes: [s.block], type: "shape" },
            { shapes: [picked], nodes: [s.block], plane: planeAtZ(20), type: "input" },
        ];
        (cmd as any).executeMainTask();
    }

    test.each([
        { name: "pushed in cuts", depth: -5, operation: "cut", top: 15 },
        { name: "pulled out joins", depth: 5, operation: "fuse", top: 25 },
    ])("a press-pull on the block's top face $name", ({ depth, operation, top }) => {
        const s = scene();
        pressPullTop(s, depth);

        expect(otherBodies(s)).toHaveLength(0);
        expect(s.block.features).toHaveLength(2);
        expect(s.block.features[1]).toMatchObject({ operation, source: { nodeId: s.block.id } });
        expect(s.block.shape.isOk).toBe(true);
        expect(s.block.shape.value.boundingBox().max.z).toBeCloseTo(top);
    });
});
