// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    AsyncController,
    CancelableCommand,
    command,
    Line,
    type ParameterValue,
    PubSub,
    property,
} from "@spicy3d/core";
import { findSketch } from "../features/extrude";
import type { RevolveFeatureData } from "../features/feature";
import { resolveProfiles } from "../features/profileBuilder";
import { resolveRevolveAxis } from "../features/revolve";
import type { ParametricBodyNode } from "../parametricBodyNode";
import type { ExtrudePreview } from "./extrudeDragStep";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import {
    type RevolveAngleData,
    type RevolveAngleHandler,
    RevolveAngleStep,
    revolveHandleAnchor,
} from "./revolveAngleStep";

/**
 * Reopens a revolve in the angle-handle session that created it: the handle starts at the
 * stored angle, around the axis the feature resolves right now. Previews through
 * `FeatureChainPreview`; confirming replaces the angle as one undo step, Escape leaves the
 * model untouched. The profiles and the axis stay the feature's own.
 */
@command({ key: "feature.editRevolve", icon: "icon-revolve" })
export class RevolveEditCommand extends CancelableCommand {
    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    @property("common.angle", { unit: ANGLE_UNITS })
    get angle(): ParameterValue {
        return this.getPrivateValue("angle", 360);
    }
    set angle(value: ParameterValue) {
        this.setProperty("angle", value);
        if (this._syncingFromHandle) return;
        const resolved = this.resolveParameter(value, ANGLE_UNITS);
        if (resolved.isOk) this._handler?.setAngle(resolved.value);
    }

    private _handler: RevolveAngleHandler | undefined;
    private _syncingFromHandle = false;

    protected override async executeAsync(): Promise<void> {
        const body = this.body;
        if (body === undefined || this.featureId === undefined) return;
        const index = body.features.findIndex((x) => x.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== "revolve") return;

        // Published: the options tab is already open (`beforeExecute`) and must show it.
        this.setProperty("angle", feature.angle);
        const preview = new FeatureChainPreview(body, index);
        const data = this.angleData(body, feature, index, preview);
        if (data === undefined) {
            PubSub.default.pub("showToast", "toast.feature.editUnavailable");
            return;
        }

        this.controller = new AsyncController();
        const closeSession = openFeatureEditSession(body);
        let confirmed = false;
        try {
            const step = new RevolveAngleStep("prompt.dragToRevolve", () => data);
            confirmed = (await step.execute(this.document, this.controller)) !== undefined;
        } finally {
            showPreviewProblem(undefined);
            closeSession();
        }
        if (!confirmed) return;
        const resolved = this.resolveParameter(this.angle, ANGLE_UNITS);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        commitFeatureEdit(body, { ...feature, angle: this.angle });
    }

    /** The handle around the feature's live axis, on its first swept profile, in world space. */
    private angleData(
        body: ParametricBodyNode,
        feature: RevolveFeatureData,
        index: number,
        preview: FeatureChainPreview,
    ): RevolveAngleData | undefined {
        const sketch = findSketch(this.document, feature.sketchId);
        const profiles = sketch === undefined ? undefined : resolveProfiles(sketch, feature.profiles);
        if (!profiles?.isOk || profiles.value.length === 0) return undefined;
        const entering = body.timelineStateAt(index);
        const resolvedAxis = resolveRevolveAxis(feature, {
            document: this.document,
            host: body,
            input: entering?.shape,
            scope: this.document.variables.evaluate().scope,
            tracking: {
                inputFaceIds: entering?.faceIds ?? [],
                outputFaceIds: [],
                inputEdgeIds: entering?.edgeIds ?? [],
                outputEdgeIds: [],
            },
        });
        if (!resolvedAxis.isOk) return undefined;
        const local = resolvedAxis.value.axis;
        const anchor = revolveHandleAnchor(profiles.value[0].face, local);
        // The chain runs in the body's space; the handle is drawn in the world.
        const transform = body.worldTransform();
        const resolvedAngle = this.resolveParameter(this.angle, ANGLE_UNITS);
        return {
            axis: new Line({
                point: transform.ofPoint(local.point),
                direction: transform.ofVector(local.direction),
            }),
            anchor: transform.ofPoint(anchor),
            angle: resolvedAngle.isOk ? resolvedAngle.value : 0,
            editing: true,
            buildPreview: (angle, dragging) => this.buildPreview(body, feature, preview, angle, dragging),
            onReady: (handler) => {
                this._handler = handler;
            },
            onDone: () => {
                this._handler = undefined;
            },
            onAngle: (angle) => {
                this._syncingFromHandle = true;
                this.angle = angle;
                this._syncingFromHandle = false;
            },
        };
    }

    private buildPreview(
        body: ParametricBodyNode,
        feature: RevolveFeatureData,
        preview: FeatureChainPreview,
        angle: number,
        dragging: boolean,
    ): ExtrudePreview {
        // The handle's number, not the stored expression: this is what the user is dragging.
        const result = preview.evaluate({ ...feature, angle }, dragging);
        showPreviewProblem(result.error ?? result.warning);
        if (result.shape === undefined) return { meshes: [] };
        const meshes = previewMeshes(body, result.shape);
        return meshes === undefined ? { meshes: [] } : { meshes, hide: [body] };
    }
}

registerFeatureEditor("revolve", (body, featureId) => new RevolveEditCommand(body, featureId));
