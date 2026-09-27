// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { type IDisposable, PubSub, Result, Transaction } from "../foundation";
import { Matrix4, XYZ } from "../math";
import { GroupNode, type INode, MeshNode, NodeUtils, ShapeNode, VisualNode } from "../model";
import { type IShape, Mesh, MeshDataUtils, ShapeTypes } from "../shape";
import { AnalysisGroup, AnalysisNode } from "./node";
import type {
    AnalysisContext,
    AnalysisDefinition,
    AnalysisEvaluator,
    AnalysisResult,
    AnalysisSourceRef,
    ResolvedAnalysisSource,
} from "./types";

interface RunState {
    revision: number;
    controller?: AbortController;
    result?: AnalysisResult;
    meshId?: number;
    markerMeshId?: number;
    displayOrder?: number;
    selectedRowMeshId?: number;
    restoreDisplay?: () => void;
}

type TrackingNode = {
    faceIdAt?(index: number): string | undefined;
    edgeIdAt?(index: number): string | undefined;
    faceIndexesOfId?(id: string): number[];
    edgeIndexesOfId?(id: string): number[];
};

/** Owns analysis definitions and all ephemeral evaluation and viewport resources. */
export class AnalysisManager implements IDisposable {
    private readonly evaluators = new Map<string, AnalysisEvaluator>();
    private readonly runs = new Map<AnalysisNode, RunState>();
    private readonly watched = new Set<INode>();
    private displaySequence = 0;
    private disposed = false;

    constructor(readonly document: IDocument) {
        document.modelManager.addNodeObserver(this.onTreeChanged);
        PubSub.default.sub("documentOpened", this.onLibraryDocumentsChanged);
        PubSub.default.sub("documentClosed", this.onLibraryDocumentsChanged);
        this.attachModel();
    }

    get group(): AnalysisGroup | undefined {
        return this.document.modelManager.findNode((node) => node instanceof AnalysisGroup) as
            | AnalysisGroup
            | undefined;
    }

    get items(): AnalysisNode[] {
        const group = this.group;
        return group
            ? (NodeUtils.findNodes(group, (node) => node instanceof AnalysisNode) as AnalysisNode[])
            : [];
    }

    registerEvaluator(kind: string, evaluator: AnalysisEvaluator): void {
        this.evaluators.set(kind, evaluator);
        for (const node of this.items) {
            if (node.kind === kind && node.visible) void this.evaluate(node);
        }
    }

    add(definition: Omit<AnalysisDefinition, "id"> & { id?: string }): AnalysisNode {
        const node = new AnalysisNode({ ...definition, document: this.document });
        Transaction.execute(this.document, `add ${node.name} analysis`, () => {
            let group = this.group;
            if (!group) {
                group = new AnalysisGroup({ document: this.document, name: "Analyses" });
                this.document.modelManager.rootNode.add(group);
            }
            group.add(node);
        });
        return node;
    }

    captureSource(node: ShapeNode, picked?: IShape): Result<AnalysisSourceRef> {
        if (!node.shape.isOk) return Result.err(`Source ${node.name}: ${node.shape.error}`);
        if (!picked || picked.isSame(node.shape.value)) return Result.ok({ nodeId: node.id });
        const kind =
            picked.shapeType === ShapeTypes.face
                ? "face"
                : picked.shapeType === ShapeTypes.edge
                  ? "edge"
                  : picked.shapeType === ShapeTypes.vertex
                    ? "vertex"
                    : undefined;
        if (!kind) return Result.err(`Source ${node.name}: unsupported subshape`);
        const candidates = node.shape.value.findSubShapes(picked.shapeType);
        const matches = candidates.flatMap((candidate, index) => (candidate.isSame(picked) ? [index] : []));
        if (matches.length !== 1) {
            candidates.forEach((candidate) => candidate.dispose());
            return Result.err(`Source ${node.name}: ${kind} is ${matches.length ? "ambiguous" : "missing"}`);
        }
        const index = matches[0];
        const tracking = node as TrackingNode;
        const stableId =
            kind === "face"
                ? tracking.faceIdAt?.(index)
                : kind === "edge"
                  ? tracking.edgeIdAt?.(index)
                  : undefined;
        const signature = stableId ? undefined : this.subShapeSignature(candidates[index], node.shape.value);
        candidates.forEach((candidate) => candidate.dispose());
        return Result.ok({ nodeId: node.id, subShape: { kind, index, stableId, signature } });
    }

    remove(node: AnalysisNode): void {
        if (!node.parent) return;
        Transaction.execute(this.document, `delete ${node.name} analysis`, () => node.parent?.remove(node));
    }

