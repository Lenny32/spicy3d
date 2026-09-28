// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AsyncController,
    BoundingBox,
    type IStep,
    Matrix4,
    Plane,
    PropertyUtils,
    Result,
    type ShapeType,
    ShapeTypes,
    VisualConfig,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, nearestOnSegment, TestDocument } from "@spicy3d/core/test-utils";
import { ExtrudeFeatureCommand, OPERATION_AUTO } from "../../src/commands/extrudeCommand";
import { SELECTED_PROFILE_STATE } from "../../src/commands/extrudeDragStep";
import { CUT_TOOL_OPACITY, JOIN_TINT_OPACITY } from "../../src/commands/toolOverlay";
import type { ExtrudeFeatureData } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";

function faceData(node: unknown) {
    return { shape: { shapeType: ShapeTypes.face }, owner: { node }, indexes: [0] } as any;
}

function mockShapeFactory(methods: Record<string, (...args: any[]) => any>) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: methods,
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

describe("ExtrudeFeatureCommand profile step", () => {
    let doc: TestDocument;
    let sketch: SketchNode;
    let other: SketchNode;

    beforeEach(() => {
        doc = new TestDocument({ application: createMockApplication() });
        sketch = new SketchNode({ document: doc, plane: Plane.XY, data: { entities: [], constraints: [] } });
        other = new SketchNode({ document: doc, plane: Plane.XY, data: { entities: [], constraints: [] } });
    });

    function profileStep(): IStep {
        return (new ExtrudeFeatureCommand() as any).getSteps()[0];
    }

    function mockSelection(shapes: any[], nodes: any[]) {
        doc.selection = {
            getSelectedShapes: () => shapes,
            getSelectedNodes: () => nodes,
            clearSelection: () => {},
        } as any;
    }

    test("uses preselected sketch faces and skips the picker", async () => {
        const faces = [faceData(sketch), faceData(sketch)];
        mockSelection(faces, []);
        const pickShape = rs.fn();
        doc.picker = { pickShape } as any;
        const controller = new AsyncController();

        const result = await profileStep().execute(doc, controller);

        expect(controller.result?.status).toBe("success");
        expect(pickShape).not.toHaveBeenCalled();
        expect(result!.nodes![0]).toBe(sketch);
        expect(result!.shapes).toEqual(faces);
    });

    test("keeps only the first sketch's faces when several sketches are selected", async () => {
        const mine = faceData(sketch);
        const foreign = faceData(other);
        mockSelection([mine, foreign], []);
        doc.picker = { pickShape: rs.fn() } as any;

        const result = await profileStep().execute(doc, new AsyncController());

        expect(result!.nodes![0]).toBe(sketch);
        expect(result!.shapes).toEqual([mine]);
    });

    test("a preselected sketch node without profiles extrudes the whole sketch", async () => {
        const restoreFactory = mockShapeFactory({
            combine: () => Result.ok({ shapeType: ShapeTypes.compound, findSubShapes: () => [] }),
        });
        try {
            mockSelection([], [sketch, other]);
            const pickShape = rs.fn();
            doc.picker = { pickShape } as any;
            const controller = new AsyncController();

            const result = await profileStep().execute(doc, controller);

            expect(controller.result?.status).toBe("success");
            expect(pickShape).not.toHaveBeenCalled();
            expect(result!.nodes![0]).toBe(sketch);
            expect(result!.shapes).toEqual([]);
        } finally {
            restoreFactory();
        }
    });

    test("a preselected sketch node selects all outer profiles", async () => {
        const restoreFactory = mockShapeFactory({
            line: (start: XYZ, end: XYZ) =>
                Result.ok({
                    shapeType: ShapeTypes.edge,
                    curve: { nearestFromPoint: (point: XYZ) => nearestOnSegment(start, end, point) },
                    startPoint: () => start,
                    endPoint: () => end,
                    firstParameter: () => 0,
                    lastParameter: () => 1,
                    pointAt: (t: number) => start.add(end.sub(start).multiply(t)),
                    intersect: () => [],
                    boundingBox: () =>
                        new BoundingBox(
                            {
                                x: Math.min(start.x, end.x),
                                y: Math.min(start.y, end.y),
                                z: Math.min(start.z, end.z),
                            },
                            {
                                x: Math.max(start.x, end.x),
                                y: Math.max(start.y, end.y),
                                z: Math.max(start.z, end.z),
                            },
                        ),
                    isEqual: () => false,
                }),
            combine: (edges: any[]) =>
                Result.ok({
                    shapeType: ShapeTypes.compound,
                    matrix: Matrix4.identity(),
                    mesh: { faces: undefined, edges: undefined },
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: (type: ShapeType) => (type === ShapeTypes.edge ? edges : []),
                }),
            wire: (edges: any[]) => Result.ok({ isClosed: () => edges.length > 1, edges }),
            face: (wires: any[]) => {
                const face: any = {
                    shapeType: ShapeTypes.face,
                    matrix: Matrix4.identity(),
                    boundingBox: () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }),
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: (type: ShapeType) =>
                        type === ShapeTypes.edge ? wires.flatMap((w: any) => w.edges) : [],
                };
                face.mesh = {
                    faces: {
                        range: [{ start: 0, count: 3, shape: face }],
                        index: new Uint32Array([0, 1, 2]),
                        position: new Float32Array(9),
                        normal: new Float32Array(9),
                        uv: new Float32Array(6),
                    },
                    edges: undefined,
                };
                return Result.ok(face);
            },
        });
        try {
            const square: SketchData = {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 1, 0] },
                    { id: 2, type: "line", params: [1, 0, 1, 1] },
                    { id: 3, type: "line", params: [1, 1, 0, 1] },
                    { id: 4, type: "line", params: [0, 1, 0, 0] },
                ],
                constraints: [],
            };
            const squareSketch = new SketchNode({ document: doc, plane: Plane.XY, data: square });
            doc.modelManager.addNode(squareSketch);
            const owner = { node: squareSketch, worldTransform: () => Matrix4.identity() };
            doc.visual = {
                context: { getVisual: (node: unknown) => (node === squareSketch ? owner : undefined) },
            } as any;
            const setSelectedShapes = rs.fn();
            doc.selection = {
                getSelectedShapes: () => [],
                getSelectedNodes: () => [squareSketch],
                setSelectedShapes,
                clearSelection: () => {},
            } as any;

            const result = await profileStep().execute(doc, new AsyncController());

            expect(result!.nodes![0]).toBe(squareSketch);
            expect(result!.shapes!.length).toBe(1);
            const face = result!.shapes![0];
            expect(face.owner).toBe(owner as any);
            expect(face.indexes).toEqual([0]);
            expect(face.point).toEqual(new XYZ({ x: 0.5, y: 0.5, z: 0 }));
            expect(setSelectedShapes).toHaveBeenCalledTimes(1);
            expect(setSelectedShapes.mock.calls[0][0]).toEqual(result!.shapes);
            expect(setSelectedShapes.mock.calls[0][1]).toBe(SELECTED_PROFILE_STATE);
        } finally {
            restoreFactory();
        }
    });

    test("a preselected planar body face is used, curved faces are ignored", async () => {
        const body = new ParametricBodyNode({ document: doc, features: [] });
        const curved = faceData(body);
        curved.shape.surface = () => ({ isPlanar: () => false });
        const planar = faceData(body);
        planar.shape.surface = () => ({ isPlanar: () => true });
        mockSelection([curved, planar], []);
        const pickShape = rs.fn();
        doc.picker = { pickShape } as any;
        const controller = new AsyncController();

        const result = await profileStep().execute(doc, controller);

        expect(controller.result?.status).toBe("success");
        expect(pickShape).not.toHaveBeenCalled();
        expect(result!.nodes![0]).toBe(body);
        expect(result!.shapes).toEqual([planar]);
    });

    test("picks faces interactively when nothing usable is selected", async () => {
        mockSelection([], []);
        const picked = [faceData(sketch)];
        const pickShape = rs.fn((_prompt: any, _controller: any, _options?: any) => Promise.resolve(picked));
        doc.picker = { pickShape } as any;

        const result = await profileStep().execute(doc, new AsyncController());

        expect(pickShape).toHaveBeenCalledTimes(1);
        const options = pickShape.mock.calls[0][2] as any;
        expect(options.shapeType).toBe(ShapeTypes.face);
        expect(options.multi).toBe(false);
        // Only planar faces are pickable — solid press-pull needs a plane.
        const planar = { surface: () => ({ isPlanar: () => true }) };
        const curved = { surface: () => ({ isPlanar: () => false }) };
        expect(options.shapeFilter.allow(planar, Matrix4.identity())).toBe(true);
        expect(options.shapeFilter.allow(curved, Matrix4.identity())).toBe(false);
        expect(result!.nodes![0]).toBe(sketch);
        expect(result!.shapes).toBe(picked);
        // A sketch drawn on a solid face is coplanar with it, so the viewport reports the
        // two in an order that flips as the pointer moves: the sketch has to lead.
        const bodyFace = faceData(new ParametricBodyNode({ document: doc, features: [] }));
        const sketchFace = faceData(sketch);
        expect(options.sortDetected([bodyFace, sketchFace])).toEqual([sketchFace, bodyFace]);
    });

    test("the interactive filter allows sketches and parametric bodies", async () => {
        mockSelection([], []);
        const pickShape = rs.fn((_prompt: any, _controller: any, _options?: any) => Promise.resolve([]));
        doc.picker = { pickShape } as any;

        await profileStep().execute(doc, new AsyncController());

        const allow = (pickShape.mock.calls[0][2] as any).nodeFilter.allow;
        expect(allow(sketch)).toBe(true);
        expect(allow(other)).toBe(true);
        expect(allow(new ParametricBodyNode({ document: doc, features: [] }))).toBe(true);
        expect(allow({})).toBe(false);
    });

    test("an empty interactive pick cancels the command", async () => {
        mockSelection([], []);
        doc.picker = { pickShape: rs.fn(() => Promise.resolve([])) } as any;

        const result = await profileStep().execute(doc, new AsyncController());

        expect(result).toBeUndefined();
    });
});

