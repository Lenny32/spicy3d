// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    EditableShapeNode,
    GeometryNode,
    GroupNode,
    type INode,
    type INodeLinkedList,
    type IShape,
    type IShapeMeshData,
    Matrix4,
    NodeChildList,
    Result,
    ShapeTypes,
    UserActivity,
    VisualStates,
} from "@spicy3d/core";
import { createMockSelection, createMockVisual, TestDocument } from "@spicy3d/core/test-utils";
import { MeshLambertMaterial, Raycaster, Scene, Vector3 } from "three";
import { CameraController } from "../src/cameraController";
import { Constants } from "../src/constants";
import { selectedEdgeMaterial } from "../src/materials";
import { ThreeMeshExporter } from "../src/meshExporter";
import { ThreeGeometry } from "../src/threeGeometry";
import { ThreeHighlighter } from "../src/threeHighlighter";
import { ThreeView } from "../src/threeView";
import { ThreeVisualContext } from "../src/threeVisualContext";
import { createTestGeometryNode } from "./mocks";

class CountingGeometry extends GeometryNode {
    builds = 0;
    data = createTestGeometryNode().mesh;

    display(): "common.cancel" {
        return "common.cancel";
    }

    protected override createMesh(): IShapeMeshData {
        this.builds++;
        return this.data;
    }

    invalidate(property: "shape" | "mesh") {
        this._mesh = undefined;
        this.emitPropertyChanged(property as "mesh", this.data);
    }
}

class DeferredProfileGeometry extends CountingGeometry {
    override get hasDeferredMesh(): boolean {
        return this._mesh === undefined;
    }

    override get displayMesh(): IShapeMeshData {
        return this._mesh ?? { ...this.data, faces: undefined };
    }
}

/** Like a sketch in an editing session: custom mesh styling, no deferred profile faces. */
class StyledShapeNode extends EditableShapeNode {
    protected override createMesh(): IShapeMeshData {
        const mesh = super.createMesh();
        if (mesh.edges) mesh.edges.lineWidth = 2;
        return mesh;
    }
}

/** Same child render policy as a parametric body's consumed tools, without a kernel. */
class ConsumingBody extends CountingGeometry implements INodeLinkedList {
    private readonly childrenList: NodeChildList = new NodeChildList(this, () => false);
    get firstChild() {
        return this.childrenList.firstChild;
    }
    get lastChild() {
        return this.childrenList.lastChild;
    }
    size() {
        return this.childrenList.count;
    }
    add(...nodes: INode[]) {
        this.childrenList.add(...nodes);
    }
    remove(...nodes: INode[]) {
        this.childrenList.remove(...nodes);
    }
    transfer(...nodes: INode[]) {
        this.childrenList.transfer(...nodes);
    }
    insertAfter(target: INode | undefined, node: INode) {
        this.childrenList.insertAfter(target, node);
    }
    insertBefore(target: INode | undefined, node: INode) {
        this.childrenList.insertBefore(target, node);
    }
    move(child: INode, parent: this, previous?: INode) {
        this.childrenList.move(child, parent, previous);
    }
}