    update(
        node: AnalysisNode,
        changes: Partial<Pick<AnalysisDefinition, "name" | "sources" | "settings" | "visible">>,
    ): void {
        Transaction.execute(this.document, `edit ${node.name} analysis`, () => {
            if (changes.name !== undefined) node.name = changes.name;
            if (changes.sources !== undefined) node.sources = changes.sources;
            if (changes.settings !== undefined) node.settings = changes.settings;
            if (changes.visible !== undefined) node.visible = changes.visible;
        });
    }

    /** Call after document deserialization replaces the model root. */
    attachModel(): void {
        for (const old of this.watched) old.removePropertyChanged(this.onSourceChanged);
        this.watched.clear();
        for (const node of this.document.modelManager.findNodes()) {
            node.onPropertyChanged(this.onSourceChanged);
            this.watched.add(node);
            if (node instanceof AnalysisNode && !this.runs.has(node)) this.runs.set(node, { revision: 0 });
        }
        for (const [node] of this.runs) {
            if (!this.watched.has(node)) {
                this.cancel(node);
                this.runs.delete(node);
            }
        }
        for (const node of this.items) if (node.visible) void this.evaluate(node);
    }

    resolveSource(reference: AnalysisSourceRef): Result<ResolvedAnalysisSource> {
        const node = this.document.modelManager.findNode((candidate) => candidate.id === reference.nodeId);
        if (!(node instanceof ShapeNode) && !(node instanceof MeshNode)) {
            return Result.err(`Source ${reference.nodeId} is missing or has no inspectable geometry`);
        }
        if (node instanceof ShapeNode && !node.shape.isOk)
            return Result.err(`Source ${node.name}: ${node.shape.error}`);
        const parentShape = node instanceof ShapeNode ? node.shape.value : undefined;
        const shape = parentShape?.clone();
        const mesh =
            node instanceof MeshNode
                ? new Mesh({
                      meshType: node.mesh.meshType,
                      position: node.mesh.position && new Float32Array(node.mesh.position),
                      normal: node.mesh.normal && new Float32Array(node.mesh.normal),
                      index: node.mesh.index && new Uint32Array(node.mesh.index),
                      uv: node.mesh.uv && new Float32Array(node.mesh.uv),
                      color: node.mesh.color,
                      groups: node.mesh.groups.map((group) => ({ ...group })),
                  })
                : undefined;
        if (mesh && node instanceof MeshNode) {
            mesh.semanticFaceGroupsJson = node.mesh.semanticFaceGroupsJson;
            mesh.semanticTopologyHash = node.mesh.semanticTopologyHash;
        }
        let subShape: IShape | undefined;
        const requested = reference.subShape;
        if (requested) {
            if (!shape || !parentShape)
                return Result.err(`Source ${node.name}: mesh subshapes are unavailable`);
            const shapeType =
                requested.kind === "face"
                    ? ShapeTypes.face
                    : requested.kind === "edge"
                      ? ShapeTypes.edge
                      : ShapeTypes.vertex;
            const candidates = shape.findSubShapes(shapeType);
            let index = requested.index;
            if (requested.stableId) {
                const tracking = node as TrackingNode;
                const matches =
                    requested.kind === "face"
                        ? tracking.faceIndexesOfId?.(requested.stableId)
                        : requested.kind === "edge"
                          ? tracking.edgeIndexesOfId?.(requested.stableId)
                          : undefined;
                if (!matches || matches.length !== 1) {
                    candidates.forEach((candidate) => candidate.dispose());
                    shape.dispose();
                    return Result.err(
                        `Source ${node.name}: tracked ${requested.kind} is ${matches?.length ? "ambiguous" : "missing"}`,
                    );
                }
                index = matches[0];
            }
            if (index === undefined || index < 0 || index >= candidates.length) {
                candidates.forEach((candidate) => candidate.dispose());
                shape.dispose();
                return Result.err(`Source ${node.name}: ${requested.kind} is missing`);
            }
            subShape = candidates[index];
            candidates.forEach((candidate, candidateIndex) => {
                if (candidateIndex !== index) candidate.dispose();
            });
            if (
                !requested.stableId &&
                (!requested.signature ||
                    requested.signature !== this.subShapeSignature(subShape, parentShape))
            ) {
                subShape.dispose();
                shape.dispose();
                return Result.err(
                    `Source ${node.name}: ${requested.kind} changed and cannot be safely reattached`,
                );
            }
        }
        // A node may have no displayed visual (headless tests, hidden groups). Compose
        // the serialized hierarchy directly so nested transforms still resolve.
        const transforms: Matrix4[] = [];
        let current: INode | undefined = node;
        while (current) {
            if (current instanceof VisualNode || current instanceof GroupNode)
                transforms.unshift(current.transform);
            current = current.parent;
        }
        const worldTransform = transforms.reduce((acc, matrix) => matrix.multiply(acc), Matrix4.identity());
        return Result.ok({
            reference,
            node,
            shape,
            mesh,
            subShape,
            worldTransform,
            dispose: () => {
                subShape?.dispose();
                shape?.dispose();
            },
        });
    }

