// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, CancelableCommand, command, type INode, property } from "@spicy3d/core";
import type { SweepFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { pickSweepPath, pickSweepSection } from "./sweepPicks";

@command({ key: "feature.editSweep", icon: "icon-sweep" })
export class SweepEditCommand extends CancelableCommand {
    private feature?: SweepFeatureData;
    private preview?: FeatureChainPreview;
    private previewIds: number[] = [];
    private sourceVisibility: INode[] = [];
    private pickController?: AsyncController;
    private picking?: Promise<void>;
    private previewValid = false;

    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }
    protected override isPropertyCached(): boolean {
        return false;
    }
    @property("option.command.isSolid")
    get solid(): boolean {
        return this.getPrivateValue("solid", true);
    }
    set solid(value: boolean) {
        this.setProperty("solid", value, () => this.refreshPreview());
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
        const body = this.body;
        if (!body) return;
        const index = body.features.findIndex((feature) => feature.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== "sweep") return;
        this.setProperty("solid", feature.solid !== false);
        this.setProperty("roundCorner", feature.roundCorner === true);
        this.feature = feature;
        this.preview = new FeatureChainPreview(body, index);
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
        if (confirmed && this.feature) commitFeatureEdit(body, this.edited());
    }
    private edited(): SweepFeatureData {
        const { solid: _solid, roundCorner: _round, ...rest } = this.feature as SweepFeatureData;
        return {
            ...rest,
            ...(this.solid ? {} : { solid: false }),
            ...(this.roundCorner ? { roundCorner: true } : {}),
        };
    }
    private refreshPreview(): void {
        if (!this.body || !this.preview || !this.feature) return;
        this.clearPreview();
        const result = this.preview.evaluate(this.edited(), false);
        this.previewValid = result.error === undefined && result.shape !== undefined;
        showPreviewProblem(result.error ?? result.warning);
        const meshes = result.shape && previewMeshes(this.body, result.shape);
        if (meshes) {
            for (const mesh of meshes)
                this.previewIds.push(this.document.visual.context.displayMesh([mesh], { meshOpacity: 1 }));
            this.document.visual.context.setVisible(this.body, false);
        }
        this.document.visual.update();
    }
    private clearPreview(): void {
        for (const id of this.previewIds) this.document.visual.context.removeMesh(id);
        this.previewIds = [];
        if (this.body)
            this.document.visual.context.setVisible(this.body, this.body.visible && this.body.parentVisible);
        this.document.visual.update();
    }
}

registerFeatureEditor("sweep", (body, featureId) => new SweepEditCommand(body, featureId));