describe("deferred geometry", () => {
    let doc: TestDocument;
    let context: ThreeVisualContext;
    let highlighter: ThreeHighlighter;

    beforeEach(() => {
        doc = new TestDocument({ selection: createMockSelection() });
        doc.visual = createMockVisual({ document: doc });
        context = new ThreeVisualContext(doc.visual, new Scene());
        Object.assign(doc.visual, { context });
        context.materialMap.set("", new MeshLambertMaterial());
        highlighter = new ThreeHighlighter(context);
    });

    afterEach(() => {
        highlighter.clear();
        context.dispose();
        doc.dispose();
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    });

    function node(name = "geometry") {
        return new CountingGeometry({ document: doc, name });
    }

    function visual(node: CountingGeometry) {
        const result = context.getVisual(node);
        expect(result).toBeInstanceOf(ThreeGeometry);
        return result as ThreeGeometry;
    }

    function progressiveNode(nodeClass = EditableShapeNode) {
        const data = createTestGeometryNode().mesh;
        const fine = { ...data, faces: { ...data.faces!, index: new Uint32Array([0, 1, 2, 0, 1, 2]) } };
        const fullMesh = rs.fn(() => fine);
        const disposeCoarse = rs.fn();
        const coarse = rs.fn((_deflection: number) => ({ ...data, dispose: disposeCoarse }));
        const shape = {
            get mesh() {
                return fullMesh();
            },
            createCoarseDisplayMesh: coarse,
            isEqual: () => false,
            dispose() {},
        } as unknown as IShape;
        const node = new nodeClass({ document: doc, name: "progressive", shape });
        return { node, shape, fullMesh, coarse, disposeCoarse };
    }

    function idleQueue() {
        const callbacks = new Map<number, () => void>();
        let nextId = 0;
        rs.stubGlobal("requestIdleCallback", (callback: () => void) => {
            callbacks.set(++nextId, callback);
            return nextId;
        });
        rs.stubGlobal("cancelIdleCallback", (id: number) => callbacks.delete(id));
        return {
            callbacks,
            runNext() {
                const next = callbacks.entries().next().value;
                expect(next).not.toBeUndefined();
                const [id, callback] = next!;
                callbacks.delete(id);
                callback();
            },
        };
    }

    test.each([
        99, 100,
    ])("%i visible shapes select first-pass quality and refine one shape per idle turn", (count) => {
        const idle = idleQueue();
        const shapes = Array.from({ length: count }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        const first = shapes[0];
        const geo = context.getVisual(first.node) as ThreeGeometry;
        if (count === 99) {
            expect(first.coarse).not.toHaveBeenCalled();
            expect(first.fullMesh).toHaveBeenCalledTimes(1);
            expect(idle.callbacks.size).toBe(0);
        } else {
            expect(first.coarse).toHaveBeenCalledExactlyOnceWith(0.05);
            expect(first.disposeCoarse).toHaveBeenCalledTimes(1);
            expect(geo.faces()?.geometry.index?.count).toBe(3);
            expect(shapes.every((item) => item.fullMesh.mock.calls.length === 0)).toBe(true);
            expect(idle.callbacks.size).toBe(1);
            idle.runNext();
            expect(first.fullMesh).toHaveBeenCalledTimes(1);
            expect(geo.faces()?.geometry.index?.count).toBe(6);
            expect(shapes.slice(1).every((item) => item.fullMesh.mock.calls.length === 0)).toBe(true);
            expect(idle.callbacks.size).toBe(1);
        }
    });

    test("picking refines immediately and removes that geometry from the idle queue", () => {
        const idle = idleQueue();
        const shapes = Array.from({ length: 100 }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        const first = shapes[0];
        const geo = context.getVisual(first.node) as ThreeGeometry;
        const faces = geo.subShapeVisual(ShapeTypes.face);
        expect(faces).toHaveLength(1);
        expect(geo.faces()?.geometry.index?.count).toBe(6);
        expect(first.fullMesh).toHaveBeenCalledTimes(1);
        idle.runNext();
        expect(first.fullMesh).toHaveBeenCalledTimes(1);
        expect(shapes[1].fullMesh).toHaveBeenCalledTimes(1);
    });

    test("custom mesh styling stays full quality inside a large initial batch", () => {
        idleQueue();
        const shapes = Array.from({ length: 100 }, () => progressiveNode());
        const styled = progressiveNode(StyledShapeNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node), styled.node);
        const geo = context.getVisual(styled.node) as ThreeGeometry;
        expect(styled.node.hasDeferredMesh).toBe(false);
        expect(styled.node.supportsCoarseDisplayMesh).toBe(false);
        expect(styled.coarse).not.toHaveBeenCalled();
        expect(styled.fullMesh).toHaveBeenCalledTimes(1);
        expect(geo.edges()?.material.linewidth).toBe(2);
        expect(geo.faces()?.geometry.index?.count).toBe(6);

        const replacement = progressiveNode();
        styled.node.shape = Result.ok(replacement.shape);
        expect(replacement.coarse).not.toHaveBeenCalled();
        expect(replacement.fullMesh).toHaveBeenCalledTimes(1);
        expect(geo.edges()?.material.linewidth).toBe(2);
    });

    test("large initial batches do not enable coarse meshing for subsequent edits or additions", () => {
        idleQueue();
        const shapes = Array.from({ length: 100 }, () => progressiveNode());
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        expect(shapes[0].coarse).toHaveBeenCalledTimes(1);
        expect(context.useCoarseDisplayMesh).toBe(false);
        const replacement = progressiveNode();
        shapes[0].node.shape = Result.ok(replacement.shape);
        expect(replacement.coarse).not.toHaveBeenCalled();
        expect(replacement.fullMesh).toHaveBeenCalledTimes(1);
        expect((context.getVisual(shapes[0].node) as ThreeGeometry).faces()?.geometry.index?.count).toBe(6);

        const addition = progressiveNode();
        doc.modelManager.rootNode.add(addition.node);
        expect(addition.coarse).not.toHaveBeenCalled();
        expect(addition.fullMesh).toHaveBeenCalledTimes(1);
    });

    test("adding shapes individually never enables a coarse initial batch", () => {
        const idle = idleQueue();
        const shapes = Array.from({ length: 101 }, () => progressiveNode());
        for (const item of shapes) doc.modelManager.rootNode.add(item.node);
        expect(shapes.map((item) => item.coarse.mock.calls.length)).toEqual(Array(101).fill(0));
        expect(shapes.map((item) => item.fullMesh.mock.calls.length)).toEqual(Array(101).fill(1));
        expect(idle.callbacks.size).toBe(0);
        expect(context.useCoarseDisplayMesh).toBe(false);
    });

    test("node hover raycasts the displayed meshes without refining bodies or generating profiles", () => {
        idleQueue();
        const shapes = Array.from({ length: 100 }, () => progressiveNode());
        const profile = new DeferredProfileGeometry({ document: doc, name: "profile" });
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node), profile);
        const ray = new Raycaster(new Vector3(0.2, 0.2, 1), new Vector3(0, 0, -1));
        ray.layers.set(Constants.Layers.Solid);
        const view = Object.create(ThreeView.prototype) as ThreeView;
        Object.assign(view, {
            document: doc,
            content: context,
            initRaycaster: () => ray,
        });
        const hits = view.detectVisual(0, 0);
        expect(hits).toHaveLength(100);
        expect(hits).toContain(context.getVisual(shapes[0].node));
        expect(shapes.map((item) => item.fullMesh.mock.calls.length)).toEqual(Array(100).fill(0));
        expect(profile.builds).toBe(0);
        expect(visual(profile).faces()).toBeUndefined();
    });

    test("idle refinement waits while busy and cancels pending work on disposal", () => {
        const idle = idleQueue();
        const shapes = Array.from({ length: 100 }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        const busy = rs.spyOn(UserActivity.current, "isBusy").mockReturnValue(true);
        idle.runNext();
        expect(shapes[0].fullMesh).not.toHaveBeenCalled();
        busy.mockReturnValue(false);
        context.dispose();
        expect(idle.callbacks.size).toBe(0);
        expect(shapes.every((item) => item.fullMesh.mock.calls.length === 0)).toBe(true);
    });

    test("hidden coarse geometry refines only after it is revealed again", () => {
        const idle = idleQueue();
        const shapes = Array.from({ length: 100 }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        for (const item of shapes.slice(1)) {
            context.removeMeshRefinement(context.getVisual(item.node) as ThreeGeometry);
        }
        const first = shapes[0];
        first.node.visible = false;
        idle.runNext();
        expect(first.fullMesh).not.toHaveBeenCalled();
        expect(idle.callbacks.size).toBe(0);
        first.node.visible = true;
        expect(idle.callbacks.size).toBe(1);
        idle.runNext();
        expect(first.fullMesh).toHaveBeenCalledTimes(1);
    });

    test("idle refinement resumes after the running command finishes", async () => {
        const idle = idleQueue();
        const shapes = Array.from({ length: 100 }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        const busy = rs.spyOn(UserActivity.current, "isBusy").mockReturnValue(true);
        idle.runNext();
        expect(shapes[0].fullMesh).not.toHaveBeenCalled();
        busy.mockReturnValue(false);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(idle.callbacks.size).toBe(1);
        idle.runNext();
        expect(shapes[0].fullMesh).toHaveBeenCalledTimes(1);
        expect(shapes[1].fullMesh).not.toHaveBeenCalled();
    });

    test("export refines coarse geometry immediately, including a hidden selected node", () => {
        idleQueue();
        const shapes = Array.from({ length: 100 }, progressiveNode);
        doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
        const first = shapes[0];
        first.node.visible = false;
        const output = new ThreeMeshExporter(context).exportToStl([first.node], true);
        expect(output.isOk).toBe(true);
        expect((output.value as string).match(/facet normal/g)).toHaveLength(2);
        expect(first.fullMesh).toHaveBeenCalledTimes(1);
    });

    test("the timer fallback refines one shape per turn and stops when disposed", () => {
        rs.stubGlobal("requestIdleCallback", undefined);
        rs.useFakeTimers();
        try {
            const shapes = Array.from({ length: 100 }, progressiveNode);
            doc.modelManager.rootNode.add(...shapes.map((item) => item.node));
            expect(shapes[0].fullMesh).not.toHaveBeenCalled();
            rs.advanceTimersByTime(50);
            expect(shapes[0].fullMesh).toHaveBeenCalledTimes(1);
            expect(shapes[1].fullMesh).not.toHaveBeenCalled();
            context.dispose();
            rs.advanceTimersByTime(500);
            expect(shapes[1].fullMesh).not.toHaveBeenCalled();
        } finally {
            rs.useRealTimers();
        }
    });

    test("profile faces stay deferred during load and fitting, then become raycastable on demand", () => {
        const profile = new DeferredProfileGeometry({ document: doc, name: "profile" });
        doc.modelManager.rootNode.add(profile);
        const geo = visual(profile);
        expect(geo.edges()).toBeDefined();
        expect(geo.faces()).toBeUndefined();
        expect(geo.boundingBox()?.max.x).toBe(1);
        expect(profile.boundingBox()?.max.x).toBe(1);
        context.refreshAnalysisAppearance();
        expect(profile.builds).toBe(0);

        const faces = geo.subShapeVisual(ShapeTypes.face);
        const ray = new Raycaster(new Vector3(0.2, 0.2, 1), new Vector3(0, 0, -1));
        ray.layers.enableAll();
        expect(ray.intersectObjects(faces, false)).toHaveLength(1);
        expect(profile.builds).toBe(1);
        geo.buildVisibleMeshes();
        geo.subShapeVisual(ShapeTypes.face);
        expect(profile.builds).toBe(1);

        profile.invalidate("mesh");
        expect(geo.faces()).toBeUndefined();
        expect(profile.builds).toBe(1);
        geo.buildMeshes();
        expect(ray.intersectObjects(geo.subShapeVisual(ShapeTypes.face), false)).toHaveLength(1);
        expect(profile.builds).toBe(2);
    });

    test("load builds only visible geometry, including a visible body but not its consumed tools", () => {
        const hidden = node("hidden");
        hidden.visible = false;
        const group = new GroupNode({ document: doc, name: "hidden ancestor" });
        group.visible = false;
        const descendant = node("descendant");
        const body = new ConsumingBody({ document: doc, name: "body" });
        const tool = node("tool");
        doc.modelManager.rootNode.add(hidden, group, body);
        group.add(descendant);
        body.add(tool);

        expect([hidden.builds, descendant.builds, tool.builds, body.builds]).toEqual([0, 0, 0, 1]);
        expect(visual(body).faces()?.geometry.getAttribute("position").count).toBe(3);
        expect(visual(hidden).children).toHaveLength(0);
        expect(visual(descendant).parent).toBe(context.getVisual(group));
        // Consumed children keep the existing flat scene placement and tree visibility.
        expect(visual(tool).parent).toBe(context.visualShapes);
        expect(tool.visible).toBe(true);
        expect(tool.parentVisible).toBe(false);
        context.refreshAnalysisAppearance();
        expect([hidden.builds, descendant.builds, tool.builds]).toEqual([0, 0, 0]);
    });

    test("visibility and ancestor visibility build once and retain buffers across hide/show", () => {
        const group = new GroupNode({ document: doc, name: "group" });
        const child = node();
        child.visible = false;
        group.visible = false;
        group.add(child);
        doc.modelManager.rootNode.add(group);
        child.visible = true;
        expect(child.builds).toBe(0);
        group.visible = true;
        const face = visual(child).faces();
        expect(face?.geometry.getAttribute("position").count).toBe(3);
        expect(child.builds).toBe(1);
        group.visible = false;
        group.visible = true;
        expect(visual(child).faces()).toBe(face);
        expect(child.builds).toBe(1);
    });

    test("moving out of a hidden ancestor builds the existing visual in its new placement", () => {
        const group = new GroupNode({ document: doc, name: "hidden" });
        group.visible = false;
        const child = node();
        group.add(child);
        doc.modelManager.rootNode.add(group);
        const before = visual(child);
        NodeChildList.of(group)!.move(child, doc.modelManager.rootNode);
        expect(context.getVisual(child)).toBe(before);
        expect(before.parent).toBe(context.visualShapes);
        expect(before.visible).toBe(true);
        expect(child.builds).toBe(1);
    });

    test("releasing a consumed tool builds it without changing its saved visibility", () => {
        const body = new ConsumingBody({ document: doc, name: "body" });
        doc.modelManager.rootNode.add(body);
        const tool = node("tool");
        body.add(tool);
        const geometry = visual(tool);
        expect(tool.builds).toBe(0);
        NodeChildList.of(body)!.move(tool, doc.modelManager.rootNode);
        expect(tool.visible).toBe(true);
        expect(tool.parentVisible).toBe(true);
        expect(geometry.visible).toBe(true);
        expect(geometry.faces()?.geometry.getAttribute("position").count).toBe(3);
        expect(tool.builds).toBe(1);
    });

    test("explicit selection of a deferred node builds its highlight and preserves on-top and lock state", () => {
        const child = node();
        child.visible = false;
        doc.modelManager.rootNode.add(child);
        const geometry = visual(child);
        geometry.setRenderOnTop(true);
        geometry.locked = true;
        highlighter.addState(geometry, VisualStates.edgeSelected, ShapeTypes.shape);
        expect(child.builds).toBe(1);
        expect(geometry.edges()?.material).toBe(selectedEdgeMaterial);
        expect(geometry.edges()?.renderOrder).toBe(999);
        expect(geometry.locked).toBe(true);
        expect(geometry.visible).toBe(false);
    });

    test.each([
        "shape",
        "mesh",
    ] as const)("%s invalidation defers hidden updates and restores selection", (property) => {
        const child = node();
        doc.modelManager.rootNode.add(child);
        const geometry = visual(child);
        highlighter.addState(geometry, VisualStates.edgeSelected, ShapeTypes.shape);
        const oldFace = geometry.faces()!;
        const dispose = rs.spyOn(oldFace.geometry, "dispose");
        child.visible = false;
        child.data = createTestGeometryNode({ hasFaces: false }).mesh;
        child.invalidate(property);
        child.invalidate(property);
        expect(child.builds).toBe(1);
        child.visible = true;
        expect(child.builds).toBe(2);
        expect(geometry.faces()).toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(geometry.edges()?.material).toBe(selectedEdgeMaterial);
        child.data = createTestGeometryNode().mesh;
        child.invalidate(property);
        expect(geometry.faces()?.geometry.getAttribute("position").count).toBe(3);
        expect(child.builds).toBe(3);
    });

    test("a revealed mesh supports ray picking and subshape highlight in world coordinates", () => {
        const child = node();
        child.visible = false;
        child.transform = Matrix4.fromTranslation(10, 0, 0);
        doc.modelManager.rootNode.add(child);
        child.visible = true;
        const geometry = visual(child);
        const ray = new Raycaster(new Vector3(10.2, 0.2, 1), new Vector3(0, 0, -1));
        ray.layers.enableAll();
        const hits = ray.intersectObjects(geometry.subShapeVisual(ShapeTypes.face), false);
        expect(hits).toHaveLength(1);
        expect(geometry.getSubShapeAndIndex("face", hits[0].faceIndex! * 3).subShape?.id).toBe("f1");
        highlighter.addState(geometry, VisualStates.faceHighlight, ShapeTypes.face, 0);
        expect(highlighter.container.children).toHaveLength(1);
        const clone = geometry.cloneSubFace(0)!;
        expect(clone.geometry.getAttribute("position").getX(0)).toBe(10);
        clone.geometry.dispose();
    });

    test("explicit export builds hidden meshes with world placement without disposing live buffers", () => {
        const child = node();
        child.visible = false;
        child.transform = Matrix4.fromTranslation(10, 0, 0);
        doc.modelManager.rootNode.add(child);
        const exporter = new ThreeMeshExporter(context);
        const result = exporter.exportToObj([child]);
        expect(result.isOk).toBe(true);
        expect(result.value).toContain("v 10 0 0");
        expect(result.value).toContain("f 1/1/1 2/2/2 3/3/3");
        expect(child.builds).toBe(1);
        expect(child.visible).toBe(false);
        expect(visual(child).visible).toBe(false);
        const dispose = rs.spyOn(visual(child).faces()!.geometry, "dispose");
        exporter.exportToStl([child], true);
        expect(dispose).not.toHaveBeenCalled();
        expect(child.builds).toBe(1);
    });

    test("fitContent skips hidden geometry unless explicitly selected", () => {
        const shown = node("shown");
        const hidden = node("hidden");
        hidden.visible = false;
        hidden.transform = Matrix4.fromTranslation(100, 0, 0);
        doc.modelManager.rootNode.add(shown, hidden);
        const controller = new CameraController({
            document: doc,
            mode: "solidAndWireframe",
        } as unknown as ThreeView);
        controller.fitContent();
        expect(controller.target.x).toBeCloseTo(0.5);
        expect(hidden.builds).toBe(0);
        doc.selection.getSelectedVisualNodes = () => [hidden];
        controller.fitContent();
        expect(controller.target.x).toBeCloseTo(100.5);
        expect(hidden.builds).toBe(1);
        doc.selection = createMockSelection();
        controller.fitContent();
        expect(controller.target.x).toBeCloseTo(0.5);
        expect(hidden.visible).toBe(false);
    });

    test("disposing deferred and built visuals removes listeners and prevents later mesh demand", () => {
        const hidden = node("hidden");
        hidden.visible = false;
        const shown = node("shown");
        doc.modelManager.rootNode.add(hidden, shown);
        const deferred = visual(hidden);
        const built = visual(shown);
        const dispose = rs.spyOn(built.faces()!.geometry, "dispose");
        context.removeNode([hidden, shown]);
        hidden.invalidate("mesh");
        shown.invalidate("shape");
        deferred.buildMeshes();
        built.buildMeshes();
        expect([hidden.builds, shown.builds]).toEqual([0, 1]);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(deferred.children).toHaveLength(0);
        expect(built.children).toHaveLength(0);
        expect(context.getVisual(hidden)).toBeUndefined();
    });
});
