// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    BoundingBox,
    CancelableCommand,
    Combobox,
    command,
    type I18nKeys,
    type INode,
    LENGTH_UNITS,
    type ParameterValue,
    PubSub,
    property,
    type XYZ,
} from "@spicy3d/core";
import { findSketch } from "../features/extrude";
import type { ExtrudeFeatureData } from "../features/feature";
import { pressPullFaces } from "../features/pressPull";
import { resolveProfiles } from "../features/profileBuilder";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { planeOfFace } from "../sketch/planeRef";
import { EXTRUDE_OPERATIONS } from "./extrudeCommand";
import {
    createExtrudeArrowMesher,
    type ExtrudeDragData,
    type ExtrudeDragHandler,
    ExtrudeDragStep,
    type ExtrudePreview,
} from "./extrudeDragStep";
import {
    commitFeatureEdit,
    FeatureChainPreview,
    openFeatureEditSession,
    previewMeshes,
    showPreviewProblem,
} from "./featureEditPreview";
import { registerFeatureEditor } from "./featureEditRegistry";
import { type PreviewOverlay, toolOverlay } from "./toolOverlay";

/** Where the drag arrow sits: on the swept profile, along the extrude direction (world space). */
interface ExtrudeAxis {
    node: INode;
    origin: XYZ;
    normal: XYZ;
    anchor: XYZ;
}

/**
 * Reopens an extrude in the drag session that created it: the arrow starts at the stored
 * depth and the options tab holds the stored depth, start offset, direction and — for an
 * extrude that combines with earlier steps — its join/cut/intersect operation. Every change
 * previews through `FeatureChainPreview`; confirming replaces the feature as one undo step,
 * Escape leaves the model untouched. The profiles stay the feature's own (re-picking them is
 * "Reselect").
 */
@command({ key: "feature.editExtrude", icon: "icon-prism" })
export class ExtrudeEditCommand extends CancelableCommand {
    constructor(
        private readonly body?: ParametricBodyNode,
        private readonly featureId?: string,
    ) {
        super();
    }

    @property("option.command.operation", {
        combobox: Combobox.from([
            "option.command.operation.join",
            "option.command.operation.cut",
            "option.command.operation.intersect",
        ] satisfies I18nKeys[]),
        dependencies: [{ property: "combines", value: true }],
    })
    get operation(): I18nKeys {
        return this.getPrivateValue("operation", "option.command.operation.join");
    }
    set operation(value: I18nKeys) {
        this.setProperty("operation", value);
        this._dragHandler?.refresh();
    }

    /** True when the extrude combines with earlier steps — only then is its operation a choice. */
    get combines(): boolean {
        return this.getPrivateValue("combines", false);
    }

    @property("option.command.symmetric")
    get symmetric() {
        return this.getPrivateValue("symmetric", false);
    }
    set symmetric(value: boolean) {
        this.setProperty("symmetric", value);
        this._dragHandler?.refresh();
    }

    @property("option.command.startOffset", { unit: LENGTH_UNITS })
    get startOffset(): ParameterValue {
        return this.getPrivateValue("startOffset", 0);
    }
    set startOffset(value: ParameterValue) {
        this.setProperty("startOffset", value);
        const resolved = this.resolveLength(value);
        if (resolved !== undefined) this._dragHandler?.setStartOffset(resolved);
    }

    @property("option.command.depth", { unit: LENGTH_UNITS })
    get depth(): ParameterValue {
        return this.getPrivateValue("depth", 0);
    }
    set depth(value: ParameterValue) {
        this.setProperty("depth", value);
        if (this._syncingFromDrag) return;
        const resolved = this.resolveLength(value);
        if (resolved !== undefined) this._dragHandler?.setDepth(resolved);
    }

    private _dragHandler: ExtrudeDragHandler | undefined;
    private _syncingFromDrag = false;

    private resolveLength(value: ParameterValue): number | undefined {
        const resolved = this.resolveParameter(value, LENGTH_UNITS);
        return resolved.isOk ? resolved.value : undefined;
    }

    protected override async executeAsync(): Promise<void> {
        const body = this.body;
        if (body === undefined || this.featureId === undefined) return;
        const index = body.features.findIndex((x) => x.id === this.featureId);
        const feature = body.features[index];
        if (feature?.type !== "extrude") return;

        // After the command's cached options were read (`beforeExecute`): the stored values win.
        this.loadFeature(feature);
        const preview = new FeatureChainPreview(body, index);
        const axis = this.extrudeAxis(body, feature, index);
        if (axis === undefined) {
            PubSub.default.pub("showToast", "toast.feature.editUnavailable");
            return;
        }

        this.controller = new AsyncController();
        const closeSession = openFeatureEditSession(body);
        let confirmed = false;
        try {
            const data = this.dragData(body, feature, axis, preview);
            const step = new ExtrudeDragStep("prompt.dragToEditExtrude", () => data);
            confirmed = (await step.execute(this.document, this.controller)) !== undefined;
        } finally {
            showPreviewProblem(undefined);
            closeSession();
        }
        if (confirmed) this.commit(body, feature);
    }

    private loadFeature(feature: ExtrudeFeatureData) {
        this.setPrivateValue("combines", feature.operation !== undefined);
        const operation = Object.entries(EXTRUDE_OPERATIONS).find(([, op]) => op === feature.operation);
        if (operation !== undefined) this.setPrivateValue("operation", operation[0] as I18nKeys);
        this.setPrivateValue("symmetric", feature.symmetric === true);
        this.setPrivateValue("startOffset", feature.startOffset ?? 0);
        this.setPrivateValue("depth", feature.depth);
    }

