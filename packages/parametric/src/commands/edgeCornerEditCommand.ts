// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    type INodeVisual,
    LENGTH_UNITS,
    type ParameterValue,
    PubSub,
    property,
    type ShapeType,
    ShapeTypes,
    type VisualShapeData,
    VisualStates,
} from "@spicy3d/core";
import type { EdgeRef } from "../features/edgeRef";
import type { ChamferFeatureData, FilletFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { edgeCornerArrowData } from "./edgeCornerCommand";
import { EdgeCornerPickHandler } from "./edgeCornerPickStep";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { captureBodyEdgeRef, selectFeatureEdges } from "./reselectSession";

type EdgeCornerFeature = FilletFeatureData | ChamferFeatureData;

/**
 * Reopens a fillet/chamfer in the session that created it: the body rolls back to just before
 * the feature (its edges only exist there), the feature's edges come preselected, and the value
 * arrow sits on the first of them — so the user can drag the value, add or drop edges, or both,
 * with the preview following through `FeatureChainPreview`. Confirming replaces the value and
 * the edges as one undo step; Escape leaves the model untouched.
 */
abstract class EdgeCornerEditCommand extends CancelableCommand {
    protected abstract readonly featureType: "fillet" | "chamfer";

    protected abstract get value(): ParameterValue;
    protected abstract set value(value: ParameterValue);

    private _handler: EdgeCornerPickHandler | undefined;
    private _session: EditSession | undefined;

    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    protected get valueNumber(): number | undefined {
        const resolved = this.resolveParameter(this.value, LENGTH_UNITS);
        return resolved.isOk ? resolved.value : undefined;
    }

    protected override async executeAsync(): Promise<void> {
        const body = this.body;
        if (body === undefined || this.featureId === undefined) return;
        const index = body.features.findIndex((x) => x.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== this.featureType) return;
        const edgeFeature = feature as EdgeCornerFeature;

        // No session yet, so this sets the value without previewing.
        this.value = edgeFeature.type === "fillet" ? edgeFeature.radius : edgeFeature.distance;
        // Before the rollback: the preview evaluates on the chain state entering the feature,
        // read from the full timeline.
        const preview = new FeatureChainPreview(body, index);
        this.controller = new AsyncController();
        const closeSession = openFeatureEditSession(body);
        const session = new EditSession(body, edgeFeature, index, preview);
        this._session = session;
        let edges: EdgeRef[] | undefined;
        try {
            session.open(this.updatePreview);
            edges = await this.pick(body);
        } finally {
            this._session = undefined;
            session.close(this.updatePreview);
            showPreviewProblem(undefined);
            closeSession();
        }
        if (edges === undefined) return;
        this.commit(body, edgeFeature, edges);
    }

    /** The edge pick with the value arrow; the confirmed edges, captured on the rolled-back body. */
    private async pick(body: ParametricBodyNode): Promise<EdgeRef[] | undefined> {
        const document = this.document;
        const controller = this.controller!;
        const handler = new EdgeCornerPickHandler(
            document,
            controller,
            { allow: (node) => node === body },
            {
                arrowData: () => edgeCornerArrowData(this.bodyEdges(body).at(0), this.valueNumber),
                setValue: (value) => {
                    this.value = value;
                },
                onSettled: () => this.updatePreview(),
            },
        );
        this._handler = handler;
        try {
            handler.refreshArrow(document.application.activeView);
            await document.picker.pickAsync(
                handler,
                "prompt.editEdgeCorner",
                controller,
                true,
                "select.default",
            );
            if (controller.result?.status !== "success") return undefined;
            const picked = this.bodyEdges(body);
            if (picked.length === 0) {
                PubSub.default.pub("showToast", "toast.select.noSelected");
                return undefined;
            }
            // While the rolled-back cache still describes the shape the edges were picked on.
            return picked.map((x) =>
                captureBodyEdgeRef(body, x, "an edited fillet/chamfer edge has no tracked id"),
            );
        } finally {
            this._handler = undefined;
            handler.dispose();
        }
    }

    /** The selected edges of the edited body. */
    private bodyEdges(body: ParametricBodyNode): VisualShapeData[] {
        return this.document.selection
            .getSelectedShapes()
            .filter((x) => x.owner.node === (body as unknown) && x.shape.shapeType === ShapeTypes.edge);
    }

    /** Re-previews the body with the current value and selection (on every change of either). */
    protected readonly updatePreview = () => {
        const session = this._session;
        const body = this.body;
        if (session === undefined || body === undefined) return;
        this._handler?.refreshArrow();
        const value = this.valueNumber;
        const edges = this.bodyEdges(body).map((x) => captureBodyEdgeRef(body, x));
        if (value === undefined || value <= 0 || edges.length === 0) {
            session.show(undefined);
            return;
        }
        session.show(this.edited(session.feature, value, edges), this._handler?.dragging === true);
    };

    private edited(feature: EdgeCornerFeature, value: ParameterValue, edges: EdgeRef[]): EdgeCornerFeature {
        return feature.type === "fillet"
            ? { ...feature, radius: value, edges }
            : { ...feature, distance: value, edges };
    }

    private commit(body: ParametricBodyNode, feature: EdgeCornerFeature, edges: EdgeRef[]) {
        // The same refusal the create command makes (see `EdgeCornerFeatureCommand`).
        const resolved = this.resolveParameter(this.value, LENGTH_UNITS);
        if (!resolved.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
            return;
        }
        commitFeatureEdit(body, this.edited(feature, this.value, edges));
    }
}

/**
 * The model side of one fillet/chamfer edit: the rollback, the ghosted body the edges are
 * picked on, and the preview mesh drawn over it.
 */
class EditSession {
    private _previewId: number | undefined;
    private _ghost: { owner: INodeVisual; shapeType: ShapeType } | undefined;

    constructor(
        private readonly body: ParametricBodyNode,
        readonly feature: EdgeCornerFeature,
        private readonly index: number,
        private readonly preview: FeatureChainPreview,
    ) {}

    open(onSelectionChanged: () => void) {
        const document = this.body.document;
        // A failed rollback replay keeps the full chain displayed; the pick then proceeds on
        // it, as the reselect session does.
        this.body.setRollbackIndex(this.index);
        const owner = document.visual.context.getVisual(this.body) as INodeVisual | undefined;
        const shape = this.body.shape;
        if (owner !== undefined && shape.isOk) {
            this._ghost = { owner, shapeType: shape.value.shapeType };
            document.visual.highlighter.addState(owner, VisualStates.faceTransparent, shape.value.shapeType);
        }
        selectFeatureEdges(this.body, this.feature.edges);
        document.selection.onShapeChanged.sub(onSelectionChanged);
        onSelectionChanged();
    }

    /** Shows the body with `feature` in place of the edited one; undefined shows nothing. */
    show(feature: EdgeCornerFeature | undefined, dragging = false) {
        this.clearPreview();
        if (feature !== undefined) {
            const result = this.preview.evaluate(feature, dragging);
            showPreviewProblem(result.error);
            const meshes = result.shape === undefined ? undefined : previewMeshes(this.body, result.shape);
            if (meshes !== undefined) {
                this._previewId = this.body.document.visual.context.displayMesh(meshes, { meshOpacity: 1 });
            }
        } else {
            showPreviewProblem(undefined);
        }
        this.body.document.visual.update();
    }

    close(onSelectionChanged: () => void) {
        const document = this.body.document;
        document.selection.onShapeChanged.remove(onSelectionChanged);
        this.clearPreview();
        if (this._ghost !== undefined) {
            document.visual.highlighter.removeState(
                this._ghost.owner,
                VisualStates.faceTransparent,
                this._ghost.shapeType,
            );
            this._ghost = undefined;
        }
        document.selection.clearSelection();
        this.body.setRollbackIndex(undefined);
        document.visual.update();
    }

    private clearPreview() {
        if (this._previewId === undefined) return;
        this.body.document.visual.context.removeMesh(this._previewId);
        this._previewId = undefined;
    }
}

@command({ key: "feature.editFillet", icon: "icon-fillet" })
export class FilletEditCommand extends EdgeCornerEditCommand {
    protected readonly featureType = "fillet" as const;

    @property("circle.radius", { unit: LENGTH_UNITS })
    get value(): ParameterValue {
        return this.getPrivateValue("value", 2);
    }
    set value(value: ParameterValue) {
        this.setProperty("value", value, () => this.updatePreview());
    }
}

@command({ key: "feature.editChamfer", icon: "icon-chamfer" })
export class ChamferEditCommand extends EdgeCornerEditCommand {
    protected readonly featureType = "chamfer" as const;

    @property("common.length", { unit: LENGTH_UNITS })
    get value(): ParameterValue {
        return this.getPrivateValue("value", 1);
    }
    set value(value: ParameterValue) {
        this.setProperty("value", value, () => this.updatePreview());
    }
}

registerFeatureEditor("fillet", (body, featureId) => new FilletEditCommand(body, featureId));
registerFeatureEditor("chamfer", (body, featureId) => new ChamferEditCommand(body, featureId));
