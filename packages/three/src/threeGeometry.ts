// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type BoundingBox,
    type EdgeMeshData,
    type FaceMeshData,
    type GeometryNode,
    type IProgressiveMeshShape,
    type IShape,
    type ISubShape,
    type IVisualGeometry,
    isFeatureListNode,
    type Matrix4,
    MeshUtils,
    PerformanceTrace,
    type ShapeMeshRange,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    ShapeTypeUtils,
    type VertexMeshData,
} from "@spicy3d/core";
import {
    type Material,
    Mesh,
    type MeshLambertMaterial,
    type Object3D,
    Points,
    type PointsMaterial,
} from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Constants } from "./constants";
import {
    defaultEdgeMaterial,
    defaultVertexMaterial,
    edgeMaterialOfWidth,
    lockFaceMaterial,
    lockLineMaterial,
    profileFaceMaterialOf,
} from "./materials";
import { ThreeGeometryFactory, TopRenderOrder } from "./threeGeometryFactory";
import { ThreeHelper } from "./threeHelper";
import type { ThreeVisualContext } from "./threeVisualContext";
import { ThreeVisualObject } from "./threeVisualObject";

const OnTopMaterialKey = "onTopMaterial";

export class ThreeGeometry extends ThreeVisualObject implements IVisualGeometry {
    private _faceMaterial: Material | Material[];
    private _edgeMaterial: LineMaterial = defaultEdgeMaterial;
    private _edges?: LineSegments2;
    private _faces?: Mesh;
    private _vertexs?: Points;
    private _renderOnTop = false;
    private _meshesDirty = true;
    private _displayOnly = false;
    private _coarseMesh = false;
    private _buildingMeshes = false;
    private _disposed = false;
    private _temporaryFaces?: MeshLambertMaterial;
    private _temporaryEdges?: LineMaterial;
    private _temporaryVertexs?: PointsMaterial;

    constructor(
        readonly geometryNode: GeometryNode,
        readonly context: ThreeVisualContext,
    ) {
        super(geometryNode);
        this._faceMaterial = context.getMaterial(geometryNode.materialId);
        this.buildVisibleMeshes();
        geometryNode.onPropertyChanged(this.handleGeometryPropertyChanged);
    }

    changeFaceMaterial(material: Material | Material[]) {
        if (this._faces) {
            this._faceMaterial = material;
            this._faces.material = material;
            this.context.updateAnalysisBaseMaterial(this._faces, material);
        }
    }

    get renderOnTop(): boolean {
        return this._renderOnTop;
    }

    /**
     * Toggles depth-test-free rendering above the rest of the scene (used while the
     * node is being edited, e.g. a sketch). Re-applied to meshes rebuilt later.
     */
    setRenderOnTop(value: boolean): void {
        if (this._renderOnTop === value) return;
        this._renderOnTop = value;
        if (this._vertexs) this.applyOnTopMaterial(this._vertexs, defaultVertexMaterial);
        if (this._edges) this.applyOnTopMaterial(this._edges, this._edgeMaterial);
        if (this._faces) this.applyOnTopMaterial(this._faces, this._faceMaterial);
    }

    private applyOnTopMaterial(object: Mesh | LineSegments2 | Points, normalMaterial: Material | Material[]) {
        this.disposeOnTopMaterial(object);
        if (this._renderOnTop) {
            object.renderOrder = TopRenderOrder;
            const onTopMaterial = Array.isArray(normalMaterial)
                ? normalMaterial.map((x) => ThreeGeometryFactory.createOnTopMaterial(x))
                : ThreeGeometryFactory.createOnTopMaterial(normalMaterial);
            object.material = onTopMaterial as any;
            object.userData[OnTopMaterialKey] = onTopMaterial;
        } else {
            object.renderOrder = 0;
            object.material = normalMaterial as any;
        }
    }

    private disposeOnTopMaterial(object: Object3D): void {
        const material = object.userData[OnTopMaterialKey] as Material | Material[] | undefined;
        if (material === undefined) return;
        delete object.userData[OnTopMaterialKey];
        for (const item of Array.isArray(material) ? material : [material]) {
            item.dispose();
        }
    }

