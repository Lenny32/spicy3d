// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    Continuities,
    type Continuity,
    command,
    type INode,
    property,
} from "@spicy3d/core";
import type { LoftFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { pickGuidedLoftPath } from "./guidedLoftPicking";

/**
 * Reopens a loft with its options (solid, ruled, continuity) in the command panel and the body
 * previewed through `FeatureChainPreview` on every change; Confirm replaces the options as one
 * undo step, Cancel leaves the model untouched. The sections stay the feature's own.
 */
@command({ key: "feature.editLoft", icon: "icon-loft" })
export class LoftEditCommand extends CancelableCommand {
    private feature: LoftFeatureData | undefined;
    private preview: FeatureChainPreview | undefined;
    private previewIds: number[] = [];
    private hidden: INode[] = [];
    private spine: NonNullable<LoftFeatureData["guided"]>["spine"] | undefined;
    private boundary: NonNullable<LoftFeatureData["guided"]>["boundary"] | undefined;
    private pickController: AsyncController | undefined;
    private valid = false;

    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    /** The session shows the feature's own options; they must not become the next new loft's. */
    protected override isPropertyCached(): boolean {
        return false;
    }

    @property("option.command.isSolid")
    get solid() {
        return this.getPrivateValue("solid", true);
    }
    set solid(value: boolean) {
        this.setProperty("solid", value, () => this.refreshPreview());
    }

    @property("option.command.isRuled")
    get ruled() {
        return this.getPrivateValue("ruled", false);
    }
    set ruled(value: boolean) {
        this.setProperty("ruled", value, () => this.refreshPreview());
    }

    @property("option.command.continuity", {
        dependencies: [{ property: "ruled", value: false }],
        combobox: Combobox.from([...Continuities]),
    })
    get continuity(): Continuity {
        return this.getPrivateValue("continuity", "c2");
    }
    set continuity(value: Continuity) {
        this.setProperty("continuity", value, () => this.refreshPreview());
    }

    @property("loft.guided")
    get guided() {
        return this.getPrivateValue("guided", false);
    }
    set guided(value: boolean) {
        this.setProperty("guided", value, () => this.refreshPreview());
    }

    @property("loft.pickSpine", { dependencies: [{ property: "guided", value: true }] })
    readonly pickSpine = () => this.repick("spine");
    @property("loft.pickBoundary", { dependencies: [{ property: "guided", value: true }] })
    readonly pickBoundary = () => this.repick("boundary");

    private async repick(role: "spine" | "boundary"): Promise<void> {
        if (this.pickController || this.controller?.result !== undefined) return;
        const controller = new AsyncController();
        this.pickController = controller;
        try {
            const result = await pickGuidedLoftPath(
                this.document,
                controller,
                role === "spine" ? "loft.spine" : "loft.boundary",
            );
            if (result?.isOk) {
                if (role === "spine") this.spine = result.value;
                else this.boundary = result.value;
            } else if (result) showPreviewProblem(result.error);
        } finally {
            this.pickController = undefined;
            if (this.controller?.result === undefined) this.refreshPreview();
        }
    }

    @property("common.confirm")
    readonly confirm = () => {
        if (this.pickController) this.pickController.success();
        else if (this.valid) this.controller?.success();
    };

    protected override async executeAsync(): Promise<void> {
        const body = this.body;
        if (body === undefined || this.featureId === undefined) return;
        const index = body.features.findIndex((x) => x.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== "loft") return;

        // Published: the options tab is already open (`beforeExecute`) and must show them.
        this.setProperty("solid", feature.solid !== false);
        this.setProperty("ruled", feature.ruled === true);
        this.setProperty("continuity", feature.continuity ?? "c2");
        this.setProperty("guided", feature.guided !== undefined);
        this.spine = feature.guided?.spine;
        this.boundary = feature.guided?.boundary;
        this.feature = feature;
        this.preview = new FeatureChainPreview(body, index);

        const controller = new AsyncController();
        this.controller = controller;
        controller.onCancelled(() => this.pickController?.cancel());
        const closeSession = openFeatureEditSession(body);
        let confirmed = false;
        try {
            this.refreshPreview();
            confirmed = await new Promise<boolean>((resolve) => {
                controller.onCompleted(() => resolve(true));
                controller.onCancelled(() => resolve(false));
                controller.onFailed(() => resolve(false));
            });
        } finally {
            this.clearPreview();
            showPreviewProblem(undefined);
            closeSession();
        }
        const edited = this.edited(feature);
        if (confirmed && edited) commitFeatureEdit(body, edited);
    }

    /** The feature with the panel's options, absent fields for the defaults (as the creation writes them). */
    private edited(feature: LoftFeatureData): LoftFeatureData | undefined {
        if (this.guided && (!this.spine || !this.boundary)) return undefined;
        const { solid: _solid, ruled: _ruled, continuity: _continuity, guided: _guided, ...rest } = feature;
        return {
            ...rest,
            ...(this.solid ? {} : { solid: false }),
            ...(this.ruled ? { ruled: true } : {}),
            ...(this.ruled || this.continuity === "c2" ? {} : { continuity: this.continuity }),
            ...(this.guided && this.spine && this.boundary
                ? { guided: { spine: this.spine, boundary: this.boundary } }
                : {}),
        };
    }

    private refreshPreview(): void {
        const body = this.body;
        if (body === undefined || this.feature === undefined || this.preview === undefined) return;
        this.clearPreview();
        this.valid = false;
        const edited = this.edited(this.feature);
        if (!edited) {
            showPreviewProblem("Select a main spine and boundary guide for the guided loft");
            return;
        }
        const result = this.preview.evaluate(edited, false);
        this.valid = result.shape !== undefined && (!edited.guided || result.error === undefined);
        showPreviewProblem(result.error ?? result.warning, result.note);
        const meshes = result.shape === undefined ? undefined : previewMeshes(body, result.shape);
        const context = this.document.visual.context;
        if (meshes !== undefined) {
            for (const mesh of meshes) this.previewIds.push(context.displayMesh([mesh], { meshOpacity: 1 }));
            context.setVisible(body, false);
            this.hidden.push(body);
        }
        this.document.visual.update();
    }

    private clearPreview(): void {
        const context = this.document.visual.context;
        for (const id of this.previewIds) context.removeMesh(id);
        this.previewIds = [];
        // Nodes the preview stood in for go back to what their own flags say.
        for (const node of this.hidden) context.setVisible(node, node.visible && node.parentVisible);
        this.hidden = [];
        this.document.visual.update();
    }
}

registerFeatureEditor("loft", (body, featureId) => new LoftEditCommand(body, featureId));
