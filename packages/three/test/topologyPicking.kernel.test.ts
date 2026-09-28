// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AsyncController,
    BoundingBox,
    type IApplication,
    type ISubShape,
    Material,
    meshIndexesForTopology,
    NodeSelectionHandler,
    Plane,
    pickedTopologyIndex,
    Result,
    ShapeTypes,
    type SnapResult,
    type VisualShapeData,
    VisualStates,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockPicker, TestDocument } from "@spicy3d/core/test-utils";
import { ShapeFactory } from "@spicy3d/wasm";
import { Box3, Mesh } from "three";
import { SelectionManager } from "../../app/src/selectionManager";
import { FilletFeatureCommand } from "../../parametric/src/commands/edgeCornerCommand";
import {
    ExtrudeFeatureCommand,
    SelectSketchProfilesStep,
} from "../../parametric/src/commands/extrudeCommand";
import { EdgeReselectSession } from "../../parametric/src/commands/reselectSession";
import { captureEdgeRef } from "../../parametric/src/features/edgeRef";
import {
    type ExtrudeFeatureData,
    type FilletFeatureData,
    registerFeature,
} from "../../parametric/src/features/feature";
import "../../parametric/src/features/edgeCorner";
import "../../parametric/src/features/extrude";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { type OccShape, OccSubEdgeShape, OccSubFaceShape } from "../../wasm/src/shape";
import { createBox } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { ThreeVisual } from "../src/threeVisual";
import { TestView } from "./testView";

/** Preserve analytic topology but deliver a genuinely reordered, incomplete render mesh. */
function remapMesh(shape: OccShape) {
    const mesh = shape.mesh;
    const faces = mesh.faces!;
    const edges = mesh.edges!;
    const faceOrder = [5, 0, 3, 2, 4]; // topology face 1 deliberately has no triangles
    const edgeOrder = Array.from({ length: edges.range.length }, (_, i) => edges.range.length - i - 1);
    let faceStart = 0;
    const faceRanges = faceOrder.map((index, meshIndex) => {
        const range = faces.range[index];
        const sub = range.shape as OccSubFaceShape;
        const result = {
            start: faceStart,
            count: range.count,
            shape: new OccSubFaceShape({
                parent: shape,
                shape: wasm.TopoDS.face(sub.shape),
                index,
                meshIndex,
                id: `${shape.id}_f${index}`,
            }),
        };
        faceStart += range.count;
        return result;
    });
    mesh.faces = {
        ...faces,
        index: new Uint32Array(
            faceOrder.flatMap((i) =>
                Array.from(
                    faces.index.slice(faces.range[i].start, faces.range[i].start + faces.range[i].count),
                ),
            ),
        ),
        range: faceRanges,
    };
    let edgeStart = 0;
    mesh.edges = {
        ...edges,
        position: new Float32Array(
            edgeOrder.flatMap((i) =>
                Array.from(
                    edges.position.slice(
                        edges.range[i].start * 3,
                        (edges.range[i].start + edges.range[i].count) * 3,
                    ),
                ),
            ),
        ),
        range: edgeOrder.map((index, meshIndex) => {
            const range = edges.range[index];
            const sub = range.shape as OccSubEdgeShape;
            const result = {
                start: edgeStart,
                count: range.count,
                shape: new OccSubEdgeShape({
                    parent: shape,
                    shape: wasm.TopoDS.edge(sub.shape),
                    index,
                    meshIndex,
                    id: `${shape.id}_e${index}`,
                }),
            };
            edgeStart += range.count;
            return result;
        }),
    };
    // The replacement ranges own their local native wrappers.
    for (const range of [...faces.range, ...edges.range]) range.shape.dispose();
    return { faceOrder, edgeOrder };
}

class CommitFillet extends FilletFeatureCommand {
    constructor(private readonly app: IApplication) {
        super();
    }
    override get application() {
        return this.app;
    }
    commit(data: SnapResult) {
        this.stepDatas = [data];
        this.executeMainTask();
    }
}