    box() {
        this.buildMeshes(false);
        return (
            this._faces?.geometry.boundingBox ??
            this._edges?.geometry.boundingBox ??
            this._vertexs?.geometry.boundingBox
        );
    }

    override boundingBox(): BoundingBox | undefined {
        const box = this.box();
        if (!box) return undefined;

        return {
            min: ThreeHelper.toXYZ(box.min),
            max: ThreeHelper.toXYZ(box.max),
        };
    }

    private readonly handleGeometryPropertyChanged = (property: keyof GeometryNode) => {
        if (property === "materialId") {
            this.changeFaceMaterial(this.context.getMaterial(this.geometryNode.materialId));
        } else if ((property as keyof ShapeNode) === "shape" || property === "mesh") {
            this._meshesDirty = true;
            this.buildVisibleMeshes();
        }
        this.context.refreshAnalysisAppearance();
    };

    /** Passive rendering never demands geometry from hidden/consumed nodes. */
    buildVisibleMeshes(): void {
        if (this.visible && this.geometryNode.visible && this.geometryNode.parentVisible) {
            this.buildMeshes(false);
            if (this._coarseMesh) this.context.queueMeshRefinement(this);
        }
    }

    /** Explicit demand (export, selected fitting, highlighting), independent of visibility. */
    buildMeshes(includeDeferred = true): void {
        if (
            this._disposed ||
            (!this._meshesDirty && !(includeDeferred && this._displayOnly)) ||
            this._buildingMeshes
        )
            return;
        this._buildingMeshes = true;
        try {
            this.generateMeshes(includeDeferred);
        } finally {
            this._buildingMeshes = false;
        }
    }

    private generateMeshes(includeDeferred: boolean): void {
        // Read first so a failed mesh query does not discard the last displayed result.
        if (PerformanceTrace.enabled && this.geometryNode instanceof ShapeNode) {
            const shape = this.geometryNode.resolvedShape;
            if (shape) {
                PerformanceTrace.tagShape(shape, {
                    nodeId: this.geometryNode.id,
                    meshKind: isFeatureListNode(this.geometryNode) ? "body" : "construction",
                    visible: this.visible && this.geometryNode.visible && this.geometryNode.parentVisible,
                });
            }
        }
        const coarse =
            !includeDeferred &&
            this.context.useCoarseDisplayMesh &&
            !this.geometryNode.hasDeferredMesh &&
            this.geometryNode instanceof ShapeNode &&
            this.geometryNode.supportsCoarseDisplayMesh &&
            this.geometryNode.faceMaterialPair.length === 0
                ? (
                      this.geometryNode.shape.unchecked() as
                          | (IShape & Partial<IProgressiveMeshShape>)
                          | undefined
                  )?.createCoarseDisplayMesh?.(0.05)
                : undefined;
        const displayOnly = !includeDeferred && (this.geometryNode.hasDeferredMesh || coarse !== undefined);
        const mesh = coarse ?? (includeDeferred ? this.geometryNode.mesh : this.geometryNode.displayMesh);
        try {
            const vertexs = mesh?.vertexs;
            const faces = mesh?.faces;
            const edges = mesh?.edges;
            this.removeMeshes();
            if (vertexs?.position.length) this.initVertexs(vertexs);
            if (faces?.position.length) this.initFaces(faces);
            if (edges?.position.length) this.initEdges(edges);
            this._meshesDirty = false;
            this._displayOnly = displayOnly;
            this._coarseMesh = coarse !== undefined;
            this.context.removeMeshRefinement(this);
            if (this.locked) {
                this.locked = false;
                this.locked = true;
            }
            if (this._faces && this._temporaryFaces) this._faces.material = this._temporaryFaces;
            if (this._edges && this._temporaryEdges) this._edges.material = this._temporaryEdges;
            if (this._vertexs && this._temporaryVertexs) this._vertexs.material = this._temporaryVertexs;
            this.updateWorldMatrix(true, true);
        } finally {
            coarse?.dispose();
        }
    }

