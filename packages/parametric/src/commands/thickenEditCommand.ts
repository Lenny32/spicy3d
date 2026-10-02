// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    Combobox,
    command,
    type I18nKeys,
    type INode,
    LENGTH_UNITS,
    type ParameterValue,
    PubSub,
    property,
} from "@spicy3d/core";
import type { ThickenFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { THICKEN_JOIN_TYPES, THICKEN_MODES, thickenOptionKeys, thickenOptions } from "./thickenCommand";

/**
 * Reopens a thicken with its thickness (an expression, like an extrude depth), join type and mode
 * in the command panel, the body previewed through `FeatureChainPreview` on every change; Confirm
 * replaces them as one undo step, Cancel leaves the model untouched. The open faces stay the
 * feature's own.
 */
@command({ key: "feature.editThicken", icon: "icon-shell" })
export class ThickenEditCommand extends CancelableCommand {
    private feature: ThickenFeatureData | undefined;
    private preview: FeatureChainPreview | undefined;
    private previewIds: number[] = [];
    private hidden: INode[] = [];

    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    /** The session shows the feature's own values; they must not become the next new thicken's. */
    protected override isPropertyCached(): boolean {
        return false;
    }

    @property("option.command.thickness", { unit: LENGTH_UNITS })
    get thickness(): ParameterValue {
        return this.getPrivateValue("thickness", -1);
    }
    set thickness(value: ParameterValue) {
        this.setProperty("thickness", value, () => this.refreshPreview());
    }

    @property("option.command.joinType", { combobox: Combobox.from([...THICKEN_JOIN_TYPES]) })
    get joinType(): I18nKeys {
        return this.getPrivateValue("joinType", "option.command.joinType.arc");
    }
    set joinType(value: I18nKeys) {
        this.setProperty("joinType", value, () => this.refreshPreview());
    }

    @property("option.command.offsetMode", { combobox: Combobox.from([...THICKEN_MODES]) })
    get mode(): I18nKeys {
        return this.getPrivateValue("mode", "option.command.offsetMode.skin");
    }
    set mode(value: I18nKeys) {
        this.setProperty("mode", value, () => this.refreshPreview());
    }

    @property("common.confirm")
    readonly confirm = () => {
        this.controller?.success();
    };

    protected override async executeAsync(): Promise<void> {
        const body = this.body;
        if (body === undefined || this.featureId === undefined) return;
        const index = body.features.findIndex((x) => x.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== "thicken") return;

        // Published: the options tab is already open (`beforeExecute`) and must show them.
        const keys = thickenOptionKeys(feature);
        this.setProperty("thickness", feature.thickness);
        this.setProperty("joinType", keys.joinType);
        this.setProperty("mode", keys.mode);
        this.feature = feature;
        this.preview = new FeatureChainPreview(body, index);

        const controller = new AsyncController();
        this.controller = controller;
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
        if (!confirmed) return;
        // As the creation: a thickness that no longer resolves would fail the rebuild.
        const resolved = this.resolveParameter(this.thickness, LENGTH_UNITS);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        commitFeatureEdit(body, this.edited(feature));
    }

    /** The feature with the panel's values, absent fields for the defaults (as the creation writes them). */
    private edited(feature: ThickenFeatureData): ThickenFeatureData {
        const { joinType: _joinType, mode: _mode, ...rest } = feature;
        return { ...rest, thickness: this.thickness, ...thickenOptions(this.joinType, this.mode) };
    }

    private refreshPreview(): void {
        const body = this.body;
        if (body === undefined || this.feature === undefined || this.preview === undefined) return;
        this.clearPreview();
        const result = this.preview.evaluate(this.edited(this.feature), false);
        showPreviewProblem(result.error ?? result.warning);
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

registerFeatureEditor("thicken", (body, featureId) => new ThickenEditCommand(body, featureId));