class CommitPressPull extends ExtrudeFeatureCommand {
    constructor(private readonly app: IApplication) {
        super();
    }
    override get application() {
        return this.app;
    }
    commit(data: SnapResult) {
        this.depth = 2;
        this.stepDatas = [data, { ...data, type: "input", plane: Plane.XY }];
        this.executeMainTask();
    }
}

describe("mesh picks and topology references", () => {
    let doc: TestDocument;
    let visual: ThreeVisual;
    let view: TestView;
    let body: ParametricBodyNode;
    let shape: OccShape;
    let faceOrder: number[];
    let edgeOrder: number[];

    beforeEach(() => {
        const factory = new ShapeFactory();
        rs.stubGlobal("shapeFactory", factory);
        shape = createBox(factory) as unknown as OccShape;
        ({ faceOrder, edgeOrder } = remapMesh(shape));
        const app = createMockApplication();
        doc = new TestDocument({ application: app, picker: createMockPicker() });
        doc.selection = new SelectionManager(doc);
        visual = new ThreeVisual(doc, new NodeSelectionHandler(doc, true));
        doc.visual = visual;
        doc.modelManager.materials.push(new Material({ document: doc, name: "test", color: 0x00ff00 }));
        view = new TestView(doc, visual.context);
        Object.assign(app, { activeView: view });
        registerFeature("test-pick-topology", {
            display: "body.parametricBody",
            nodeIds: () => [],
            parameters: () => [],
            setParameter: (feature) => feature,
            evaluate: (_feature, context) => {
                if (context.tracking) {
                    context.tracking.outputFaceIds = Array.from({ length: 6 }, (_, i) => `face-${i}`);
                    context.tracking.outputEdgeIds = Array.from({ length: 12 }, (_, i) => `edge-${i}`);
                }
                return Result.ok(shape);
            },
        });
        body = new ParametricBodyNode({
            document: doc,
            featuresJson: JSON.stringify([{ id: "base", type: "test-pick-topology" }]),
        });
        doc.modelManager.addNode(body);
        visual.context.scene.updateMatrixWorld(true);
    });

    afterEach(() => {
        doc.selection.clearSelection();
        view.dispose();
        visual.dispose();
        doc.dispose();
        rs.unstubAllGlobals();
        rs.restoreAllMocks();
    });

    function lookAt(center: XYZ, direction: XYZ) {
        view.camera.up.set(0, 1, 0);
        view.camera.position.set(
            center.x + direction.x * 100,
            center.y + direction.y * 100,
            center.z + direction.z * 100,
        );
        view.camera.lookAt(center.x, center.y, center.z);
        view.camera.updateProjectionMatrix();
        view.camera.updateMatrixWorld(true);
    }

    function facePick(): VisualShapeData {
        const face = shape.mesh.faces!.range[0].shape as OccSubFaceShape;
        const center = BoundingBox.center(face.geometryBoundingBox());
        lookAt(center, XYZ.unitZ);
        const screen = view.worldToScreen(center);
        const picked = view.detectShapes(ShapeTypes.face, screen.x, screen.y)[0];
        expect(picked.shape).toBe(face);
        expect(picked.indexes).toEqual([0]);
        expect(pickedTopologyIndex(picked)).toBe(5);
        return picked;
    }

    function edgePick(): VisualShapeData {
        const edge = shape.mesh.edges!.range.find(({ shape }) => {
            const edge = shape as OccSubEdgeShape;
            return edge.startPoint().z === 30 && edge.endPoint().z === 30;
        })!.shape as OccSubEdgeShape;
        const center = edge.startPoint().add(edge.endPoint()).multiply(0.5);
        lookAt(center, XYZ.unitZ);
        const screen = view.worldToScreen(center);
        const picks = view.detectShapes(ShapeTypes.edge, screen.x, screen.y);
        const picked = picks.find((pick) => pick.shape === edge);
        expect(picked).not.toBeUndefined();
        if (!picked) throw new Error("Expected an edge ray hit");
        expect(picked.indexes).toEqual([edgeOrder.indexOf(edge.index)]);
        expect(picked.indexes[0]).not.toBe(edge.index);
        return picked;
    }

    test("nonidentity picks capture the topology edge ID in the actual fillet command", () => {
        const picked = edgePick();
        const index = pickedTopologyIndex(picked)!;
        new CommitFillet(doc.application).commit({ view, type: "shape", nodes: [body], shapes: [picked] });
        const feature = body.features[1] as FilletFeatureData;
        expect(feature.edges[0].edgeId).toBe(`edge-${index}`);
        expect(feature.edges[0].edgeId).not.toBe(`edge-${picked.indexes[0]}`);
    });

    test("an omitted face remains analytic but unpickable; a reordered preselected face captures its topology ID", async () => {
        const analytic = shape.findSubShapes(ShapeTypes.face);
        try {
            expect(analytic).toHaveLength(6);
            expect(shape.mesh.faces!.range).toHaveLength(5);
            expect(faceOrder).not.toContain(1);
            expect(meshIndexesForTopology(shape.mesh.faces!.range, 1)).toEqual([]);
            for (const range of shape.mesh.faces!.range) {
                const sub = range.shape as ISubShape;
                expect(sub.isSame(analytic[sub.index])).toBe(true);
            }
            const missingCenter = BoundingBox.center(analytic[1].geometryBoundingBox());
            lookAt(missingCenter, XYZ.unitX);
            const missingScreen = view.worldToScreen(missingCenter);
            const throughMissing = view.detectShapes(ShapeTypes.face, missingScreen.x, missingScreen.y);
            expect(throughMissing.length).toBeGreaterThan(0);
            expect(throughMissing.some((pick) => pickedTopologyIndex(pick) === 1)).toBe(false);

            const picked = facePick();
            const highlights = rs.spyOn(visual.highlighter, "addState");
            doc.selection.setSelectedShapes([picked], VisualStates.faceSelected, false);
            expect(highlights).toHaveBeenCalledWith(
                picked.owner,
                VisualStates.faceSelected,
                ShapeTypes.face,
                0,
            );
            const highlight = visual.highlighter.container.children[0];
            expect(highlight).toBeInstanceOf(Mesh);
            const bounds = new Box3().setFromObject(highlight);
            expect(bounds.min.z).toBeCloseTo(30);
            expect(bounds.max.z).toBeCloseTo(30);
            const controller = new AsyncController();
            const data = await new SelectSketchProfilesStep().execute(doc, controller);
            controller.dispose();
            expect(data?.shapes).toEqual([picked]);
            if (!data) throw new Error("Expected preselected profile");
            new CommitPressPull(doc.application).commit(data);
            const created = doc.modelManager.findNode(
                (node) => node instanceof ParametricBodyNode && node !== body,
            ) as ParametricBodyNode;
            expect(created).toBeInstanceOf(ParametricBodyNode);
            const feature = created.features[0] as ExtrudeFeatureData;
            expect(feature.source?.profiles[0].id).toBe("face-5");
        } finally {
            for (const face of analytic) face.dispose();
        }
    });

    test("topology-driven edge reselection preselects the right render range and captures its ID", async () => {
        const picked = edgePick();
        const index = pickedTopologyIndex(picked)!;
        const feature: FilletFeatureData = {
            id: "fillet",
            type: "fillet",
            radius: 1,
            edges: [captureEdgeRef(picked.shape as OccSubEdgeShape, `edge-${index}`)],
        };
        let preselected: VisualShapeData[] = [];
        doc.picker.pickShape = rs.fn(async () => {
            preselected = doc.selection.getSelectedShapes();
            return preselected;
        });
        const highlights = rs.spyOn(visual.highlighter, "addState");
        const controller = new AsyncController();
        try {
            const refs = await new EdgeReselectSession(body).pick(feature, 1, controller);
            expect(preselected).toHaveLength(1);
            expect(preselected[0].shape).toBe(picked.shape);
            expect(preselected[0].indexes).toEqual(picked.indexes);
            expect(refs?.[0].edgeId).toBe(`edge-${index}`);
            expect(highlights).toHaveBeenCalledWith(
                picked.owner,
                VisualStates.edgeSelected,
                ShapeTypes.edge,
                ...picked.indexes,
            );
        } finally {
            controller.dispose();
        }
    });
});
