// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    Id,
    Matrix4,
    PubSub,
    pickedTopologyIndex,
    property,
    SelectShapeStep,
    ShapeNode,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import { evaluateFeature, type ProjectionFeatureData } from "../features/feature";
import { capturePathReference } from "../features/pathReferences";
import { captureProjectionTarget } from "../features/projectionTargetReferences";
import { ParametricBodyNode } from "../parametricBodyNode";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";

@command({ key: "feature.projection", icon: "icon-projectEdges" })
export class ProjectionCommand extends CancelableCommand {
    private feature: ProjectionFeatureData | undefined;
    private preview: FeatureChainPreview | undefined;
    private visuals: number[] = [];
    private valid = false;
    private hidden = false;
    private picking = false;
    private pickController: AsyncController | undefined;

    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }
    protected override isPropertyCached(): boolean {
        return false;
    }

    @property("projection.directionX")
    get directionX() {
        return this.getPrivateValue("directionX", 0);
    }
    set directionX(value: number) {
        this.setProperty("directionX", value, () => this.refreshPreview());
    }
    @property("projection.directionY")
    get directionY() {
        return this.getPrivateValue("directionY", 0);
    }
    set directionY(value: number) {
        this.setProperty("directionY", value, () => this.refreshPreview());
    }
    @property("projection.directionZ")
    get directionZ() {
        return this.getPrivateValue("directionZ", 1);
    }
    set directionZ(value: number) {
        this.setProperty("directionZ", value, () => this.refreshPreview());
    }
    @property("projection.reverse")
    readonly reverse = () => {
        this.setProperty("directionX", -this.directionX);
        this.setProperty("directionY", -this.directionY);
        this.setProperty("directionZ", -this.directionZ);
        this.refreshPreview();
    };
    @property("common.confirm")
    readonly confirm = () => {
        if (this.picking) this.pickController?.success();
        else if (this.valid) this.controller?.success();
    };

    @property("projection.repick")
    readonly repick = async () => {
        if (this.picking || !this.feature) return;
        const previous = this.feature;
        try {
            if ((await this.pickInputs()) && this.feature)
                this.feature = { ...this.feature, id: previous.id, name: previous.name };
            else this.feature = previous;
        } finally {
            this.pickController = undefined;
            this.picking = false;
            if (this.controller?.result === undefined) this.refreshPreview();
        }
    };

    private edited(): ProjectionFeatureData | undefined {
        return this.feature
            ? { ...this.feature, direction: { x: this.directionX, y: this.directionY, z: this.directionZ } }
            : undefined;
    }

    protected override async executeAsync(): Promise<void> {
        let closeSession: (() => void) | undefined;
        const controller = new AsyncController();
        this.controller = controller;
        controller.onCancelled(() => this.pickController?.cancel());
        try {
            if (this.body) {
                const index = this.body.features.findIndex((feature) => feature.id === this.featureId);
                const feature = this.body.features[index];
                if (feature?.type !== "projection") return;
                this.feature = feature;
                this.setProperty("directionX", feature.direction.x);
                this.setProperty("directionY", feature.direction.y);
                this.setProperty("directionZ", feature.direction.z);
                this.preview = new FeatureChainPreview(this.body, index);
                closeSession = openFeatureEditSession(this.body);
            } else if (!(await this.pickInputs())) return;
            this.refreshPreview();
            const confirmed = await new Promise<boolean>((resolve) => {
                controller.onCompleted(() => resolve(true));
                controller.onCancelled(() => resolve(false));
                controller.onFailed(() => resolve(false));
            });
            if (!confirmed || !this.valid) return;
            const feature = this.edited();
            if (!feature) return;
            this.clearPreview();
            closeSession?.();
            closeSession = undefined;
            if (this.body) commitFeatureEdit(this.body, feature);
            else {
                const node = new ParametricBodyNode({ document: this.document, features: [feature] });
                if (!node.shape.isOk) {
                    PubSub.default.pub("showToast", "error.default:{0}", node.shape.error);
                    node.dispose();
                    return;
                }
                Transaction.execute(this.document, "execute feature.projection", () =>
                    this.document.modelManager.addNode(node),
                );
            }
        } finally {
            this.clearPreview();
            closeSession?.();
            showPreviewProblem(undefined);
            this.document.selection.clearSelection();
        }
    }

    private async pickInputs(): Promise<boolean> {
        const sourceController = new AsyncController();
        this.pickController = sourceController;
        const picked = await new SelectShapeStep(ShapeTypes.edge, "prompt.select.edges", {
            multiple: true,
            beforeSelection: () => {
                this.picking = true;
            },
            afterSelection: () => {
                this.picking = false;
            },
        }).execute(this.document, sourceController);
        const sourceNode = picked?.shapes[0]?.owner.node;
        if (!(sourceNode instanceof ShapeNode) || !picked || picked.shapes.length === 0) return false;
        const edges = [];
        for (const shape of picked.shapes) {
            const index = pickedTopologyIndex(shape);
            if (shape.owner.node !== sourceNode || index === undefined) {
                showPreviewProblem("Select an ordered edge chain from one source node");
                return false;
            }
            const edge = capturePathReference(sourceNode, index);
            if (!edge.isOk) {
                showPreviewProblem(edge.error);
                return false;
            }
            edges.push(edge.value);
        }
        const targetController = new AsyncController();
        this.pickController = targetController;
        const targetPick = await new SelectShapeStep(ShapeTypes.face, "projection.target", {
            multiple: false,
            beforeSelection: () => {
                this.picking = true;
            },
            afterSelection: () => {
                this.picking = false;
            },
            nodeFilter: { allow: (node) => node instanceof ParametricBodyNode },
        }).execute(this.document, targetController);
        const shape = targetPick?.shapes[0];
        const targetNode = shape?.owner.node;
        const index = shape === undefined ? undefined : pickedTopologyIndex(shape);
        if (!(targetNode instanceof ShapeNode) || index === undefined) return false;
        const target = captureProjectionTarget(targetNode, index);
        if (!target.isOk) {
            showPreviewProblem(target.error);
            return false;
        }
        this.feature = {
            id: Id.generate(),
            type: "projection",
            source: { nodeId: sourceNode.id, edges },
            target: target.value,
            direction: { x: this.directionX, y: this.directionY, z: this.directionZ },
        };
        return true;
    }

    private refreshPreview(): void {
        this.clearPreview();
        this.valid = false;
        const feature = this.edited();
        if (!feature) return;
        const result = this.preview?.evaluate(feature, false);
        const standalone = result
            ? undefined
            : evaluateFeature(feature, {
                  document: this.document,
                  host: { id: "", worldTransform: () => Matrix4.identity() },
                  scope: this.document.variables.evaluate().scope,
              });
        const shape = result?.shape ?? (standalone?.isOk ? standalone.value : undefined);
        const error = result?.error ?? (standalone && !standalone.isOk ? standalone.error : undefined);
        showPreviewProblem(error, result?.note);
        if (shape) {
            this.valid = error === undefined;
            const meshes = this.body
                ? previewMeshes(this.body, shape)
                : [shape.mesh.edges, shape.mesh.faces].filter((mesh) => mesh !== undefined);
            if (meshes)
                for (const mesh of meshes)
                    this.visuals.push(this.document.visual.context.displayMesh([mesh], { meshOpacity: 1 }));
            if (this.body) {
                this.document.visual.context.setVisible(this.body, false);
                this.hidden = true;
            }
        }
        if (standalone?.isOk) standalone.value.dispose();
        this.document.visual.update();
    }

    private clearPreview(): void {
        const context = this.document.visual.context;
        for (const id of this.visuals) context.removeMesh(id);
        this.visuals = [];
        if (this.hidden && this.body)
            context.setVisible(this.body, this.body.visible && this.body.parentVisible);
        this.hidden = false;
        this.document.visual.update();
    }
}

registerFeatureEditor("projection", (body, featureId) => new ProjectionCommand(body, featureId));
