// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    BoundingBox,
    CancelableCommand,
    Combobox,
    command,
    I18n,
    type I18nKeys,
    type IFace,
    type INode,
    type IShape,
    LENGTH_UNITS,
    Matrix4,
    type ParameterValue,
    type Property,
    PubSub,
    property,
    type ShapeMeshData,
    Transaction,
    type VisualShapeData,
    type XYZ,
} from "@spicy3d/core";
import { findSketch } from "../features/extrude";
import { locateExtentFace } from "../features/extrudeExtent";
import { linkedExtrude, withLinkedExtrudeOverride } from "../features/extrudeTarget";
import type {
    BooleanOperation,
    ExtrudeExtent,
    ExtrudeFeatureData,
    ExtrudeTargetFeatureData,
} from "../features/feature";
import { pressPullFaces } from "../features/pressPull";
import { resolveProfiles } from "../features/profileBuilder";
import { ParametricBodyNode } from "../parametricBodyNode";
import { planeOfFace } from "../sketch/planeRef";
import { addExtrudeTarget, EXTRUDE_OPERATIONS, extrudeTargetsInfo } from "./extrudeCommand";
import {
    createExtrudeArrowMesher,
    type ExtrudeDragData,
    type ExtrudeDragHandler,
    ExtrudeDragStep,
    type ExtrudePreview,
} from "./extrudeDragStep";
import {
    EXTENT_DISTANCE,
    EXTENT_OPTIONS,
    EXTENT_THROUGH_ALL,
    EXTENT_TO_OBJECT,
    extentFaceOverlay,
    extentKeyOf,
    toObjectExtentOf,
    worldFaceOf,
} from "./extrudeExtentOptions";
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
 *
 * A sketch extrude that cuts or intersects also lists the other bodies it acts on (its
 * `extrudeTarget` entries, see `extrudeTarget.ts`): Ctrl/Cmd+click on a body adds or removes
 * it, previewed live, and confirming adds or removes the entries in the same undo step. The
 * host body always stays a target — the extrude lives in its feature list. A join acts on the
 * host alone here (the create command merges several bodies with a separate boolean).
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
        this.showTargets();
        this._dragHandler?.refresh();
    }

    /** True when the extrude combines with earlier steps — only then is its operation a choice. */
    get combines(): boolean {
        return this.getPrivateValue("combines", false);
    }

    /** What the extrude acts on, e.g. "Objects to cut: 2 bodies" (see the class comment). */
    @property("option.command.targets", {
        type: "info",
        dependencies: [{ property: "combines", value: true }],
    })
    get targetsInfo(): string {
        return this.getPrivateValue("targetsInfo", "");
    }

    /** The session's values are the feature's: none is carried over from another run. */
    protected override isPropertyCached(property: Property): boolean {
        return !["targetsInfo", "extent", "extentFaceInfo", "extentOffset"].includes(property.name);
    }

    /** Distance (dragged), up to a face ("To object", click another face to change it) or through all. */
    @property("option.command.extent", { combobox: Combobox.from(EXTENT_OPTIONS) })
    get extent(): I18nKeys {
        return this.getPrivateValue("extent", EXTENT_DISTANCE);
    }
    set extent(value: I18nKeys) {
        this.setProperty("extent", value);
        this.syncExtentFlags();
        this._dragHandler?.refresh();
    }

    /** True for a distance extent: only then are the depth and its arrow shown. */
    get isDistance(): boolean {
        return this.getPrivateValue("isDistance", true);
    }

    /** True for a to-object extent: its face and offset are shown. */
    get isToObject(): boolean {
        return this.getPrivateValue("isToObject", false);
    }

    /** What a to-object extent ends on: a prompt to click a face, or that one is set. */
    @property("option.command.extentFace", {
        type: "info",
        dependencies: [{ property: "isToObject", value: true }],
    })
    get extentFaceInfo(): string {
        return this.getPrivateValue("extentFaceInfo", "");
    }

    @property("option.command.extentOffset", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "isToObject", value: true }],
    })
    get extentOffset(): ParameterValue {
        return this.getPrivateValue("extentOffset", 0);
    }
    set extentOffset(value: ParameterValue) {
        this.setProperty("extentOffset", value);
        this._dragHandler?.refresh();
    }

    /** The to-object extent as stored (its face stays until another is clicked). */
    private _storedToObject: Extract<ExtrudeExtent, { type: "toObject" }> | undefined;
    /** A face clicked in this session for the to-object extent. */
    private _pickedExtentFace: VisualShapeData | undefined;

    private get hasExtentFace(): boolean {
        return this._pickedExtentFace !== undefined || this._storedToObject !== undefined;
    }

    private syncExtentFlags() {
        this.setProperty("isDistance", this.extent === EXTENT_DISTANCE);
        this.setProperty("isToObject", this.extent === EXTENT_TO_OBJECT);
        const key = this.hasExtentFace
            ? "option.command.extentFace.picked"
            : "option.command.extentFace.none";
        this.setProperty("extentFaceInfo", I18n.translate(key) ?? "");
    }

    /** The other target bodies as stored when the session opened (their entry ids by body). */
    private _storedTargets = new Map<ParametricBodyNode, string>();
    /** The other target bodies as the session has them now. */
    private _targets: ParametricBodyNode[] = [];
    /** Per stored target: the preview of its chain around its entry, built once. */
    private readonly _targetPreviews = new Map<ParametricBodyNode, FeatureChainPreview>();
    /** False for a press-pull or a new-body extrude: those act on their host only. */
    private _multiTarget = false;

    @property("option.command.symmetric", { dependencies: [{ property: "isToObject", value: false }] })
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

    @property("option.command.depth", {
        unit: LENGTH_UNITS,
        dependencies: [{ property: "isDistance", value: true }],
    })
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
        this.loadTargets(body, feature);
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

    /** The bodies holding an entry of this extrude — its other targets as stored. */
    private loadTargets(body: ParametricBodyNode, feature: ExtrudeFeatureData) {
        this._storedTargets = new Map();
        for (const node of this.document.modelManager.findNodes((n) => n instanceof ParametricBodyNode)) {
            const other = node as ParametricBodyNode;
            if (other === body) continue;
            const link = other.features.find(
                (x): x is ExtrudeTargetFeatureData =>
                    x.type === "extrudeTarget" && x.bodyId === body.id && x.featureId === feature.id,
            );
            if (link !== undefined) this._storedTargets.set(other, link.id);
        }
        this._targets = [...this._storedTargets.keys()];
        this._multiTarget = feature.source === undefined && feature.operation !== undefined;
        this.showTargets();
    }

    /** The operation being edited, when it can act on other bodies (cut / intersect). */
    private get targetOperation(): Extract<BooleanOperation, "cut" | "common"> | undefined {
        if (!this._multiTarget) return undefined;
        const operation = EXTRUDE_OPERATIONS[this.operation];
        return operation === "cut" || operation === "common" ? operation : undefined;
    }

    /** The other targets the session confirms: none unless the operation can have them. */
    private get effectiveTargets(): ParametricBodyNode[] {
        return this.targetOperation === undefined ? [] : this._targets;
    }

    private showTargets() {
        const operation = EXTRUDE_OPERATIONS[this.operation];
        const info =
            this.combines && operation !== undefined
                ? extrudeTargetsInfo(operation, 1 + this.effectiveTargets.length)
                : "";
        this.setProperty("targetsInfo", info);
    }

    /** Ctrl/Cmd+click on a body: adds or removes it as a target; the host always stays. */
    private toggleTarget(node: INode, body: ParametricBodyNode): boolean {
        if (this.targetOperation === undefined) return false;
        if (!(node instanceof ParametricBodyNode) || node === body || !node.shape.isOk) return false;
        const index = this._targets.indexOf(node);
        if (index >= 0) this._targets.splice(index, 1);
        else this._targets.push(node);
        this.showTargets();
        return true;
    }

    private loadFeature(feature: ExtrudeFeatureData) {
        this.setPrivateValue("combines", feature.operation !== undefined);
        const operation = Object.entries(EXTRUDE_OPERATIONS).find(([, op]) => op === feature.operation);
        if (operation !== undefined) this.setPrivateValue("operation", operation[0] as I18nKeys);
        this.setPrivateValue("symmetric", feature.symmetric === true);
        this.setPrivateValue("startOffset", feature.startOffset ?? 0);
        this.setPrivateValue("depth", feature.depth);
        this.setPrivateValue("extent", extentKeyOf(feature.extent));
        this._storedToObject = feature.extent?.type === "toObject" ? feature.extent : undefined;
        this._pickedExtentFace = undefined;
        this.setPrivateValue("extentOffset", this._storedToObject?.offset ?? 0);
        this.syncExtentFlags();
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
            toggleTarget: (node) => this.toggleTarget(node, body),
            depthLocked: () => this.extent !== EXTENT_DISTANCE,
            extentReady: () => this.extent !== EXTENT_TO_OBJECT || this.hasExtentFace,
            picksExtentFace: () => this.extent === EXTENT_TO_OBJECT,
            pickExtentFace: (face) => {
                this._pickedExtentFace = face;
                this.syncExtentFlags();
                return true;
            },
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
        if (this.extent === EXTENT_TO_OBJECT && !this.hasExtentFace) {
            showPreviewProblem(I18n.translate("option.command.extentFace.none"));
            return { meshes: [] };
        }
        const result = preview.evaluate(edited, dragging);
        showPreviewProblem(result.error);
        if (result.shape === undefined) return { meshes: [] };
        const meshes = previewMeshes(body, result.shape);
        if (meshes === undefined) return { meshes: [] };
        const overlays = [
            this.toolOverlayOf(body, edited, preview),
            this.extentFaceOverlayOf(edited, preview),
        ].filter((x): x is PreviewOverlay => x !== undefined);
        const others = this.targetsPreview(body, edited, preview, dragging);
        return {
            meshes: [...meshes, ...others.meshes],
            hide: [body, ...others.hide],
            ...(overlays.length === 0 ? {} : { overlays }),
        };
    }

    /** The face the edited to-object extent ends on, highlighted: the clicked one, else the stored one. */
    private extentFaceOverlayOf(
        edited: ExtrudeFeatureData,
        preview: FeatureChainPreview,
    ): PreviewOverlay | undefined {
        if (edited.extent?.type !== "toObject") return undefined;
        const owned: IFace[] = [];
        try {
            if (this._pickedExtentFace !== undefined) {
                return extentFaceOverlay(worldFaceOf(this._pickedExtentFace, owned));
            }
            const entering = preview.enteringContext();
            if (entering === undefined) return undefined;
            const located = locateExtentFace(edited, edited.extent, entering);
            if (!located.isOk) return undefined;
            owned.push(located.value);
            return extentFaceOverlay(located.value);
        } finally {
            owned.forEach((x) => x.dispose());
        }
    }

    /**
     * The other bodies as the session would leave them: a stored target replays its chain with
     * the edited extrude (or, removed, without it); an added one gets the edited tool applied
     * to its current shape, where its new entry will go (the end of its list).
     */
    private targetsPreview(
        body: ParametricBodyNode,
        edited: ExtrudeFeatureData,
        preview: FeatureChainPreview,
        dragging: boolean,
    ): { meshes: ShapeMeshData[]; hide: INode[] } {
        const effective = this.effectiveTargets;
        const result = { meshes: [] as ShapeMeshData[], hide: [] as INode[] };
        const show = (other: ParametricBodyNode, shape: IShape | undefined) => {
            const meshes = shape === undefined ? undefined : previewMeshes(other, shape);
            if (meshes === undefined) return;
            result.meshes.push(...meshes);
            result.hide.push(other);
        };
        for (const [other, linkId] of this._storedTargets) {
            const kept = effective.includes(other);
            show(other, this.storedTargetPreview(other, linkId, kept ? edited : null, dragging));
        }
        const added = effective.filter((x) => !this._storedTargets.has(x));
        const operation = this.targetOperation;
        if (added.length === 0 || operation === undefined) return result;
        const { operation: _operation, ...prism } = edited;
        const tool = preview.evaluateStep(prism);
        if (!tool.isOk) return result;
        try {
            for (const other of added)
                show(other, this.addedTargetPreview(body, other, operation, tool.value));
        } finally {
            tool.value.dispose();
        }
        return result;
    }

    /** A stored target's chain with its entry replaying `edited` (`null`: no effect). */
    private storedTargetPreview(
        other: ParametricBodyNode,
        linkId: string,
        edited: ExtrudeFeatureData | null,
        dragging: boolean,
    ): IShape | undefined {
        const index = other.features.findIndex((x) => x.id === linkId);
        if (index < 0) return undefined;
        let chain = this._targetPreviews.get(other);
        if (chain === undefined) {
            chain = new FeatureChainPreview(other, index);
            this._targetPreviews.set(other, chain);
        }
        const link = other.features[index] as ExtrudeTargetFeatureData;
        const evaluated = withLinkedExtrudeOverride(link.featureId, edited, () =>
            chain.evaluate(link, dragging),
        );
        return evaluated.shape;
    }

    /** `tool` (host-local) applied to an added target's current shape, in its local space. */
    private addedTargetPreview(
        body: ParametricBodyNode,
        other: ParametricBodyNode,
        operation: BooleanOperation,
        tool: IShape,
    ): IShape | undefined {
        if (!other.shape.isOk) return undefined;
        const invert = other.worldTransform().invert();
        const matrix = invert === undefined ? undefined : invert.multiply(body.worldTransform());
        const placed =
            matrix === undefined || matrix.equals(Matrix4.identity()) ? tool : tool.transformedMul(matrix);
        try {
            const result =
                operation === "cut"
                    ? shapeFactory.booleanCut([other.shape.value], [placed])
                    : shapeFactory.booleanCommon([other.shape.value], [placed]);
            return result.isOk ? result.value : undefined;
        } finally {
            if (placed !== tool) placed.dispose();
        }
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
        const {
            symmetric: _symmetric,
            startOffset: _startOffset,
            operation,
            extent: _extent,
            secondExtent,
            ...rest
        } = feature;
        const extent = this.editedExtent();
        // A to-object extent is never mirrored: symmetric only with its own second side.
        const symmetric = this.symmetric && (extent?.type !== "toObject" || secondExtent !== undefined);
        return {
            ...rest,
            depth: this.depth,
            ...(symmetric ? { symmetric: true } : {}),
            ...(this.startOffset !== 0 ? { startOffset: this.startOffset } : {}),
            ...(extent === undefined ? {} : { extent }),
            ...(symmetric && secondExtent !== undefined ? { secondExtent } : {}),
            ...(operation === undefined
                ? {}
                : { operation: EXTRUDE_OPERATIONS[this.operation] ?? operation }),
        };
    }

    /** The session's first extent: none for a distance, the clicked (else stored) face for "To object". */
    private editedExtent(): ExtrudeExtent | undefined {
        switch (this.extent) {
            case EXTENT_THROUGH_ALL:
                return { type: "throughAll" };
            case EXTENT_TO_OBJECT: {
                if (this._pickedExtentFace !== undefined) {
                    return toObjectExtentOf(this._pickedExtentFace, this.extentOffset);
                }
                if (this._storedToObject === undefined) return undefined;
                const { offset: _offset, ...stored } = this._storedToObject;
                return { ...stored, ...(this.extentOffset !== 0 ? { offset: this.extentOffset } : {}) };
            }
            default:
                return undefined;
        }
    }

    private commit(body: ParametricBodyNode, feature: ExtrudeFeatureData) {
        if (this.extent === EXTENT_TO_OBJECT && !this.hasExtentFace) {
            PubSub.default.pub(
                "showToast",
                "error.default:{0}",
                I18n.translate("option.command.extentFace.none"),
            );
            return;
        }
        // The same refusal the create command makes: an expression that no longer resolves
        // would fail the rebuild and take every later feature down with it.
        for (const value of [this.depth, this.startOffset, this.extentOffset]) {
            const resolved = this.resolveParameter(value, LENGTH_UNITS);
            if (!resolved.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
                return;
            }
        }
        const effective = this.effectiveTargets;
        const removed = [...this._storedTargets].filter(([other]) => !effective.includes(other));
        const added = effective.filter((x) => !this._storedTargets.has(x));
        if (removed.length === 0 && added.length === 0) {
            commitFeatureEdit(body, this.editedFeature(feature));
            return;
        }
        // One undo step for the extrude and its targets. The host first: the entries read it.
        Transaction.execute(this.document, "edit feature", () => {
            const edited = this.editedFeature(feature);
            body.setFeaturesEmitShapeChanged(body.features.map((x) => (x.id === edited.id ? edited : x)));
            for (const [other, linkId] of removed) {
                other.setFeaturesEmitShapeChanged(other.features.filter((x) => x.id !== linkId));
            }
            for (const other of added) addExtrudeTarget(other, body, feature.id);
            this.document.visual.update();
        });
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

// Editing an extrude's entry in another target body edits the extrude itself, in its host.
registerFeatureEditor("extrudeTarget", (body, featureId) => {
    const entry = body.features.find((x) => x.id === featureId);
    const linked = entry?.type === "extrudeTarget" ? linkedExtrude(body.document, entry) : undefined;
    const host = linked?.host instanceof ParametricBodyNode ? linked.host : undefined;
    return new ExtrudeEditCommand(host, linked?.feature.id);
});