    subShapeSignature(shape: IShape, parentShape: IShape): string {
        // Saved kernel identities make index references fail closed after any
        // untracked topology rebuild, even when two edges share the same bounds.
        return JSON.stringify([parentShape.id, shape.shapeType]);
    }

    async evaluate(node: AnalysisNode): Promise<void> {
        if (this.disposed) return;
        const run = this.runs.get(node) ?? { revision: 0 };
        this.runs.set(node, run);
        this.cancel(node);
        const revision = ++run.revision;
        if (!node.visible || !node.parentVisible || !node.parent) {
            node.status = "idle";
            return;
        }
        const evaluator = this.evaluators.get(node.kind);
        if (!evaluator) {
            node.status = "invalid";
            node.error = `No evaluator registered for ${node.kind}`;
            return;
        }
        const sources: ResolvedAnalysisSource[] = [];
        for (const reference of node.sources) {
            const source = this.resolveSource(reference);
            if (!source.isOk) {
                sources.forEach((resolved) => resolved.dispose());
                node.status = "invalid";
                node.error = source.error;
                return;
            }
            sources.push(source.value);
        }
        const controller = new AbortController();
        run.controller = controller;
        node.status = "running";
        node.error = undefined;
        const context: AnalysisContext = {
            analysisId: node.id,
            sources,
            settings: node.settings,
            signal: controller.signal,
        };
        let result: Result<AnalysisResult>;
        try {
            result = await evaluator(context);
        } catch (error) {
            result = Result.err(error instanceof Error ? error.message : String(error));
        }
        if (controller.signal.aborted || revision !== run.revision || this.disposed) {
            result.unchecked()?.dispose?.();
            sources.forEach((source) => source.dispose());
            return;
        }
        run.controller = undefined;
        if (!result.isOk) {
            node.status = "invalid";
            node.error = result.error;
            sources.forEach((source) => source.dispose());
            return;
        }
        run.result = result.value;
        try {
            if (result.value.marker) {
                run.markerMeshId = this.document.visual.context.displayMesh([
                    MeshDataUtils.createVertexMesh(new XYZ(result.value.marker), 8, 0xffcc33),
                ]);
            }
            run.displayOrder = ++this.displaySequence;
            this.refreshOverlays();
            run.restoreDisplay = result.value.display?.(context) || undefined;
        } catch (error) {
            this.cancel(node);
            node.status = "invalid";
            node.error = error instanceof Error ? error.message : String(error);
            sources.forEach((source) => source.dispose());
            return;
        }
        sources.forEach((source) => source.dispose());
        node.status = "ready";
        this.document.visual.update();
        PubSub.default.pub("analysisDisplayChanged", this.document);
    }

    result(node: AnalysisNode): AnalysisResult | undefined {
        return this.runs.get(node)?.result;
    }

    /** Newest conflicting display wins; independent line and point results remain visible. */
    private refreshOverlays(): void {
        const faceColorKinds = new Set([
            "curvatureMap",
            "draft",
            "accessibility",
            "minimumRadius",
            "meshFaceGroups",
        ]);
        const appearanceKinds = new Set(["environmentMap", "zebra", "componentColors"]);
        const ordered = [...this.runs.entries()]
            .filter(([node, run]) => node.visible && node.parentVisible && !!run.result)
            .sort((a, b) => (b[1].displayOrder ?? 0) - (a[1].displayOrder ?? 0));
        const occupiedSources = new Set<string>();
        let sectionClaimed = false;
        const active = new Set<AnalysisNode>();
        for (const [node] of ordered) {
            if (node.kind === "section") {
                if (sectionClaimed) continue;
                sectionClaimed = true;
            } else if (faceColorKinds.has(node.kind) || appearanceKinds.has(node.kind)) {
                if (faceColorKinds.has(node.kind) && !this.runs.get(node)?.result?.overlays?.length) continue;
                const selected = node.settings["targetSourceIndexes"];
                const sources =
                    node.kind === "componentColors"
                        ? this.document.modelManager
                              .findNodes((item) => item instanceof ShapeNode || item instanceof MeshNode)
                              .map((item) => item.id)
                        : Array.isArray(selected)
                          ? selected
                                .map((index) => node.sources[index]?.nodeId)
                                .filter((id): id is string => !!id)
                          : node.sources.flatMap((source, index) =>
                                index === node.settings["directionSourceIndex"] ? [] : [source.nodeId],
                            );
                if (sources.some((id) => occupiedSources.has(id))) continue;
                sources.forEach((id) => occupiedSources.add(id));
            }
            active.add(node);
        }
        for (const [node, run] of this.runs) {
            if (!active.has(node) && run.meshId !== undefined) {
                this.document.visual.context.removeMesh(run.meshId);
                run.meshId = undefined;
            } else if (active.has(node) && run.meshId === undefined && run.result?.overlays?.length) {
                run.meshId = this.document.visual.context.displayMesh(run.result.overlays);
            }
        }
    }

