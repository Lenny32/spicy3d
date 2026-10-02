// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
    Id,
    type INode,
    type IShape,
    property,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import { evaluateFeature, type FaceSweepFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { pickFaceSweepSupport } from "./faceSweepPicks";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { pickSweepPath, pickSweepSection } from "./sweepPicks";

@command({ key: "feature.faceSweep", helpText: "tooltip.feature.faceSweep", icon: "icon-sweep" })
export class FaceSweepCommand extends CancelableCommand {
    private feature?: FaceSweepFeatureData;
    private preview?: FeatureChainPreview;
    private previewIds: number[] = [];
    private sourceVisibility: INode[] = [];
    private pickController?: AsyncController;
    private picking?: Promise<void>;
    private previewValid = false;

    constructor(
        private body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }
    protected override isPropertyCached(): boolean {
        return false;
    }
    @property("faceSweep.operation", {
        combobox: Combobox.from(["option.command.operation.join", "option.command.operation.cut"]),
    })
    get operation(): "option.command.operation.join" | "option.command.operation.cut" {
        return this.getPrivateValue("operation", "option.command.operation.join");
    }
    set operation(value: "option.command.operation.join" | "option.command.operation.cut") {
        this.setProperty("operation", value, () => this.refreshPreview());
    }
    @property("option.command.roundCorner")
    get roundCorner(): boolean {
        return this.getPrivateValue("roundCorner", false);
    }
    set roundCorner(value: boolean) {
        this.setProperty("roundCorner", value, () => this.refreshPreview());
    }
    @property("option.command.sweepSection")
    readonly pickSection = (): Promise<void> =>
        this.pick(async () => {
            const section = await pickSweepSection(this.document, this.newPickController());
            if (section && this.feature) this.feature = { ...this.feature, section };
        });
    @property("option.command.sweepPath")
    readonly pickPath = (): Promise<void> =>
        this.pick(async () => {
            const path = await pickSweepPath(
                this.document,
                () => this.newPickController(),
                undefined,
                this.body,
            );
            if (path && this.feature) this.feature = { ...this.feature, path };
        });
    @property("faceSweep.pickSupport")
    readonly pickSupport = (): Promise<void> =>
        this.pick(async () => {
            const picked = await pickFaceSweepSupport(this.document, this.newPickController(), this.body);
            if (picked && this.feature) this.feature = { ...this.feature, support: picked.support };
        });
    @property("common.confirm")
    readonly confirm = () => {
        if (this.pickController) this.pickController.success();
        else if (this.previewValid) this.controller?.success();
    };

    override async cancel(): Promise<void> {
        this.pickController?.cancel();
        await super.cancel();
    }
    private newPickController(): AsyncController {
        this.pickController?.dispose();
        this.pickController = new AsyncController();
        return this.pickController;
    }
    private pick(action: () => Promise<void>): Promise<void> {
        if (this.picking || !this.feature) return this.picking ?? Promise.resolve();
        this.picking = action()
            .catch((error) => showPreviewProblem(error instanceof Error ? error.message : String(error)))
            .finally(() => {
                this.pickController?.dispose();
                this.pickController = undefined;
                this.picking = undefined;
                if (!this.isCanceled) this.refreshPreview();
            });
        return this.picking;
    }
    protected override async executeAsync(): Promise<void> {
        try {
            await this.executeSession();
        } finally {
            this.pickController?.cancel();
            this.clearPreview();
            showPreviewProblem(undefined);
            this.document.selection.clearSelection();
            this.document.visual.update();
        }
    }
    private async executeSession(): Promise<void> {
        if (!this.body) {
            const picked = await pickFaceSweepSupport(this.document, this.newPickController());
            if (!picked || this.isCanceled) return;
            this.body = picked.body;
            const section = await pickSweepSection(this.document, this.newPickController());
            if (!section || this.isCanceled) return;
            const path = await pickSweepPath(
                this.document,
                () => this.newPickController(),
                undefined,
                this.body,
            );
            if (!path || this.isCanceled) return;
            this.feature = {
                id: Id.generate(),
                type: "faceSweep",
                section,
                path,
                support: picked.support,
                operation: "join",
            };
            this.pickController?.dispose();
            this.pickController = undefined;
        }
        const body = this.body;
        const creating = this.featureId === undefined;
        const index = creating
            ? body.features.length
            : body.features.findIndex((feature) => feature.id === this.featureId);
        const feature = creating ? this.feature : body.features[index];
        if (feature?.type !== "faceSweep") return;
        this.setProperty(
            "operation",
            feature.operation === "cut" ? "option.command.operation.cut" : "option.command.operation.join",
        );
        this.setProperty("roundCorner", feature.roundCorner === true);
        this.feature = feature;
        this.preview = creating ? undefined : new FeatureChainPreview(body, index);
        const controller = new AsyncController();
        this.controller = controller;
        const closeSession = openFeatureEditSession(body);
        for (const id of [feature.section.sketchId, feature.path.nodeId]) {
            const source = this.document.modelManager.findNode((node) => node.id === id);
            if (source && source !== body) {
                this.sourceVisibility.push(source);
                this.document.visual.context.setVisible(source, true);
            }
        }
        let confirmed = false;
        try {
            this.refreshPreview();
            confirmed = await new Promise<boolean>((resolve) => {
                controller.onCompleted(() => resolve(true));
                controller.onCancelled(() => resolve(false));
                controller.onFailed(() => resolve(false));
            });
        } finally {
            this.pickController?.cancel();
            await this.picking;
            this.clearPreview();
            showPreviewProblem(undefined);
            for (const source of this.sourceVisibility)
                this.document.visual.context.setVisible(source, source.visible && source.parentVisible);
            this.sourceVisibility = [];
            closeSession();
            this.document.visual.update();
        }
        if (confirmed && this.previewValid && this.feature) {
            if (creating)
                Transaction.execute(this.document, "create groove or rib", () => {
                    body.setFeaturesEmitShapeChanged([...body.features, this.edited()]);
                    const source = this.document.modelManager.findNode(
                        (node) => node.id === this.feature?.section.sketchId,
                    );
                    if (source) source.visible = false;
                });
            else commitFeatureEdit(body, this.edited());
        }
    }
    private edited(): FaceSweepFeatureData {
        const { roundCorner: _round, ...rest } = this.feature as FaceSweepFeatureData;
        return {
            ...rest,
            operation: this.operation === "option.command.operation.cut" ? "cut" : "join",
            ...(this.roundCorner ? { roundCorner: true } : {}),
        };
    }
    private refreshPreview(): void {
        if (!this.body || !this.feature) return;
        this.clearPreview();
        const result = this.preview ? this.preview.evaluate(this.edited(), false) : this.creationPreview();
        this.previewValid = result.error === undefined && result.shape !== undefined;
        showPreviewProblem(result.error ?? result.warning, "note" in result ? result.note : undefined);
        const meshes = result.shape && previewMeshes(this.body, result.shape);
        if (meshes) {
            for (const mesh of meshes)
                this.previewIds.push(this.document.visual.context.displayMesh([mesh], { meshOpacity: 1 }));
            this.document.visual.context.setVisible(this.body, false);
        }
        this.document.visual.update();
    }
    private creationPreview(): { shape?: IShape; error?: string; warning?: string } {
        const body = this.body;
        if (!body || !body.shape.isOk) return { error: "Face sweep requires a valid existing body" };
        const faces = body.shape.value.findSubShapes(ShapeTypes.face),
            edges = body.shape.value.findSubShapes(ShapeTypes.edge);
        try {
            let warning: string | undefined;
            const result = evaluateFeature(this.edited(), {
                warn: (message) => {
                    warning = message;
                },
                document: this.document,
                host: body,
                input: body.shape.value,
                scope: this.document.variables.evaluate().scope,
                tracking: {
                    inputFaceIds: faces.map((_, i) => body.faceIdAt(i) ?? ""),
                    inputEdgeIds: edges.map((_, i) => body.edgeIdAt(i) ?? ""),
                    outputFaceIds: [],
                    outputEdgeIds: [],
                },
            });
            return result.isOk ? { shape: result.value, warning } : { error: result.error };
        } finally {
            for (const shape of [...faces, ...edges]) shape.dispose();
        }
    }
    private clearPreview(): void {
        for (const id of this.previewIds) this.document.visual.context.removeMesh(id);
        this.previewIds = [];
        if (this.body)
            this.document.visual.context.setVisible(this.body, this.body.visible && this.body.parentVisible);
        this.document.visual.update();
    }
}

@command({ key: "feature.editFaceSweep", icon: "icon-sweep" })
export class FaceSweepEditCommand extends FaceSweepCommand {}
registerFeatureEditor("faceSweep", (body, featureId) => new FaceSweepEditCommand(body, featureId));