describe("ExtrudeFeatureCommand consumption", () => {
    const previewSketch = () =>
        new SketchNode({
            document: new TestDocument(),
            plane: Plane.XY,
            data: { entities: [], constraints: [] },
        });

    test("the drag preview meshes the prism's solid faces and outline edges", () => {
        const faceMesh = {
            range: [],
            index: new Uint32Array(),
            position: new Float32Array(),
            normal: new Float32Array(),
            uv: new Float32Array(),
        };
        const edgeMesh = { range: [], lineType: "solid", position: new Float32Array() };
        const prism = { dispose: rs.fn(), mesh: { faces: faceMesh, edges: edgeMesh } };
        const prismFn = rs.fn(() => Result.ok(prism));
        const restoreFactory = mockShapeFactory({ prism: prismFn });
        try {
            const cmd = new ExtrudeFeatureCommand();
            const face = { shapeType: ShapeTypes.face };
            const state = {
                dist: 5,
                normal: XYZ.unitZ,
                faces: [{ shape: face, transform: Matrix4.identity() }],
                node: previewSketch(),
            };

            const meshes = (cmd as any).buildPreview(state);

            expect(meshes.meshes).toEqual([faceMesh, edgeMesh]);
            // No operation: nothing to stand in for, so nothing is hidden.
            expect(meshes.hide).toBeUndefined();
            expect(prismFn).toHaveBeenCalledWith(face, new XYZ({ x: 0, y: 0, z: 5 }));
            expect(prism.dispose).toHaveBeenCalled();
        } finally {
            restoreFactory();
        }
    });

    test("the drag preview fuses touching profiles into one solid", () => {
        const fusedMesh = {
            range: [],
            index: new Uint32Array(),
            position: new Float32Array(),
            normal: new Float32Array(),
            uv: new Float32Array(),
        };
        const touchingBox = () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });
        const prismA = { dispose: rs.fn(), boundingBox: touchingBox };
        const prismB = { dispose: rs.fn(), boundingBox: touchingBox };
        const prisms = [prismA, prismB];
        const fused = { dispose: rs.fn(), mesh: { faces: fusedMesh, edges: undefined } };
        const fuseFn = rs.fn(() => Result.ok(fused));
        const restoreFactory = mockShapeFactory({
            prism: rs.fn(() => Result.ok(prisms.shift())),
            booleanFuse: fuseFn,
        });
        try {
            const cmd = new ExtrudeFeatureCommand();
            const state = {
                dist: 5,
                normal: XYZ.unitZ,
                faces: [
                    { shape: { shapeType: ShapeTypes.face }, transform: Matrix4.identity() },
                    { shape: { shapeType: ShapeTypes.face }, transform: Matrix4.identity() },
                ],
                node: previewSketch(),
            };

            const meshes = (cmd as any).buildPreview(state);

            expect(fuseFn).toHaveBeenCalledTimes(1);
            // the fuse disposes the inputs; the merged shape is disposed after meshing
            expect(prismA.dispose).toHaveBeenCalled();
            expect(prismB.dispose).toHaveBeenCalled();
            expect(fused.dispose).toHaveBeenCalled();
            expect(meshes.meshes).toEqual([fusedMesh]);
        } finally {
            restoreFactory();
        }
    });

    test("a symmetric preview sweeps both directions", () => {
        const fusedMesh = {
            range: [],
            index: new Uint32Array(),
            position: new Float32Array(),
            normal: new Float32Array(),
            uv: new Float32Array(),
        };
        const touchingBox = () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });
        const prisms = [
            { dispose: rs.fn(), boundingBox: touchingBox },
            { dispose: rs.fn(), boundingBox: touchingBox },
        ];
        const fused = { dispose: rs.fn(), mesh: { faces: fusedMesh, edges: undefined } };
        const prismFn = rs.fn((_face: any, _vec: XYZ) => Result.ok(prisms.shift()));
        const restoreFactory = mockShapeFactory({
            prism: prismFn,
            booleanFuse: rs.fn(() => Result.ok(fused)),
        });
        try {
            const cmd = new ExtrudeFeatureCommand();
            cmd.symmetric = true;
            const state = {
                dist: 5,
                normal: XYZ.unitZ,
                faces: [{ shape: { shapeType: ShapeTypes.face }, transform: Matrix4.identity() }],
                node: previewSketch(),
            };

            const meshes = (cmd as any).buildPreview(state);

            expect(prismFn).toHaveBeenCalledTimes(2);
            expect((prismFn.mock.calls[0][1] as XYZ).z).toBeCloseTo(5);
            expect((prismFn.mock.calls[1][1] as XYZ).z).toBeCloseTo(-5);
            expect(meshes.meshes).toEqual([fusedMesh]);
        } finally {
            restoreFactory();
        }
    });

    test("a join operation previews the boolean result against the target body", () => {
        const faceMesh = {
            range: [],
            index: new Uint32Array(),
            position: new Float32Array(),
            normal: new Float32Array(),
            uv: new Float32Array(),
        };
        const touchingBox = () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });
        const prism = {
            dispose: rs.fn(),
            boundingBox: touchingBox,
            volume: () => 8,
            extremaDistance: () => 0,
            mesh: { faces: faceMesh, edges: undefined },
        };
        const booleanResult = { dispose: rs.fn(), mesh: { faces: faceMesh, edges: undefined } };
        const fuseFn = rs.fn(() => Result.ok(booleanResult));
        const restoreFactory = mockShapeFactory({
            prism: rs.fn(() => Result.ok(prism)),
            booleanFuse: fuseFn,
            booleanCommon: () => Result.ok({ volume: () => 8, dispose: () => {} }),
        });
        try {
            const app = createMockApplication();
            const doc = new TestDocument({ application: app });
            (app as any).activeView = { document: doc };
            const target = new ParametricBodyNode({ document: doc, features: [] });
            (target as any)._shape = Result.ok({
                shapeType: ShapeTypes.solid,
                isEqual: () => false,
                boundingBox: touchingBox,
            });
            doc.modelManager.addNode(target);

            const cmd = new ExtrudeFeatureCommand();
            (cmd as any)._application = app;
            cmd.operation = "option.command.operation.join";
            const state = {
                dist: 5,
                normal: XYZ.unitZ,
                faces: [{ shape: { shapeType: ShapeTypes.face }, transform: Matrix4.identity() }],
                node: new SketchNode({
                    document: doc,
                    plane: Plane.XY,
                    data: { entities: [], constraints: [] },
                }),
            };

            const preview = (cmd as any).buildPreview(state);

            expect(fuseFn).toHaveBeenCalledTimes(1);
            // The result stands in for the body it was built from: the drag step hides
            // that node, so the preview is not drawn over geometry it duplicates.
            expect(preview.hide).toEqual([target]);
            expect(preview.meshes).toEqual([faceMesh]);
            // The added volume is tinted faintly over the result.
            expect(preview.overlays).toEqual([
                { meshes: [faceMesh], color: VisualConfig.joinPreviewColor, opacity: JOIN_TINT_OPACITY },
            ]);
            expect(prism.dispose).toHaveBeenCalled();
            expect(booleanResult.dispose).toHaveBeenCalled();
        } finally {
            restoreFactory();
        }
    });

    /**
     * Sketch/prism/boolean mocks where every prism carries a bounding box from
     * `boxAt(callIndex)`, so intersection auto-detection can be steered per call.
     */
    function joinScenario(boxAt: (call: number) => BoundingBox) {
        let prismCalls = 0;
        const fusedShape = {
            shapeType: ShapeTypes.solid,
            isEqual: () => false,
            dispose: rs.fn(),
            findSubShapes: () => [],
            mesh: { edges: { range: [] } },
        };
        const restoreFactory = mockShapeFactory({
            line: (start: XYZ, end: XYZ) =>
                Result.ok({
                    shapeType: ShapeTypes.edge,
                    curve: { nearestFromPoint: (point: XYZ) => nearestOnSegment(start, end, point) },
                    startPoint: () => start,
                    endPoint: () => end,
                    firstParameter: () => 0,
                    lastParameter: () => 1,
                    pointAt: (t: number) => start.add(end.sub(start).multiply(t)),
                    intersect: () => [],
                    boundingBox: () =>
                        new BoundingBox(
                            {
                                x: Math.min(start.x, end.x),
                                y: Math.min(start.y, end.y),
                                z: Math.min(start.z, end.z),
                            },
                            {
                                x: Math.max(start.x, end.x),
                                y: Math.max(start.y, end.y),
                                z: Math.max(start.z, end.z),
                            },
                        ),
                    isEqual: () => false,
                }),
            combine: (edges: any[]) =>
                Result.ok({
                    shapeType: ShapeTypes.compound,
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: (type: ShapeType) => (type === ShapeTypes.edge ? edges : []),
                }),
            wire: (edges: any[]) => Result.ok({ isClosed: () => edges.length > 1, edges }),
            face: (wires: any[]) =>
                Result.ok({
                    shapeType: ShapeTypes.face,
                    isEqual: () => false,
                    findSubShapes: (type: ShapeType) =>
                        type === ShapeTypes.edge ? wires.flatMap((w: any) => w.edges) : [],
                    area: () => 0,
                    boundingBox: () => BoundingBox.zero,
                }),
            prism: () => {
                const box = boxAt(prismCalls++);
                return Result.ok({
                    shapeType: ShapeTypes.solid,
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: () => [],
                    boundingBox: () => box,
                    volume: () => 1,
                    extremaDistance: () => 0,
                    mesh: { edges: { range: [] } },
                });
            },
            booleanFuse: () => Result.ok(fusedShape),
            // Shares the box's volume: the command's prism goes into the target.
            booleanCommon: () => Result.ok({ volume: () => 1, dispose: () => {} }),
        });
        const app = createMockApplication();
        const doc = new TestDocument({ application: app });
        (app as any).activeView = { document: doc };
        const square: SketchData = {
            entities: [
                { id: 1, type: "line", params: [0, 0, 1, 0] },
                { id: 2, type: "line", params: [1, 0, 1, 1] },
                { id: 3, type: "line", params: [1, 1, 0, 1] },
                { id: 4, type: "line", params: [0, 1, 0, 0] },
            ],
            constraints: [],
        };
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square });
        doc.modelManager.addNode(sketch);
        const targetSketch = new SketchNode({ document: doc, plane: Plane.XY, data: square });
        doc.modelManager.addNode(targetSketch);
        const target = new ParametricBodyNode({
            document: doc,
            features: [{ id: "t1", type: "extrude", sketchId: targetSketch.id, depth: 2 }],
        });
        doc.modelManager.addNode(target);

        const cmd = new ExtrudeFeatureCommand();
        (cmd as any)._application = app;
        cmd.operation = "option.command.operation.join";
        cmd.depth = 5;
        (cmd as any).stepDatas = [
            { shapes: [], nodes: [sketch], type: "shape" },
            {
                shapes: [],
                nodes: [sketch],
                point: new XYZ({ x: 0, y: 0, z: 5 }),
                plane: Plane.XY,
                type: "input",
            },
        ];
        return { restoreFactory, doc, sketch, target, cmd };
    }

    test("join appends the extrude feature to the intersecting body instead of creating one", () => {
        const near = new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });
        const { restoreFactory, doc, sketch, target, cmd } = joinScenario(() => near);
        try {
            const addNode = rs.spyOn(doc.modelManager, "addNode");

            (cmd as any).executeMainTask();

            // No new body: the feature grows on the intersecting target, fused with its shape.
            expect(addNode).not.toHaveBeenCalled();
            expect(target.features.length).toBe(2);
            expect(target.features[1]).toMatchObject({
                type: "extrude",
                sketchId: sketch.id,
                depth: 5,
                operation: "fuse",
            });
            expect(sketch.visible).toBe(false);
            expect(target.shape.isOk).toBe(true);

            doc.history.undo();
            expect(target.features.length).toBe(1);
            expect(sketch.visible).toBe(true);
        } finally {
            restoreFactory();
        }
    });

    test("join without an intersecting body creates a standalone body", () => {
        const near = new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
        const far = new BoundingBox({ x: 100, y: 100, z: 100 }, { x: 101, y: 101, z: 101 });
        // The first prism builds the target body; the command's own prisms are far away.
        const { restoreFactory, doc, sketch, target, cmd } = joinScenario((call) =>
            call === 0 ? near : far,
        );
        try {
            (cmd as any).executeMainTask();

            expect(target.features.length).toBe(1);
            const created = doc.modelManager.findNode(
                (node) => node instanceof ParametricBodyNode && node !== target,
            ) as ParametricBodyNode;
            expect(created).not.toBeUndefined();
            expect((created.features[0] as ExtrudeFeatureData).operation).toBeUndefined();
            expect(sketch.visible).toBe(false);
        } finally {
            restoreFactory();
        }
    });

    test("creating the body hides the consumed sketch and undo restores it", () => {
        const restoreFactory = mockShapeFactory({
            line: (start: XYZ, end: XYZ) =>
                Result.ok({
                    shapeType: ShapeTypes.edge,
                    curve: { nearestFromPoint: (point: XYZ) => nearestOnSegment(start, end, point) },
                    startPoint: () => start,
                    endPoint: () => end,
                    firstParameter: () => 0,
                    lastParameter: () => 1,
                    pointAt: (t: number) => start.add(end.sub(start).multiply(t)),
                    intersect: () => [],
                    boundingBox: () =>
                        new BoundingBox(
                            {
                                x: Math.min(start.x, end.x),
                                y: Math.min(start.y, end.y),
                                z: Math.min(start.z, end.z),
                            },
                            {
                                x: Math.max(start.x, end.x),
                                y: Math.max(start.y, end.y),
                                z: Math.max(start.z, end.z),
                            },
                        ),
                    isEqual: () => false,
                }),
            combine: (edges: any[]) =>
                Result.ok({
                    shapeType: ShapeTypes.compound,
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: (type: ShapeType) => (type === ShapeTypes.edge ? edges : []),
                }),
            wire: (edges: any[]) => Result.ok({ isClosed: () => edges.length > 1, edges }),
            face: (wires: any[]) =>
                Result.ok({
                    shapeType: ShapeTypes.face,
                    isEqual: () => false,
                    findSubShapes: (type: ShapeType) =>
                        type === ShapeTypes.edge ? wires.flatMap((w: any) => w.edges) : [],
                    area: () => 0,
                    boundingBox: () => BoundingBox.zero,
                }),
            prism: () =>
                Result.ok({
                    shapeType: ShapeTypes.solid,
                    isEqual: () => false,
                    dispose: () => {},
                    findSubShapes: () => [],
                    mesh: { edges: { range: [] } },
                }),
        });
        try {
            const app = createMockApplication();
            const doc = new TestDocument({ application: app });
            (app as any).activeView = { document: doc };
            const square: SketchData = {
                entities: [
                    { id: 1, type: "line", params: [0, 0, 1, 0] },
                    { id: 2, type: "line", params: [1, 0, 1, 1] },
                    { id: 3, type: "line", params: [1, 1, 0, 1] },
                    { id: 4, type: "line", params: [0, 1, 0, 0] },
                ],
                constraints: [],
            };
            const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square });
            doc.modelManager.addNode(sketch);

            const cmd = new ExtrudeFeatureCommand();
            (cmd as any)._application = app;
            cmd.depth = 5;
            (cmd as any).stepDatas = [
                { shapes: [], nodes: [sketch], type: "shape" },
                {
                    shapes: [],
                    nodes: [sketch],
                    point: new XYZ({ x: 0, y: 0, z: 5 }),
                    plane: Plane.XY,
                    type: "input",
                },
            ];

            (cmd as any).executeMainTask();

            expect(sketch.visible).toBe(false);

            doc.history.undo();
            expect(sketch.visible).toBe(true);
        } finally {
            restoreFactory();
        }
    });

    /**
     * A parametric body whose mocked shape exposes one planar top face (unit square at
     * height z=2), plus the face pick data as the viewport would report it.
     */
    function bodyFaceScenario() {
        const edgeOf = (start: XYZ, end: XYZ) => ({
            shapeType: ShapeTypes.edge,
            curve: { basisCurve: { direction: end.sub(start).normalize() } },
            startPoint: () => start,
            endPoint: () => end,
            isEqual: () => false,
        });
        const edges = [
            edgeOf(new XYZ({ x: 0, y: 0, z: 2 }), new XYZ({ x: 1, y: 0, z: 2 })),
            edgeOf(new XYZ({ x: 1, y: 0, z: 2 }), new XYZ({ x: 1, y: 1, z: 2 })),
            edgeOf(new XYZ({ x: 1, y: 1, z: 2 }), new XYZ({ x: 0, y: 1, z: 2 })),
            edgeOf(new XYZ({ x: 0, y: 1, z: 2 }), new XYZ({ x: 0, y: 0, z: 2 })),
        ];
        const topFace = {
            shapeType: ShapeTypes.face,
            isEqual: () => false,
            dispose: rs.fn(),
            normal: () => [new XYZ({ x: 0, y: 0, z: 2 }), XYZ.unitZ],
            findSubShapes: (type: ShapeType) => (type === ShapeTypes.edge ? edges : []),
            outerWire: () => ({
                findSubShapes: (type: ShapeType) => (type === ShapeTypes.edge ? edges : []),
            }),
            area: () => 0,
            boundingBox: () => BoundingBox.zero,
        };
        const bodyShape = {
            shapeType: ShapeTypes.solid,
            isEqual: () => false,
            dispose: rs.fn(),
            boundingBox: () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 2 }),
            findSubShapes: (type: ShapeType) => (type === ShapeTypes.face ? [topFace] : []),
        };
        const prismShape = {
            shapeType: ShapeTypes.solid,
            isEqual: () => false,
            dispose: rs.fn(),
            boundingBox: () => new BoundingBox({ x: 0, y: 0, z: 1 }, { x: 1, y: 1, z: 7 }),
            findSubShapes: () => [],
            volume: () => 7,
            extremaDistance: () => 0,
            mesh: { edges: { range: [] } },
        };
        // The common volume of the press-pull prism and its source body: 0 = pulled out.
        const common = { volume: 0 };
        const restoreFactory = mockShapeFactory({
            combine: () => Result.ok(bodyShape),
            prism: () => Result.ok(prismShape),
            booleanFuse: () => Result.ok(prismShape),
            booleanCut: () => Result.ok(prismShape),
            booleanCommon: () => Result.ok({ volume: () => common.volume, dispose: () => {} }),
        });
        const app = createMockApplication();
        const doc = new TestDocument({ application: app });
        (app as any).activeView = { document: doc };
        const body = new ParametricBodyNode({ document: doc, features: [] });
        doc.modelManager.addNode(body);
        const picked = {
            shape: topFace,
            owner: { node: body },
            transform: Matrix4.identity(),
            indexes: [0],
            point: new XYZ({ x: 0.5, y: 0.5, z: 2 }),
        } as any;
        const cmd = new ExtrudeFeatureCommand();
        (cmd as any)._application = app;
        cmd.depth = 7;
        (cmd as any).stepDatas = [
            { shapes: [picked], nodes: [body], type: "shape" },
            {
                shapes: [picked],
                nodes: [body],
                point: new XYZ({ x: 0.5, y: 0.5, z: 7 }),
                plane: Plane.XY,
                type: "input",
            },
        ];
        return { restoreFactory, doc, body, topFace, cmd, common };
    }

    test("a body face extrudes into a standalone body referencing the source node", () => {
        const { restoreFactory, doc, body, cmd } = bodyFaceScenario();
        try {
            cmd.operation = "option.command.operation.new";
            (cmd as any).executeMainTask();

            const created = doc.modelManager.findNode(
                (node) => node instanceof ParametricBodyNode && node !== body,
            ) as ParametricBodyNode;
            expect(created).not.toBeUndefined();
            const feature = created.features[0] as ExtrudeFeatureData;
            expect(feature.sketchId).toBeUndefined();
            expect(feature.depth).toBe(7);
            expect(feature.source?.nodeId).toBe(body.id);
            expect(feature.source?.profiles.length).toBe(1);
            // The source body is not consumed — only sketches are hidden.
            expect(body.visible).toBe(true);
            expect(created.shape.isOk).toBe(true);
        } finally {
            restoreFactory();
        }
    });

    test("a start offset is recorded on the committed feature", () => {
        const { restoreFactory, doc, body, cmd } = bodyFaceScenario();
        try {
            cmd.operation = "option.command.operation.new";
            cmd.startOffset = 3;

            (cmd as any).executeMainTask();

            const created = doc.modelManager.findNode(
                (node) => node instanceof ParametricBodyNode && node !== body,
            ) as ParametricBodyNode;
            expect((created.features[0] as ExtrudeFeatureData).startOffset).toBe(3);
        } finally {
            restoreFactory();
        }
    });

    test("join on a body face appends the feature to the intersecting owner body", () => {
        const { restoreFactory, doc, body, cmd } = bodyFaceScenario();
        try {
            cmd.operation = "option.command.operation.join";
            const addNode = rs.spyOn(doc.modelManager, "addNode");

            (cmd as any).executeMainTask();

            expect(addNode).not.toHaveBeenCalled();
            expect(body.features.length).toBe(1);
            expect(body.features[0]).toMatchObject({
                type: "extrude",
                operation: "fuse",
                source: { nodeId: body.id },
            });
            expect(body.visible).toBe(true);

            doc.history.undo();
            expect(body.features.length).toBe(0);
        } finally {
            restoreFactory();
        }
    });

    test.each([
        { name: "pulled out of the body joins it", commonVolume: 0, operation: "fuse" },
        { name: "pushed into the body cuts it", commonVolume: 3, operation: "cut" },
    ])("Auto press-pull: $name", ({ commonVolume, operation }) => {
        const { restoreFactory, doc, body, cmd, common } = bodyFaceScenario();
        try {
            common.volume = commonVolume;
            const addNode = rs.spyOn(doc.modelManager, "addNode");
            expect(cmd.operation).toBe(OPERATION_AUTO);

            (cmd as any).executeMainTask();

            // The source body is the one the prism meets: the feature lands on it, resolved.
            expect(addNode).not.toHaveBeenCalled();
            expect(body.features).toHaveLength(1);
            expect(body.features[0]).toMatchObject({
                type: "extrude",
                operation,
                source: { nodeId: body.id },
            });
        } finally {
            restoreFactory();
        }
    });
});