    selectResultRow(node: AnalysisNode, index: number): void {
        const run = this.runs.get(node);
        if (!run) return;
        if (run.selectedRowMeshId !== undefined)
            this.document.visual.context.removeMesh(run.selectedRowMeshId);
        run.selectedRowMeshId = undefined;
        const overlays = run.result?.rows?.[index]?.overlays;
        if (overlays?.length) run.selectedRowMeshId = this.document.visual.context.displayMesh(overlays);
        this.document.visual.update();
    }

    private cancel(node: AnalysisNode): void {
        const run = this.runs.get(node);
        if (!run) return;
        run.controller?.abort();
        run.controller = undefined;
        if (run.meshId !== undefined) this.document.visual.context.removeMesh(run.meshId);
        run.meshId = undefined;
        if (run.markerMeshId !== undefined) this.document.visual.context.removeMesh(run.markerMeshId);
        run.markerMeshId = undefined;
        if (run.selectedRowMeshId !== undefined)
            this.document.visual.context.removeMesh(run.selectedRowMeshId);
        run.selectedRowMeshId = undefined;
        run.restoreDisplay?.();
        run.restoreDisplay = undefined;
        run.result?.dispose?.();
        run.result = undefined;
        run.displayOrder = undefined;
        if (!this.disposed) this.refreshOverlays();
        PubSub.default.pub("analysisDisplayChanged", this.document);
    }

    private readonly onTreeChanged = () => {
        this.attachModel();
        for (const other of this.document.application?.documents ?? []) {
            for (const analysis of other.analyses.items) {
                if (analysis.kind === "similarComponents") void other.analyses.evaluate(analysis);
            }
        }
    };

    private readonly onLibraryDocumentsChanged = (changed: IDocument) => {
        if (this.disposed || changed === this.document || changed.application !== this.document.application)
            return;
        for (const analysis of this.items) {
            if (analysis.kind === "similarComponents" && analysis.visible) void this.evaluate(analysis);
        }
    };

    private readonly onSourceChanged = (property: string, changed: INode) => {
        if (changed instanceof AnalysisNode) {
            if (
                property === "settings" ||
                property === "sources" ||
                property === "visible" ||
                property === "parentVisible"
            ) {
                void this.evaluate(changed);
            }
            return;
        }
        if (
            property === "shape" ||
            property === "mesh" ||
            property === "transform" ||
            property === "visible" ||
            property === "parentVisible"
        ) {
            for (const node of this.items) {
                if (
                    node.kind === "similarComponents" ||
                    node.kind === "section" ||
                    node.sources.some(
                        (source) => source.nodeId === changed.id || this.isAncestor(changed, source.nodeId),
                    )
                ) {
                    void this.evaluate(node);
                }
            }
            for (const other of this.document.application?.documents ?? []) {
                if (other === this.document) continue;
                for (const analysis of other.analyses.items) {
                    if (analysis.kind === "similarComponents") void other.analyses.evaluate(analysis);
                }
            }
        }
    };

    private isAncestor(ancestor: INode, nodeId: string): boolean {
        let node = this.document.modelManager.findNode((candidate) => candidate.id === nodeId);
        while (node?.parent) {
            if (node.parent === ancestor) return true;
            node = node.parent;
        }
        return false;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.document.modelManager.removeNodeObserver(this.onTreeChanged);
        PubSub.default.remove("documentOpened", this.onLibraryDocumentsChanged);
        PubSub.default.remove("documentClosed", this.onLibraryDocumentsChanged);
        for (const node of this.watched) node.removePropertyChanged(this.onSourceChanged);
        this.watched.clear();
        for (const node of this.runs.keys()) this.cancel(node);
        this.runs.clear();
        this.evaluators.clear();
    }
}