    private dragData(
        body: ParametricBodyNode,
        feature: ExtrudeFeatureData,
        axis: ExtrudeAxis,
        preview: FeatureChainPreview,
    ): ExtrudeDragData {
        return {
            ...axis,
            faces: [],
            depth: this.resolveLength(this.depth) ?? 0,
            startOffset: this.resolveLength(this.startOffset) ?? 0,
            editing: true,
            meshArrow: createExtrudeArrowMesher(),
            buildPreview: (state) => this.buildPreview(body, feature, preview, state.dragging === true),
            onReady: (handler) => {
                this._dragHandler = handler;
            },
            onDone: () => {
                this._dragHandler = undefined;
            },
            onDist: (dist) => {
                this._syncingFromDrag = true;
                this.depth = dist;
                this._syncingFromDrag = false;
            },
        };
    }

    /**
     * The body with the edited extrude; the body itself is hidden while the preview stands in.
     * A cut or join draws its tool over it, styled as when the extrude was created.
     */
    private buildPreview(
        body: ParametricBodyNode,
        feature: ExtrudeFeatureData,
        preview: FeatureChainPreview,
        dragging: boolean,
    ): ExtrudePreview {
        const edited = this.editedFeature(feature);
        const result = preview.evaluate(edited, dragging);
        showPreviewProblem(result.error);
        if (result.shape === undefined) return { meshes: [] };
        const meshes = previewMeshes(body, result.shape);
        if (meshes === undefined) return { meshes: [] };
        const overlay = this.toolOverlayOf(body, edited, preview);
        return { meshes, hide: [body], ...(overlay === undefined ? {} : { overlays: [overlay] }) };
    }

    /** The edited extrude's tool — the feature without its operation, on the entering state. */
    private toolOverlayOf(
        body: ParametricBodyNode,
        edited: ExtrudeFeatureData,
        preview: FeatureChainPreview,
    ): PreviewOverlay | undefined {
        const { operation, ...prism } = edited;
        if (operation !== "cut" && operation !== "fuse") return undefined;
        const tool = preview.evaluateStep(prism);
        if (!tool.isOk) return undefined;
        const meshes = previewMeshes(body, tool.value);
        return meshes === undefined ? undefined : toolOverlay(operation, meshes[0], meshes[1]);
    }

    /** The feature with the session's values; unset options are left out as the create command does. */
    private editedFeature(feature: ExtrudeFeatureData): ExtrudeFeatureData {
        const { symmetric: _symmetric, startOffset: _startOffset, operation, ...rest } = feature;
        return {
            ...rest,
            depth: this.depth,
            ...(this.symmetric ? { symmetric: true } : {}),
            ...(this.startOffset !== 0 ? { startOffset: this.startOffset } : {}),
            ...(operation === undefined
                ? {}
                : { operation: EXTRUDE_OPERATIONS[this.operation] ?? operation }),
        };
    }

    private commit(body: ParametricBodyNode, feature: ExtrudeFeatureData) {
        // The same refusal the create command makes: an expression that no longer resolves
        // would fail the rebuild and take every later feature down with it.
        for (const value of [this.depth, this.startOffset]) {
            const resolved = this.resolveParameter(value, LENGTH_UNITS);
            if (!resolved.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
                return;
            }
        }
        commitFeatureEdit(body, this.editedFeature(feature));
    }

    /**
     * The arrow's axis. A sketch extrude sweeps along the sketch plane from its first swept
     * profile; a press-pull along the first matched source face's outward normal, matched on
     * the chain state entering the feature — the geometry it was picked from.
     */
    private extrudeAxis(
        body: ParametricBodyNode,
        feature: ExtrudeFeatureData,
        index: number,
    ): ExtrudeAxis | undefined {
        if (feature.source !== undefined) {
            return this.pressPullAxis(body, { ...feature, source: feature.source }, index);
        }
        const sketch =
            feature.sketchId === undefined ? undefined : findSketch(this.document, feature.sketchId);
        if (sketch === undefined) return undefined;
        const profiles = resolveProfiles(sketch, feature.profiles);
        if (!profiles.isOk || profiles.value.length === 0) return undefined;
        // The chain runs in the body's space; the arrow is drawn in the world.
        const transform = body.worldTransform();
        const anchor = BoundingBox.center(profiles.value[0].face.boundingBox());
        return {
            node: sketch,
            origin: transform.ofPoint(sketch.plane.origin),
            normal: transform.ofVector(sketch.plane.normal).normalize()!,
            anchor: transform.ofPoint(anchor),
        };
    }

    private pressPullAxis(
        body: ParametricBodyNode,
        feature: ExtrudeFeatureData & { source: NonNullable<ExtrudeFeatureData["source"]> },
        index: number,
    ): ExtrudeAxis | undefined {
        const entering = body.timelineStateAt(index);
        const faces = pressPullFaces(feature, {
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
        if (!faces.isOk || faces.value.faces.length === 0) return undefined;
        try {
            const face = faces.value.faces[0];
            const plane = planeOfFace(face);
            return {
                node: body,
                origin: plane.origin,
                normal: plane.normal,
                anchor: BoundingBox.center(face.boundingBox()),
            };
        } finally {
            faces.value.dispose();
        }
    }
}

registerFeatureEditor("extrude", (body, featureId) => new ExtrudeEditCommand(body, featureId));