describe("ExtrudeFeatureCommand Auto operation", () => {
    const faceMesh = (tag: number) => ({
        range: [],
        index: new Uint32Array([tag]),
        position: new Float32Array(),
        normal: new Float32Array(),
        uv: new Float32Array(),
        color: 0xdedede,
    });
    const edgeMesh = { range: [], lineType: "solid", position: new Float32Array() };

    /**
     * A target body (unit box) and a command whose single prism has `prismBox`; the kernel's
     * common volume and minimum distance of the prism against the body are `contact`.
     */
    function autoScenario(prismBox: BoundingBox, contact: { volume: number; distance: number }) {
        const toolFaces = faceMesh(1);
        const resultFaces = faceMesh(2);
        const prism = {
            dispose: rs.fn(),
            boundingBox: () => prismBox,
            volume: () => 4,
            extremaDistance: rs.fn((_other: unknown) => contact.distance),
            mesh: { faces: toolFaces, edges: edgeMesh },
        };
        const result = { dispose: rs.fn(), mesh: { faces: resultFaces, edges: undefined } };
        const booleanCut = rs.fn((_a: unknown[], _b: unknown[]) => Result.ok(result));
        const booleanFuse = rs.fn((_a: unknown[], _b: unknown[], _simplify: boolean) => Result.ok(result));
        const booleanCommon = rs.fn((_a: unknown[], _b: unknown[]) =>
            Result.ok({ volume: () => contact.volume, dispose: () => {} }),
        );
        const restoreFactory = mockShapeFactory({
            prism: () => Result.ok(prism),
            booleanCut,
            booleanFuse,
            booleanCommon,
        });
        const app = createMockApplication();
        const doc = new TestDocument({ application: app });
        (app as any).activeView = { document: doc };
        const target = new ParametricBodyNode({ document: doc, features: [] });
        (target as any)._shape = Result.ok({
            shapeType: ShapeTypes.solid,
            isEqual: () => false,
            boundingBox: () => new BoundingBox({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }),
        });
        doc.modelManager.addNode(target);
        const cmd = new ExtrudeFeatureCommand();
        (cmd as any)._application = app;
        const state = {
            dist: 5,
            normal: XYZ.unitZ,
            faces: [{ shape: { shapeType: ShapeTypes.face }, transform: Matrix4.identity() }],
            node: new SketchNode({ document: doc, plane: Plane.XY, data: { entities: [], constraints: [] } }),
        };
        const preview = () => (cmd as any).buildPreview(state);
        return { restoreFactory, cmd, target, prism, preview, booleanCut, booleanFuse, booleanCommon };
    }

    const inside = new BoundingBox({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1.5, y: 1.5, z: 1.5 });
    const above = new BoundingBox({ x: 0, y: 0, z: 2 }, { x: 2, y: 2, z: 7 });
    const far = new BoundingBox({ x: 10, y: 10, z: 10 }, { x: 12, y: 12, z: 12 });

    test("is the default of a new extrude", () => {
        expect(new ExtrudeFeatureCommand().operation).toBe(OPERATION_AUTO);
    });

    test("an extrusion into the body's material previews a cut with the tool in red on top", () => {
        const s = autoScenario(inside, { volume: 1, distance: 0 });
        try {
            const preview = s.preview();

            expect(s.booleanCut).toHaveBeenCalledTimes(1);
            expect(s.booleanFuse).not.toHaveBeenCalled();
            expect(preview.meshes).toEqual([faceMesh(2)]);
            expect(preview.hide).toEqual([s.target]);
            expect(preview.overlays).toEqual([
                {
                    meshes: [faceMesh(1), edgeMesh],
                    color: VisualConfig.cutPreviewColor,
                    opacity: CUT_TOOL_OPACITY,
                    onTop: true,
                },
            ]);
            expect(s.cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        } finally {
            s.restoreFactory();
        }
    });

    test("an extrusion touching the body and growing outward previews a join with a faint tint", () => {
        const s = autoScenario(above, { volume: 0, distance: 0 });
        try {
            const preview = s.preview();

            expect(s.booleanFuse).toHaveBeenCalledTimes(1);
            expect(s.booleanCut).not.toHaveBeenCalled();
            expect(preview.hide).toEqual([s.target]);
            expect(preview.overlays).toEqual([
                { meshes: [faceMesh(1)], color: VisualConfig.joinPreviewColor, opacity: JOIN_TINT_OPACITY },
            ]);
            expect(s.cmd.autoOperationLabel).toBe("option.command.operation.auto.join");
        } finally {
            s.restoreFactory();
        }
    });

    test("an extrusion apart from every body previews a new body without any boolean", () => {
        const s = autoScenario(far, { volume: 0, distance: 8 });
        try {
            const preview = s.preview();

            // The bounding boxes are apart: the kernel is not even asked.
            expect(s.booleanCommon).not.toHaveBeenCalled();
            expect(s.prism.extremaDistance).not.toHaveBeenCalled();
            expect(preview.meshes).toEqual([faceMesh(1), edgeMesh]);
            expect(preview.hide).toBeUndefined();
            expect(preview.overlays).toBeUndefined();
            expect(s.cmd.autoOperationLabel).toBe("option.command.operation.auto.new");
        } finally {
            s.restoreFactory();
        }
    });

    test("overlapping boxes whose shapes stay apart are a new body, not a join", () => {
        const s = autoScenario(inside, { volume: 0, distance: 0.5 });
        try {
            const preview = s.preview();

            expect(s.booleanCommon).toHaveBeenCalledTimes(1);
            expect(preview.hide).toBeUndefined();
            expect(s.cmd.autoOperationLabel).toBe("option.command.operation.auto.new");
        } finally {
            s.restoreFactory();
        }
    });

    test("an explicit operation overrides Auto, and choosing Auto again re-detects", () => {
        const s = autoScenario(inside, { volume: 1, distance: 0 });
        try {
            s.cmd.operation = "option.command.operation.join";
            s.preview();
            expect(s.booleanFuse).toHaveBeenCalledTimes(1);
            expect(s.booleanCut).not.toHaveBeenCalled();

            s.cmd.operation = OPERATION_AUTO;
            s.preview();
            expect(s.booleanCut).toHaveBeenCalledTimes(1);
            expect(s.cmd.autoOperationLabel).toBe("option.command.operation.auto.cut");
        } finally {
            s.restoreFactory();
        }
    });

    test("hidden bodies are left alone by Auto", () => {
        const s = autoScenario(inside, { volume: 1, distance: 0 });
        try {
            s.target.visible = false;

            const preview = s.preview();

            expect(s.booleanCut).not.toHaveBeenCalled();
            expect(preview.hide).toBeUndefined();
        } finally {
            s.restoreFactory();
        }
    });

    test("the operation choice is not carried over to the next extrude", () => {
        const operation = PropertyUtils.getProperty(ExtrudeFeatureCommand.prototype, "operation")!;
        const depth = PropertyUtils.getProperty(ExtrudeFeatureCommand.prototype, "depth")!;
        const cmd = new ExtrudeFeatureCommand();
        expect((cmd as any).isPropertyCached(operation)).toBe(false);
        expect((cmd as any).isPropertyCached(depth)).toBe(true);
    });

    test("the options tab's Auto item reads the command's resolved label", () => {
        const combobox = PropertyUtils.getProperty(ExtrudeFeatureCommand.prototype, "operation")!.combobox!;
        expect(combobox.items.at(0)).toBe(OPERATION_AUTO);
        expect(combobox.liveLabels.get(OPERATION_AUTO)).toBe("autoOperationLabel");
    });
});
