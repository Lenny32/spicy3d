// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    Id,
    Matrix4,
    PubSub,
    property,
    Transaction,
} from "@spicy3d/core";
import { evaluateFeature, type LoftSection, type SweepFeatureData } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { showPreviewProblem } from "./featureEditPreview";
import { pickSweepPath, pickSweepSection } from "./sweepPicks";

@command({ key: "feature.sweep", helpText: "tooltip.feature.sweep", icon: "icon-sweep" })
export class SweepFeatureCommand extends CancelableCommand {
    private section?: LoftSection;
    private path?: SweepFeatureData["path"];
    private readonly featureId = Id.generate();
    private previewId?: number;

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
    @property("common.confirm")
    readonly confirm = () => {
        this.controller?.success();
    };

    private nextController(): AsyncController {
        this.controller = new AsyncController();
        return this.controller;
    }

    protected override async executeAsync(): Promise<void> {
        try {
            this.section = await pickSweepSection(this.document, this.nextController());
            if (!this.section) return;
            this.path = await pickSweepPath(
                this.document,
                () => this.nextController(),
                (path) => {
                    this.path = path;
                    this.refreshPreview();
                },
            );
            const feature = this.feature();
            if (!feature || this.isCanceled) return;
            const body = new ParametricBodyNode({ document: this.document, features: [feature] });
            if (!body.shape.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", body.shape.error);
                body.dispose();
                return;
            }
            Transaction.execute(this.document, "create sweep", () => {
                this.document.modelManager.addNode(body);
                const source = this.document.modelManager.findNode(
                    (node) => node.id === feature.section.sketchId,
                );
                if (source) source.visible = false;
            });
        } finally {
            this.clearPreview();
            showPreviewProblem(undefined);
            this.document.selection.clearSelection();
            this.document.visual.update();
        }
    }

    private feature(): SweepFeatureData | undefined {
        return this.section && this.path
            ? {
                  id: this.featureId,
                  type: "sweep",
                  section: this.section,
                  path: this.path,
                  ...(this.solid ? {} : { solid: false }),
                  ...(this.roundCorner ? { roundCorner: true } : {}),
              }
            : undefined;
    }
    private refreshPreview(): void {
        this.clearPreview();
        const feature = this.feature();
        if (!feature) return;
        const result = evaluateFeature(feature, {
            document: this.document,
            host: { id: "", worldTransform: () => Matrix4.identity() },
            scope: this.document.variables.evaluate().scope,
        });
        if (!result.isOk) {
            showPreviewProblem(result.error);
            return;
        }
        showPreviewProblem(undefined);
        try {
            const mesh = result.value.mesh.faces;
            if (mesh) this.previewId = this.document.visual.context.displayMesh([mesh], { meshOpacity: 0.5 });
        } finally {
            result.value.dispose();
        }
        this.document.visual.update();
    }
    private clearPreview(): void {
        if (this.previewId === undefined) return;
        this.document.visual.context.removeMesh(this.previewId);
        this.previewId = undefined;
    }
}
