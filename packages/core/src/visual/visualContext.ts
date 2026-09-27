// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDisposable } from "../foundation";
import type { BoundingBox, Matrix4, Plane } from "../math";
import type { INode } from "../model";
import type { IShapeFilter } from "../selectionFilter";
import type { EdgeMeshData, MeshLike, ShapeMeshData } from "../shape";
import type { IVisualObject } from "./visualObject";

export type MeshOption = {
    meshOpacity?: number;
    lineOpacity?: number;
    vertexOpacity?: number;
    onTop?: boolean;
};

export type AnalysisAppearance = {
    nodeId: string;
    mode: "chrome" | "zebra" | "color";
    color?: number;
    rotation?: number;
    mirrorFinish?: number;
    density?: number;
    contrast?: number;
    direction?: number;
    environment?: "studio" | "softbox";
};

export interface IVisualContext extends IDisposable {
    get shapeCount(): number;
    addVisualObject(object: IVisualObject): void;
    boundingBoxIntersectFilter(boundingBox: BoundingBox, filter?: IShapeFilter): IVisualObject[];
    removeVisualObject(object: IVisualObject): void;
    addNode(nodes: INode[]): void;
    removeNode(nodes: INode[]): void;
    getVisual(node: INode): IVisualObject | undefined;
    getNode(visual: IVisualObject): INode | undefined;
    redrawNode(nodes: INode[]): void;
    setVisible(node: INode, visible: boolean): void;
    /** Renders the nodes above everything else (no depth test) — e.g. the sketch being edited. */
    setNodeOnTop(nodes: INode[], onTop: boolean): void;
    visuals(): IVisualObject[];
    displayMesh(datas: ShapeMeshData[], meshOption?: MeshOption): number;
    setMeshColor(id: number, color: number): void;
    removeMesh(id: number): void;
    displayInstancedMesh(data: MeshLike, matrixs: Matrix4[], meshOption?: MeshOption): number;
    displayLineSegments(data: EdgeMeshData): number;
    setPosition(id: number, position: Float32Array): void;
    setInstanceMatrix(id: number, matrixs: Matrix4[]): void;
    /** Owns a document-wide viewport clipping plane until the returned lease is released. */
    acquireAnalysisClip(ownerId: string, plane: Plane): () => void;
    acquireAnalysisAppearance(ownerId: string, appearances: AnalysisAppearance[]): () => void;
    /** Whether a world-space point lies in the currently retained section half-space. */
    isAnalysisPointVisible?(point: { x: number; y: number; z: number }): boolean;
}
