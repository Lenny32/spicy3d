// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DocumentRebuilds,
    EditableShapeNode,
    GroupNode,
    type IDocument,
    Matrix4,
    NodeChildList,
    type PerformanceDetails,
    PerformanceTrace,
    PubSub,
    Result,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisual,
    MockShape,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { MeshLambertMaterial, Scene } from "three";
import { Document } from "../../app/src/document";
import "../../parametric/src/features/boolean";
import { registerFeature } from "../../parametric/src/features/feature";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { CameraController } from "../src/cameraController";
import { ThreeMeshExporter } from "../src/meshExporter";
import { ThreeGeometry } from "../src/threeGeometry";
import type { ThreeView } from "../src/threeView";
import { ThreeVisualContext } from "../src/threeVisualContext";

class ObservedShape extends MockShape {
    readonly accesses: Array<PerformanceDetails | undefined> = [];
    override get mesh() {
        this.accesses.push(PerformanceTrace.shapeDetails(this));
        const mesh = super.mesh;
        // The shared mock's vertex buffer is intentionally minimal; these tests use face/edge bounds.
        mesh.vertexs = undefined;
        return mesh;
    }
}

describe("scheduled bodies in the Three visual lifecycle", () => {
    let doc: TestDocument;
    let context: ThreeVisualContext;
    let outputs: ObservedShape[];
    let computational: ObservedShape[];

    const steps = () => Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, type: "test-visual-step" }));

    beforeEach(() => {
        outputs = [];
        computational = [];
        doc = new TestDocument({ selection: createMockSelection() });
        doc.visual = createMockVisual({ document: doc });
        context = new ThreeVisualContext(doc.visual, new Scene());
        Object.assign(doc.visual, { context });
        context.materialMap.set("", new MeshLambertMaterial());
        rs.stubGlobal("shapeFactory", {
            combine: () => Result.ok(new ObservedShape()),
            booleanFuse: () => Result.ok(new ObservedShape()),
        });
        registerFeature("test-visual-step", {
            display: "body.parametricBody",
            nodeIds: () => [],
            parameters: () => [],
            setParameter: (feature) => feature,
            evaluate: (feature, featureContext) => {
                // This mimics an explicit computational mesh demand, not a visual mesh.
                const intermediate = new ObservedShape({ id: `intermediate-${computational.length}` });
                void intermediate.mesh;
                computational.push(intermediate);
                const shape = new ObservedShape({ id: `${feature.id}-${outputs.length}` });
                outputs.push(shape);
                if (featureContext.tracking) {
                    featureContext.tracking.outputFaceIds = [`${feature.id}:face`];
                    featureContext.tracking.outputEdgeIds = [`${feature.id}:edge`];
                }
                return Result.ok(shape);
            },
        });
    });

    afterEach(async () => {
        PerformanceTrace.disable();
        context.dispose();
        doc.dispose();
        await DocumentRebuilds.settled(doc);
        rs.unstubAllGlobals();
        rs.restoreAllMocks();
    });

    function body(visible = true) {
        const node = new ParametricBodyNode({ document: doc, featuresJson: JSON.stringify(steps()) });
        node.visible = visible;
        doc.modelManager.addNode(node);
        return node;
    }

    function geometry(node: ParametricBodyNode | EditableShapeNode) {
        const visual = context.getVisual(node);
        expect(visual).toBeInstanceOf(ThreeGeometry);
        return visual as ThreeGeometry;
    }

    test("cold visual creation yields; completion publishes the final mesh with exact body ownership", async () => {
        PerformanceTrace.enable();
        const node = body();
        const visual = geometry(node);
        expect(node.isRebuilding).toBe(true);
        expect(outputs).toHaveLength(0);
        expect(visual.wholeVisual()).toHaveLength(0);
        const creations = PerformanceTrace.snapshot().records.filter((x) => x.stage === "visual.create");
        expect(creations).toHaveLength(1);
        expect(creations[0].details).toEqual({
            nodeId: node.id,
            nodeType: "ParametricBodyNode",
            visible: true,
        });
        expect(await node.whenRebuilt()).toBe(true);
        expect(outputs).toHaveLength(12);
        expect(visual.faces()?.geometry.getAttribute("position").count).toBe(3);
        expect(outputs.at(-1)?.accesses).toEqual([{ nodeId: node.id, meshKind: "body", visible: true }]);
        expect(outputs.slice(0, -1).every((shape) => shape.accesses.length === 0)).toBe(true);
        expect(computational.map((shape) => shape.accesses)).toEqual(
            Array.from({ length: 12 }, () => [undefined]),
        );
    });

    test("initial visuals yield between small nodes with the entire model available", async () => {
        const source = new TestDocument();
        const nodes = Array.from(
            { length: 3 },
            (_, index) => new GroupNode({ document: source, name: `shape ${index}` }),
        );
        source.modelManager.addNode(...nodes);
        const stored = source.modelManager.serialize();
        const displayed: string[] = [];
        const add = rs.spyOn(context, "addNode").mockImplementation((batch) => {
            displayed.push(
                ...batch.filter((node) => !(node === doc.modelManager.rootNode)).map((node) => node.id),
            );
        });
        const progress: number[] = [];
        const onProgress: Parameters<typeof PubSub.default.sub<"rebuildProgress">>[1] = (
            _document,
            id,
            value,
        ) => {
            if (id === "visual-load" && value) progress.push(value.completed);
        };
        PubSub.default.sub("rebuildProgress", onProgress);
        let completed = false;
        const loading = doc.modelManager.deserialize(stored).then(() => {
            completed = true;
        });
        try {
            await Promise.resolve();
            expect(displayed).toEqual([]);
            expect(doc.modelManager.findNode((node) => node.id === nodes[2].id)?.name).toBe("shape 2");
            await rs.waitFor(() => expect(displayed.length).toBeGreaterThan(0), { interval: 1 });
            expect(completed).toBe(false);
            expect(displayed.length).toBeLessThan(3);
            await loading;
            expect(displayed).toEqual(nodes.map((node) => node.id));
            expect(progress).toEqual([0, 1, 2, 3]);
            expect(completed).toBe(true);
        } finally {
            await loading;
            PubSub.default.remove("rebuildProgress", onProgress);
            add.mockRestore();
            source.dispose();
        }
    });

    test.each([false, true])("initial visual cleanup handles failure/disposal (%s)", async (dispose) => {
        const progress: Array<{ completed: number; total: number } | undefined> = [];
        const onProgress: Parameters<typeof PubSub.default.sub<"rebuildProgress">>[1] = (
            _document,
            id,
            value,
        ) => {
            if (id === "visual-load") progress.push(value);
        };
        PubSub.default.sub("rebuildProgress", onProgress);
        const add = rs.spyOn(context, "addNode").mockImplementation(() => {
            throw new Error("mesh failed");
        });
        const loading = doc.modelManager.deserialize(doc.modelManager.serialize());
        const outcome = loading.catch((error: Error) => error.message);
        try {
            await Promise.resolve();
            if (dispose) context.dispose();
            expect(await outcome).toBe(dispose ? undefined : "mesh failed");
            expect(add).toHaveBeenCalledTimes(dispose ? 0 : 1);
            expect(progress).toEqual([{ completed: 0, total: 1 }, undefined]);
        } finally {
            await outcome;
            PubSub.default.remove("rebuildProgress", onProgress);
            add.mockRestore();
        }
    });

    test.each([3, 12])("Document.load returns with the real mesh installed (%s features)", async (count) => {
        const source = new Document(createMockApplication(), "synthetic visual load");
        source.modelManager.addNode(
            new ParametricBodyNode({
                document: source,
                featuresJson: JSON.stringify(steps().slice(0, count)),
            }),
        );
        const stored = source.serialize();
        source.dispose();
        const application = createMockApplication();
        let loadingContext: ThreeVisualContext | undefined;
        let loaded: IDocument | undefined;
        application.visualFactory.create = (document) => {
            const visual = createMockVisual({ document });
            loadingContext = new ThreeVisualContext(visual, new Scene());
            loadingContext.materialMap.set("", new MeshLambertMaterial());
            Object.assign(visual, { context: loadingContext });
            return visual;
        };
        PerformanceTrace.enable();
        try {
            loaded = await Document.load(application, stored);
            expect(loaded).not.toBeUndefined();
            if (!loaded || !loadingContext) throw new Error("Document failed to load");
            const node = loaded.modelManager.findNode((candidate) => candidate instanceof ParametricBodyNode);
            expect(node).toBeInstanceOf(ParametricBodyNode);
            const body = node as ParametricBodyNode;
            const visual = loadingContext.getVisual(body) as ThreeGeometry;
            expect(body.isRebuilding).toBe(false);
            expect(visual.faces()?.geometry.getAttribute("position").count).toBe(3);
            expect(outputs).toHaveLength(count);
            expect(outputs.at(-1)?.accesses).toEqual(
                count === 12 ? [{ nodeId: body.id, meshKind: "body", visible: true }] : [undefined],
            );
        } finally {
            loadingContext?.dispose();
            loaded?.dispose();
        }
    });

    test("editing retains last-good without a visual-driven flush, then updates on async completion", async () => {
        const node = body();
        await node.whenRebuilt();
        const visual = geometry(node);
        const oldFace = visual.faces();
        const oldShape = node.resolvedShape;
        const before = outputs.length;
        node.featuresJson = JSON.stringify(steps().map((step) => ({ ...step, revision: 1 })));
        PerformanceTrace.enable();
        visual.buildVisibleMeshes();
        visual.boundingBox();
        expect(node.isRebuilding).toBe(true);
        expect(outputs).toHaveLength(before);
        expect(node.resolvedShape).toBe(oldShape);
        expect(visual.faces()).toBe(oldFace);
        expect(await node.whenRebuilt()).toBe(true);
        expect(visual.faces()).not.toBe(oldFace);
        expect(node.resolvedShape).not.toBe(oldShape);
        expect(outputs.at(-1)?.accesses).toEqual([{ nodeId: node.id, meshKind: "body", visible: true }]);
    });

    test("hidden completion defers meshing until reveal", async () => {
        const node = body(false);
        const visual = geometry(node);
        expect(node.isRebuilding).toBe(false);
        void node.shape;
        expect(node.isRebuilding).toBe(true);
        expect(outputs).toHaveLength(0);
        expect(await node.whenRebuilt()).toBe(true);
        expect(visual.wholeVisual()).toHaveLength(0);
        expect(outputs.at(-1)?.accesses).toHaveLength(0);
        PerformanceTrace.enable();
        node.visible = true;
        expect(visual.faces()?.geometry.getAttribute("position").count).toBe(3);
        expect(outputs.at(-1)?.accesses).toEqual([{ nodeId: node.id, meshKind: "body", visible: true }]);
        expect(visual.visible).toBe(true);
        expect(outputs.at(-1)?.accesses).toHaveLength(1);
    });

    test("explicit selected fitting completes a never-evaluated hidden body and frames its result", () => {
        const node = body(false);
        doc.selection.getSelectedVisualNodes = () => [node];
        const camera = new CameraController({
            document: doc,
            mode: "solidAndWireframe",
        } as unknown as ThreeView);
        camera.fitContent();
        expect(camera.target.x).toBeCloseTo(0.5);
        expect(camera.target.y).toBeCloseTo(0.5);
        expect(node.isRebuilding).toBe(false);
        expect(outputs).toHaveLength(12);
        expect(node.visible).toBe(false);
    });

    test("explicit export of a never-evaluated hidden body includes the completed result", () => {
        PerformanceTrace.enable();
        const node = body(false);
        const result = new ThreeMeshExporter(context).exportToStl([node], true);
        expect(result.isOk).toBe(true);
        expect(result.value).toContain("vertex 1 0 0");
        expect(outputs).toHaveLength(12);
        expect(node.isRebuilding).toBe(false);
        expect(node.visible).toBe(false);
        expect(outputs.at(-1)?.accesses).toEqual([{ nodeId: node.id, meshKind: "body", visible: false }]);
    });

    test("consume/release uses actual transfer notifications without transiently meshing a hidden tool", async () => {
        const folder = new GroupNode({ document: doc, name: "hidden folder" });
        folder.visible = false;
        doc.modelManager.addNode(folder);
        const shape = new ObservedShape();
        const tool = new EditableShapeNode({ document: doc, name: "tool", shape });
        folder.add(tool);
        const node = body();
        await node.whenRebuilt();
        node.featuresJson = JSON.stringify([
            ...steps(),
            { id: "consume", type: "boolean", operation: "fuse", toolIds: [tool.id] },
        ]);
        expect(tool.parent).toBe(node);
        expect(tool.visible).toBe(true);
        expect(tool.parentVisible).toBe(false);
        expect(shape.accesses).toHaveLength(0);
        await node.whenRebuilt();
        expect(shape.accesses).toHaveLength(0);
        node.featuresJson = JSON.stringify(steps());
        expect(tool.parent).toBe(doc.modelManager.rootNode);
        expect(tool.parentVisible).toBe(true);
        expect(geometry(tool).visible).toBe(true);
        expect(geometry(tool).parent).toBe(context.visualShapes);
        expect(shape.accesses).toHaveLength(1);
    });

    test("moving a tool into and out of a body matches its initial flat scene placement", async () => {
        const node = body();
        await node.whenRebuilt();
        const group = new GroupNode({ document: doc, name: "translated group" });
        group.transform = Matrix4.fromTranslation(20, 0, 0);
        doc.modelManager.addNode(group);
        const tool = new EditableShapeNode({ document: doc, name: "tool", shape: new ObservedShape() });
        group.add(tool);
        const visual = geometry(tool);
        expect(visual.matrixWorld.elements[12]).toBe(20);
        NodeChildList.of(group)!.move(tool, node);
        expect(visual.parent).toBe(context.visualShapes);
        expect(visual.visible).toBe(false);
        NodeChildList.of(node)!.move(tool, group);
        expect(visual.parent).toBe(context.getVisual(group));
        expect(visual.visible).toBe(true);
        expect(visual.matrixWorld.elements[12]).toBe(20);
    });

    test("disabled tracing does not start spans, tag shapes, or read the resolved-shape accessor", () => {
        PerformanceTrace.disable();
        const shape = new ObservedShape();
        const node = new EditableShapeNode({ document: doc, name: "source", shape });
        const peek = rs.spyOn(node, "resolvedShape", "get");
        const begin = rs.spyOn(PerformanceTrace, "begin");
        const tag = rs.spyOn(PerformanceTrace, "tagShape");
        doc.modelManager.addNode(node);
        expect(shape.accesses).toEqual([undefined]);
        expect(peek).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(tag).not.toHaveBeenCalled();
    });

    test("construction ownership is tagged before mesh access and updated for explicit hidden demand", () => {
        PerformanceTrace.enable();
        const shape = new ObservedShape();
        const node = new EditableShapeNode({ document: doc, name: "source", shape });
        node.visible = false;
        doc.modelManager.addNode(node);
        expect(shape.accesses).toHaveLength(0);
        new ThreeMeshExporter(context).exportToObj([node]);
        expect(shape.accesses).toEqual([{ nodeId: node.id, meshKind: "construction", visible: false }]);
        const record = PerformanceTrace.snapshot().records.find((x) => x.stage === "visual.create");
        expect(record?.details).toEqual({ nodeId: node.id, nodeType: "EditableShapeNode", visible: false });
    });
});