    static buildMeshesIn(object: Object3D, visibleOnly = false): void {
        const build = (child: Object3D) => {
            if (child instanceof ThreeGeometry) {
                if (visibleOnly) child.buildVisibleMeshes();
                else child.buildMeshes();
            }
        };
        if (visibleOnly) object.traverseVisible(build);
        else object.traverse(build);
    }

    override dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this.context.removeMeshRefinement(this);
        super.dispose();
        this.geometryNode.removePropertyChanged(this.handleGeometryPropertyChanged);
        this.removeMeshes();
    }

    private removeMeshes() {
        if (this._vertexs) {
            this.disposeOnTopMaterial(this._vertexs);
            this.remove(this._vertexs);
            this._vertexs.geometry.dispose();
            this._vertexs = undefined;
        }
        if (this._edges) {
            this.disposeOnTopMaterial(this._edges);
            this.remove(this._edges);
            this._edges.geometry.dispose();
            this._edges = undefined;
        }
        if (this._faces) {
            this.disposeOnTopMaterial(this._faces);
            this.remove(this._faces);
            this._faces.geometry.dispose();
            this._faces = undefined;
        }
    }

    private initVertexs(data: VertexMeshData) {
        const buff = ThreeGeometryFactory.createVertexBufferGeometry(data);
        this._vertexs = new Points(buff, defaultVertexMaterial);
        this._vertexs.layers.set(Constants.Layers.Wireframe);
        if (this._renderOnTop) this.applyOnTopMaterial(this._vertexs, defaultVertexMaterial);
        this.add(this._vertexs);
    }

    private initEdges(data: EdgeMeshData) {
        const buff = ThreeGeometryFactory.createEdgeBufferGeometry(data);
        this._edgeMaterial = edgeMaterialOfWidth(data.lineWidth);
        this._edges = new LineSegments2(buff, this._edgeMaterial);
        this._edges.layers.set(Constants.Layers.Wireframe);
        if (this._renderOnTop) this.applyOnTopMaterial(this._edges, this._edgeMaterial);
        this.add(this._edges);
    }

    private initFaces(data: FaceMeshData) {
        const buff = ThreeGeometryFactory.createFaceBufferGeometry(data);
        if (data.groups.length > 1) buff.groups = data.groups;
        this._faceMaterial =
            data.opacity === undefined
                ? this.context.getMaterial(this.geometryNode.materialId)
                : profileFaceMaterialOf(data.opacity);
        this._faces = new Mesh(buff, this._faceMaterial);
        this._faces.layers.set(Constants.Layers.Solid);
        if (this._renderOnTop) this.applyOnTopMaterial(this._faces, this._faceMaterial);
        this.add(this._faces);
    }

    setFacesMateiralTemperary(material: MeshLambertMaterial) {
        this._temporaryFaces = material;
        this.buildMeshes();
        if (this._faces) this._faces.material = material;
    }

    setEdgesMateiralTemperary(material: LineMaterial) {
        this._temporaryEdges = material;
        this.buildMeshes();
        if (this._edges) this._edges.material = material;
    }

    setVertexsMateiralTemperary(material: PointsMaterial) {
        this._temporaryVertexs = material;
        this.buildMeshes();
        if (this._vertexs) this._vertexs.material = material;
    }

    removeTemperaryMaterial(): void {
        this._temporaryFaces = undefined;
        this._temporaryEdges = undefined;
        this._temporaryVertexs = undefined;
        if (this._vertexs) this._vertexs.material = defaultVertexMaterial;
        if (this._edges && this._edges.material !== lockLineMaterial)
            this._edges.material = this._edgeMaterial;
        if (this._faces && this._faces.material !== lockFaceMaterial)
            this._faces.material = this._faceMaterial;
        // restore the on-top state the temporary material replaced
        if (this._renderOnTop) {
            if (this._vertexs) this.applyOnTopMaterial(this._vertexs, defaultVertexMaterial);
            if (this._edges && this._edges.material !== lockLineMaterial)
                this.applyOnTopMaterial(this._edges, this._edgeMaterial);
            if (this._faces && this._faces.material !== lockFaceMaterial)
                this.applyOnTopMaterial(this._faces, this._faceMaterial);
        }
        this.context.refreshAnalysisAppearance();
    }

    cloneSubEdge(index: number) {
        this.buildMeshes();
        this.updateWorldMatrix(true, false);
        const edges = this.geometryNode.mesh.edges;
        if (!edges) return undefined;
        const positions = MeshUtils.subEdge(edges, index);
        if (!positions) return undefined;

        const buff = new LineSegmentsGeometry();
        buff.setPositions(positions);
        buff.applyMatrix4(this.matrixWorld);

        return new LineSegments2(buff, defaultEdgeMaterial);
    }

    cloneSubFace(index: number) {
        this.buildMeshes();
        this.updateWorldMatrix(true, false);
        const faces = this.geometryNode.mesh.faces;
        if (!faces) return undefined;
        const mesh = MeshUtils.subFace(faces, index);
        if (!mesh) return undefined;

        const buff = ThreeGeometryFactory.createFaceBufferGeometry(mesh);
        buff.applyMatrix4(this.matrixWorld);

        return new Mesh(buff, this._faceMaterial);
    }

    faces() {
        return this._faces;
    }

    edges() {
        return this._edges;
    }

    vertexs() {
        return this._vertexs;
    }

    override getSubShapeAndIndex(shapeType: "face" | "edge" | "vertex", subVisualIndex: number) {
        this.buildMeshes();
        // `index` addresses render buffers; subShape.index carries the independent
        // topology position. Preserve both when meshing reorders or omits subshapes.
        let subShape: ISubShape | undefined;
        let transform: Matrix4 | undefined;
        let index: number = -1;
        let groups: ShapeMeshRange[] | undefined;
        if (shapeType === "vertex") {
            groups = this.geometryNode.mesh.vertexs?.range;
            if (groups) {
                index = ThreeHelper.findGroupIndex(groups, subVisualIndex) ?? -1;
                subShape = groups[index]?.shape;
                transform = groups[index]?.transform;
            }
        } else if (shapeType === "edge") {
            groups = this.geometryNode.mesh.edges?.range;
            if (groups) {
                index = ThreeHelper.findGroupIndex(groups, subVisualIndex) ?? -1;
                subShape = groups[index]?.shape;
                transform = groups[index]?.transform;
            }
        } else {
            groups = this.geometryNode.mesh.faces?.range;
            if (groups) {
                index = ThreeHelper.findGroupIndex(groups, subVisualIndex) ?? -1;
                subShape = groups[index]?.shape;
                transform = groups[index]?.transform;
            }
        }

        let shape: IShape | undefined = subShape;
        if (this.geometryNode instanceof ShapeNode) {
            shape = this.geometryNode.shape.value;
        }
        return { transform, shape, subShape, index, groups: groups ?? [] };
    }

    override subShapeVisual(shapeType: ShapeType): (Mesh | LineSegments2 | Points)[] {
        this.buildMeshes();
        const shapes: (Mesh | LineSegments2 | Points | undefined)[] = [];

        const isWhole =
            shapeType === ShapeTypes.shape ||
            ShapeTypeUtils.hasCompound(shapeType) ||
            ShapeTypeUtils.hasCompoundSolid(shapeType) ||
            ShapeTypeUtils.hasSolid(shapeType);

        if (isWhole || ShapeTypeUtils.hasVertex(shapeType)) {
            shapes.push(this.vertexs());
        }

        if (isWhole || ShapeTypeUtils.hasEdge(shapeType) || ShapeTypeUtils.hasWire(shapeType)) {
            shapes.push(this.edges());
        }

        if (isWhole || ShapeTypeUtils.hasFace(shapeType) || ShapeTypeUtils.hasShell(shapeType)) {
            shapes.push(this.faces());
        }

        return shapes.filter((x) => x !== undefined);
    }

    override wholeVisual(): (Mesh | LineSegments2 | Points)[] {
        return [this.edges(), this.faces(), this.vertexs()].filter((x) => x !== undefined);
    }
}
