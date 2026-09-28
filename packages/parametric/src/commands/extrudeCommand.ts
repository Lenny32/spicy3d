// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    BoundingBox,
    Combobox,
    command,
    I18n,
    type I18nKeys,
    type IDocument,
    Id,
    type IFace,
    type INode,
    type INodeVisual,
    type IShape,
    type IStep,
    type IView,
    LENGTH_UNITS,
    Matrix4,
    MultistepCommand,
    type ParameterValue,
    Precision,
    type Property,
    PubSub,
    property,
    Result,
    ShapeTypes,
    ShapeTypeUtils,
    type SnapResult,
    Transaction,
    type VisualShapeData,
    type XYZ,
} from "@spicy3d/core";
import {
    type ExtentEnd,
    extentSides,
    type SweepSide,
    sweepSide,
    THROUGH_ALL_NO_BODY_ERROR,
} from "../features/extrudeExtent";
import type { BooleanOperation, ExtrudeFeatureData, ExtrudeTargetFeatureData } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { allProfiles, sketchProfiles } from "../features/profileBuilder";
import { captureProfileRef } from "../features/profileRef";
import { fuseProfiles } from "../features/sweepGeometry";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { autoOperation, defaultTargets, findExtrudeTargets, primaryTarget } from "./extrudeContact";
import {
    createExtrudeArrowMesher,
    type ExtrudeDragHandler,
    type ExtrudeDragState,
    ExtrudeDragStep,
    type ExtrudePreview,
    planeOfPickedFace,
    SELECTED_PROFILE_STATE,
} from "./extrudeDragStep";
import {
    EXTENT_DISTANCE,
    EXTENT_OPTIONS,
    EXTENT_THROUGH_ALL,
    EXTENT_TO_OBJECT,
    extentFaceOverlay,
    toObjectExtentOf,
    worldFaceOf,
} from "./extrudeExtentOptions";
import { showPreviewProblem } from "./featureEditPreview";
import { prioritizeSketchFaces } from "./profileFaceSort";
import { toolOverlay } from "./toolOverlay";

/** Options every extrude starts afresh with (see `isPropertyCached`). */
const UNCACHED_PROPERTIES = new Set(["operation", "targetsInfo", "extent", "extentFaceInfo", "extentOffset"]);

const OPERATION_NEW: I18nKeys = "option.command.operation.new";

/** The Auto operation: join/cut/new resolved from how the extrusion meets the bodies. */
export const OPERATION_AUTO: I18nKeys = "option.command.operation.auto";

/** What the Auto item reads once resolved ("Auto (Cut)"); keyed by the resolved operation. */
const AUTO_LABELS: Record<"cut" | "fuse" | "new", I18nKeys> = {
    cut: "option.command.operation.auto.cut",
    fuse: "option.command.operation.auto.join",
    new: "option.command.operation.auto.new",
};

/**
 * The operation an extrude resolved to, and the bodies it acts on — the first one hosts the
 * extrude; none for a new body.
 */
interface ResolvedOperation {
    readonly operation?: BooleanOperation;
    readonly targets: readonly ParametricBodyNode[];
}

const TARGET_LABELS: Record<BooleanOperation, I18nKeys> = {
    cut: "option.command.targets.cut{0}",
    fuse: "option.command.targets.join{0}",
    common: "option.command.targets.intersect{0}",
};

/** The options tab's line naming what an extrude acts on ("Objects to cut: 2 bodies"). */
export function extrudeTargetsInfo(operation: BooleanOperation, count: number): string {
    const bodies =
        count === 1
            ? I18n.translate("option.command.targets.one")
            : I18n.translate("option.command.targets.many{0}", count);
    return I18n.translate(TARGET_LABELS[operation], bodies) ?? "";
}

/**
 * Commits an extrude acting on `targets` (the first hosts it; see `extrudeTarget.ts`):
 * - cut / intersect: the extrude goes into the host's feature list, and every other target
 *   gets an `extrudeTarget` entry appended, replaying the extrude there;
 * - join: the extrude joins the host, and the other bodies are merged into it by a boolean
 *   fuse right after (Fusion's participating bodies end up one body), consumed as tools.
 * Call inside a transaction.
 */
export function applyExtrudeToTargets(
    feature: ExtrudeFeatureData & { operation: BooleanOperation },
    targets: readonly ParametricBodyNode[],
): void {
    const [host, ...others] = targets;
    if (feature.operation === "fuse") {
        const merge =
            others.length === 0
                ? []
                : [
                      {
                          id: Id.generate(),
                          type: "boolean" as const,
                          operation: "fuse" as const,
                          toolIds: others.map((x) => x.id),
                      },
                  ];
        host.setFeaturesEmitShapeChanged([...host.features, feature, ...merge]);
        return;
    }
    host.setFeaturesEmitShapeChanged([...host.features, feature]);
    for (const other of others) addExtrudeTarget(other, host, feature.id);
}

/** Appends to `body` the entry applying extrude `featureId` of `host` (see `extrudeTarget.ts`). */
export function addExtrudeTarget(
    body: ParametricBodyNode,
    host: ParametricBodyNode,
    featureId: string,
): void {
    const link: ExtrudeTargetFeatureData = {
        id: Id.generate(),
        type: "extrudeTarget",
        bodyId: host.id,
        featureId,
    };
    body.setFeaturesEmitShapeChanged([...body.features, link]);
}

/** Maps the command's operation dropdown values to boolean operations; new has none. */
export const EXTRUDE_OPERATIONS: Record<string, BooleanOperation> = {
    "option.command.operation.join": "fuse",
    "option.command.operation.cut": "cut",
    "option.command.operation.intersect": "common",
};

/**
 * Resolves the profiles to extrude in one step:
 * 1. profile faces are already selected → use them (sketch profile faces or planar
 *    faces of a parametric body; faces of other nodes than the first one's are ignored);
 * 2. a sketch node is selected → all of its outer profiles, resolved to face picks as
 *    if the user had selected them (whole sketch when the sketch has no profiles);
 * 3. otherwise the user picks a face. The filter only allows sketch nodes and
 *    parametric bodies, and only planar faces. Confirming with nothing selected
 *    (Enter/Escape) cancels the command.
 *
 * `allowNode` overrides which nodes profiles can come from (revolve: sketches only).
 */
export class SelectSketchProfilesStep implements IStep {
    constructor(
        private readonly allowNode: (node: INode) => boolean = (node) =>
            node instanceof SketchNode || node instanceof ParametricBodyNode,
    ) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const view = document.application.activeView!;
        return (
            this.fromSelectedFaces(document, view, controller) ??
            this.fromSelectedSketch(document, view, controller) ??
            (await this.pickFace(document, view, controller))
        );
    }

    /**
     * Pre-selected profile faces — sketch profile faces or planar faces of a parametric
     * body; faces of other nodes than the first one's are ignored. Undefined when none.
     */
    private fromSelectedFaces(
        document: IDocument,
        view: IView,
        controller: AsyncController,
    ): SnapResult | undefined {
        const selectedFaces = document.selection
            .getSelectedShapes()
            .filter(
                (x) =>
                    ShapeTypeUtils.hasFace(x.shape.shapeType) &&
                    this.allowNode(x.owner.node) &&
                    (!(x.owner.node instanceof ParametricBodyNode) ||
                        (x.shape as IFace).surface().isPlanar()),
            );
        if (selectedFaces.length === 0) return undefined;
        const node = selectedFaces[0].owner.node;
        controller.success();
        return {
            view,
            shapes: selectedFaces.filter((x) => x.owner.node === node),
            nodes: [node],
            type: "shape",
        };
    }

    /** A pre-selected sketch contributes all its outer profiles (empty: whole sketch). */
    private fromSelectedSketch(
        document: IDocument,
        view: IView,
        controller: AsyncController,
    ): SnapResult | undefined {
        const selectedSketch = document.selection
            .getSelectedNodes()
            .find((x): x is SketchNode => x instanceof SketchNode && this.allowNode(x));
        if (selectedSketch === undefined) return undefined;
        const faces = SelectSketchProfilesStep.sketchProfileFaces(document, selectedSketch);
        controller.success();
        // Show the profiles as selected, exactly as if the user had picked them.
        if (faces.length > 0) {
            document.selection.setSelectedShapes(faces, SELECTED_PROFILE_STATE, false);
        }
        return { view, shapes: faces, nodes: [selectedSketch], type: "shape" };
    }

    /**
     * Interactive pick: planar faces of allowed nodes only, sketches before solid faces. A
     * plain click picks one face and goes on; Ctrl/Cmd+click gathers several (toggling), and
     * Enter goes on with them. Faces of other nodes than the first one's are ignored.
     */
    private async pickFace(
        document: IDocument,
        view: IView,
        controller: AsyncController,
    ): Promise<SnapResult | undefined> {
        const shapes = await document.picker.pickShape("prompt.select.faces", controller, {
            shapeType: ShapeTypes.face,
            shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
            multi: false,
            toggleWithModifier: true,
            nodeFilter: { allow: this.allowNode },
            selectedState: SELECTED_PROFILE_STATE,
            sortDetected: prioritizeSketchFaces,
        });
        if (shapes.length === 0) return undefined;
        const node = shapes[0].owner.node;
        return { view, shapes: shapes.filter((x) => x.owner.node === node), nodes: [node], type: "shape" };
    }

    /**
     * Synthesizes the pick data of every outer profile of `sketch`, so a pre-selected
     * sketch enters the drag step with all profiles selected as if picked manually.
     * The displayed mesh adds the base shape first (an edge compound without faces) and
     * then the profiles in `allProfiles` order — outer first — so the leading face
     * ranges are the outer profiles and each range position is the detection index
     * (the same index a viewport pick would report).
     */
    private static sketchProfileFaces(document: IDocument, sketch: SketchNode): VisualShapeData[] {
        const profiles = sketchProfiles(sketch);
        if (!profiles.isOk || profiles.value.outer.length === 0) return [];
        const owner = document.visual.context.getVisual(sketch) as INodeVisual | undefined;
        const ranges = sketch.mesh.faces?.range ?? [];
        if (owner === undefined || ranges.length < allProfiles(profiles.value).length) return [];

        const nodeTransform = owner.worldTransform();
        const faces: VisualShapeData[] = [];
        for (let i = 0; i < profiles.value.outer.length; i++) {
            const range = ranges[i];
            if (range.shape.shapeType !== ShapeTypes.face) return [];
            faces.push({
                shape: range.shape,
                owner,
                transform:
                    range.transform === undefined ? nodeTransform : nodeTransform.multiply(range.transform),
                point: BoundingBox.center(range.shape.boundingBox()),
                indexes: [i],
            });
        }
        return faces;
    }
}

@command({ key: "feature.extrude", icon: "icon-prism" })
export class ExtrudeFeatureCommand extends MultistepCommand {
    /**
     * Auto (the default of every new extrude) resolves live while dragging — see
     * `resolveOperation`; any other choice overrides it, and choosing Auto again re-detects.
     */
    @property("option.command.operation", {
        combobox: Combobox.from([
            OPERATION_AUTO,
            OPERATION_NEW,
            "option.command.operation.join",
            "option.command.operation.cut",
            "option.command.operation.intersect",
        ] satisfies I18nKeys[]).withLiveLabel(OPERATION_AUTO, "autoOperationLabel"),
    })
    get operation(): I18nKeys {
        return this.getPrivateValue("operation", OPERATION_AUTO);
    }
    set operation(value: I18nKeys) {
        this.setProperty("operation", value);
        this._dragHandler?.refresh();
    }

    /** The Auto item's label in the options tab: "Auto" until resolved, then e.g. "Auto (Cut)". */
    get autoOperationLabel(): I18nKeys {
        return this.getPrivateValue("autoOperationLabel", OPERATION_AUTO);
    }

    /**
     * What the extrude acts on, e.g. "Objects to cut: 2 bodies" — by default every body it
     * goes into (a join: touches); Ctrl/Cmd+click on a body during the drag adds or removes it.
     */
    @property("option.command.targets", {
        type: "info",
        dependencies: [{ property: "hasTargets", value: true }],
    })
    get targetsInfo(): string {
        return this.getPrivateValue("targetsInfo", "");
    }

    /** True while the extrude acts on at least one body (the targets line shows only then). */
    get hasTargets(): boolean {
        return this.getPrivateValue("hasTargets", false);
    }

    /** Bodies Ctrl+clicked in beyond the default targets, and default ones Ctrl+clicked out, by id. */
    private readonly _includedTargets = new Set<string>();
    private readonly _excludedTargets = new Set<string>();
    /** The targets of the last resolution — what a Ctrl+click toggles against. */
    private _lastTargets: readonly ParametricBodyNode[] = [];

    /**
     * Every extrude starts in Auto with its default targets and a distance extent: an explicit
     * choice is for this extrude only (a picked face means nothing to the next one).
     */
    protected override isPropertyCached(property: Property): boolean {
        return !UNCACHED_PROPERTIES.has(property.name);
    }

    /** Distance (dragged), up to a face ("To object", picked by a click) or through all. */
    @property("option.command.extent", { combobox: Combobox.from(EXTENT_OPTIONS) })
    get extent(): I18nKeys {
        return this.getPrivateValue("extent", EXTENT_DISTANCE);
    }
    set extent(value: I18nKeys) {
        this.setProperty("extent", value);
        this.setProperty("isDistance", value === EXTENT_DISTANCE);
        this.setProperty("isToObject", value === EXTENT_TO_OBJECT);
        this.showExtentFace();
        this._dragHandler?.refresh();
    }

    /** True for a distance extent: only then are the depth and its arrow shown. */
    get isDistance(): boolean {
        return this.getPrivateValue("isDistance", true);
    }

    /** True for a to-object extent: its face and offset are shown, symmetric is not. */
    get isToObject(): boolean {
        return this.getPrivateValue("isToObject", false);
    }

    /** What a to-object extent ends on: a prompt to click a face, or that one was picked. */
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

    /** The face a to-object extent ends on, as clicked during the drag step. */
    private _extentFace: VisualShapeData | undefined;

    private showExtentFace() {
        const key =
            this._extentFace === undefined
                ? "option.command.extentFace.none"
                : "option.command.extentFace.picked";
        this.setProperty("extentFaceInfo", I18n.translate(key) ?? "");
    }

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
        // Without a live drag there is nothing to preview, and nothing to resolve against.
        if (!this._dragHandler) return;
        const resolved = this.resolveLength(value);
        if (resolved !== undefined) this._dragHandler.setStartOffset(resolved);
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
        if (!this._dragHandler || this._syncingFromDrag) return;
        const resolved = this.resolveLength(value);
        if (resolved !== undefined) this._dragHandler.setDepth(resolved);
    }

    /** A length field's numeric value, or undefined when its expression does not resolve. */
    private resolveLength(value: ParameterValue): number | undefined {
        const resolved = this.resolveParameter(value, LENGTH_UNITS);
        return resolved.isOk ? resolved.value : undefined;
    }

    /** The drag's own preview geometry: an unresolvable expression previews as zero. */
    private get depthValue(): number {
        return this.resolveLength(this.depth) ?? 0;
    }

    private get startOffsetValue(): number {
        return this.resolveLength(this.startOffset) ?? 0;
    }

    private _dragHandler: ExtrudeDragHandler | undefined;
    private _syncingFromDrag = false;

    /** The drag step returns the final face set (it can change while dragging). */
    private get dragData() {
        return this.stepDatas[1];
    }

    private get sourceNode(): SketchNode | ParametricBodyNode {
        return this.dragData.nodes![0] as unknown as SketchNode | ParametricBodyNode;
    }

    /** Empty when the whole sketch is extruded. */
    private get pickedFaces(): IFace[] {
        return (this.dragData?.shapes ?? []).map((x) => x.shape as unknown as IFace);
    }

    protected override getSteps(): IStep[] {
        return [
            new SelectSketchProfilesStep(),
            new ExtrudeDragStep("prompt.dragToExtrude", this.getDragData),
        ];
    }

    private readonly getDragData = () => {
        const node = this.stepDatas[0].nodes![0] as unknown as SketchNode | ParametricBodyNode;
        const faces = this.stepDatas[0].shapes;
        // A body face extrudes along its own outward plane; a whole/partial sketch
        // along the sketch plane.
        const plane = node instanceof SketchNode ? node.plane : planeOfPickedFace(faces[0]);
        return {
            node,
            faces,
            origin: plane.origin,
            normal: plane.normal,
            anchor: faces[0]?.point ?? plane.origin,
            depth: this.depthValue,
            startOffset: this.startOffsetValue,
            buildPreview: this.buildPreview,
            meshArrow: this.meshArrow,
            toggleTarget: this.toggleTarget,
            depthLocked: () => this.extent !== EXTENT_DISTANCE,
            extentReady: () => this.extent !== EXTENT_TO_OBJECT || this._extentFace !== undefined,
            picksExtentFace: () => this.extent === EXTENT_TO_OBJECT,
            pickExtentFace: (face: VisualShapeData) => {
                this._extentFace = face;
                this.showExtentFace();
                return true;
            },
            onReady: (handler: ExtrudeDragHandler) => {
                this._dragHandler = handler;
            },
            onDone: () => {
                this._dragHandler = undefined;
            },
            onDist: (dist: number) => {
                this._syncingFromDrag = true;
                this.depth = dist;
                this._syncingFromDrag = false;
            },
        };
    };

    /**
     * Meshes the extruded prism as solid faces plus outline edges, previewing the final
     * body. Multiple profiles go through the same `fuseProfiles` merge as the feature
     * (touching prisms become one solid), so the preview matches the committed result.
     * Symmetric extrusion previews both directions. A join/cut/intersect — explicit or
     * resolved by Auto — previews the boolean result against the target body, standing in
     * for that body's display for the duration of the drag, with the tool drawn over it
     * (a cut's removed volume in translucent red, see `toolOverlay`).
     */
    private readonly buildPreview = (state: ExtrudeDragState): ExtrudePreview => {
        const locked = this.extent !== EXTENT_DISTANCE;
        if (!locked && Math.abs(state.dist) < Precision.Float) return { meshes: [] };
        if (this.extent === EXTENT_TO_OBJECT && this._extentFace === undefined) return { meshes: [] };
        const owned: IFace[] = [];
        const node = state.node as SketchNode | ParametricBodyNode;
        try {
            const faces = ExtrudeFeatureCommand.previewFaces(state, owned);
            if (faces === undefined) return { meshes: [] };
            const tool = this.buildTool(node, faces, state.normal, state.dist);
            if (!tool.isOk) {
                // A face the profile cannot reach, nothing to go through: say so, show nothing.
                if (locked) {
                    showPreviewProblem(tool.error);
                    return { meshes: [] };
                }
                throw tool.error;
            }
            if (locked) showPreviewProblem(undefined);
            try {
                const preview = this.operationPreview(
                    node.document,
                    tool.value,
                    !(node instanceof SketchNode),
                    (host) => this.buildTool(node, faces, state.normal, state.dist, host),
                );
                return this.withExtentFace(preview);
            } finally {
                tool.value.dispose();
            }
        } finally {
            owned.forEach((x) => x.dispose());
        }
    };

    /** `preview` with the picked to-object face highlighted over it. */
    private withExtentFace(preview: ExtrudePreview): ExtrudePreview {
        if (this.extent !== EXTENT_TO_OBJECT || this._extentFace === undefined) return preview;
        const owned: IFace[] = [];
        try {
            const overlay = extentFaceOverlay(worldFaceOf(this._extentFace, owned));
            return overlay === undefined
                ? preview
                : { ...preview, overlays: [...(preview.overlays ?? []), overlay] };
        } finally {
            owned.forEach((x) => x.dispose());
        }
    }

    /**
     * The preview of `tool` (not disposed here): the boolean result on every resolved target
     * body, each standing in for its body, plus the tool overlay; the tool alone for a new
     * body or when every boolean fails. A join previews the merged body. A through-all join
     * rebuilds its tool flush with the host (`retool`), as the feature will.
     */
    private operationPreview(
        document: IDocument,
        tool: IShape,
        pressPull: boolean,
        retool?: (host: ParametricBodyNode) => Result<IShape>,
    ): ExtrudePreview {
        const { operation, targets } = this.resolveOperation(document, tool, pressPull);
        if (operation === undefined || targets.length === 0) return ExtrudeFeatureCommand.meshesOf(tool.mesh);
        const flush =
            operation === "fuse" && this.extent === EXTENT_THROUGH_ALL ? retool?.(targets[0]) : undefined;
        const used = flush?.isOk ? flush.value : tool;
        try {
            const results = this.targetPreviews(operation, targets, used);
            if (results.length === 0) return ExtrudeFeatureCommand.meshesOf(used.mesh);
            try {
                // Intersect keeps only the overlap: there is no tool volume to show besides it.
                const overlay = operation === "common" ? undefined : this.toolOverlayOf(operation, used);
                return {
                    meshes: results.flatMap(({ shape }) => ExtrudeFeatureCommand.meshesOf(shape.mesh).meshes),
                    hide: results.flatMap(({ hide }) => hide),
                    ...(overlay === undefined ? {} : { overlays: [overlay] }),
                };
            } finally {
                for (const { shape } of results) shape.dispose();
            }
        } finally {
            if (used !== tool) used.dispose();
        }
    }

    /**
     * The previewed shapes and the bodies each stands in for: one merged body for a join, one
     * result per target otherwise. A target whose boolean fails keeps its own display.
     */
    private targetPreviews(
        operation: BooleanOperation,
        targets: readonly ParametricBodyNode[],
        tool: IShape,
    ): { shape: IShape; hide: INode[] }[] {
        if (operation === "fuse") {
            const [host, ...others] = targets;
            const merged = shapeFactory.booleanFuse(
                [host.shape.value],
                [tool, ...others.map((x) => x.shape.value)],
                true,
            );
            return merged.isOk ? [{ shape: merged.value, hide: [...targets] }] : [];
        }
        return targets.flatMap((target) => {
            const result = this.booleanPreview(operation, target, tool);
            return result.isOk ? [{ shape: result.value, hide: [target] }] : [];
        });
    }

    /**
     * Ctrl/Cmd+click on a body during the drag: a target is left out, any other body is added.
     * The defaults stay live (they follow the depth), the clicks are kept on top of them.
     */
    private readonly toggleTarget = (node: INode): boolean => {
        if (!(node instanceof ParametricBodyNode)) return false;
        if (this._lastTargets.includes(node)) {
            this._includedTargets.delete(node.id);
            this._excludedTargets.add(node.id);
        } else {
            this._excludedTargets.delete(node.id);
            this._includedTargets.add(node.id);
        }
        return true;
    };

    /** `defaults` with the Ctrl+click choices applied: left-out bodies dropped, added ones appended. */
    private applyTargetToggles(
        document: IDocument,
        defaults: readonly ParametricBodyNode[],
    ): ParametricBodyNode[] {
        const targets = defaults.filter((x) => !this._excludedTargets.has(x.id));
        for (const id of this._includedTargets) {
            if (this._excludedTargets.has(id) || targets.some((x) => x.id === id)) continue;
            const node = document.modelManager.findNode((n) => n.id === id);
            if (node instanceof ParametricBodyNode && node.shape.isOk) targets.push(node);
        }
        return targets;
    }

    /** Publishes what the extrude acts on to the options tab (see `targetsInfo`). */
    private showTargets(operation: BooleanOperation | undefined, targets: readonly ParametricBodyNode[]) {
        this._lastTargets = targets;
        const shown = operation !== undefined && targets.length > 0;
        this.setProperty("targetsInfo", shown ? extrudeTargetsInfo(operation, targets.length) : "");
        this.setProperty("hasTargets", shown);
    }

    private toolOverlayOf(operation: BooleanOperation, tool: IShape) {
        const { faces, edges } = tool.mesh;
        return toolOverlay(operation, faces, edges);
    }

    private static meshesOf(mesh: IShape["mesh"]): ExtrudePreview {
        const { faces, edges } = mesh;
        if (faces === undefined) throw new Error("Failed to mesh the extrude preview");
        return { meshes: edges === undefined ? [faces] : [faces, edges] };
    }

    /**
     * The operation this extrude applies with `tool` as its prism, and the bodies it applies
     * to — shared by the preview and the commit, so both agree on what is modified:
     * - Auto: into a body's material = cut, touching one and growing outward = join, no
     *   contact = new body (see `extrudeContact.ts`); hidden bodies are left alone. The
     *   options tab's Auto item follows the resolution ("Auto (Cut)").
     * - join/cut/intersect: against the bodies the tool goes into (else touches); without
     *   one the extrude is a new body.
     * - new: always a new body.
     *
     * The targets are `defaultTargets` with the drag's Ctrl+click choices applied; the host is
     * the body the tool goes into first (else the first target left). Leaving every body out
     * makes a new body. A press-pull cuts or intersects its host only — its tool comes off the
     * host's own chain, which another body cannot replay (`extrudeTarget.ts`).
     */
    private resolveOperation(document: IDocument, tool: IShape, pressPull: boolean): ResolvedOperation {
        const auto = this.operation === OPERATION_AUTO;
        const explicit = EXTRUDE_OPERATIONS[this.operation];
        if (!auto && explicit === undefined) {
            this.showTargets(undefined, []);
            return { targets: [] };
        }
        const contacts = findExtrudeTargets(document, tool, { includeHidden: !auto });
        const primary = primaryTarget(contacts)?.node;
        const autoResolved = auto ? autoOperation(primaryTarget(contacts)) : undefined;
        const operation = auto ? autoResolved : explicit;
        let targets =
            operation === undefined
                ? []
                : this.applyTargetToggles(document, defaultTargets(operation, contacts));
        if (primary !== undefined && targets.includes(primary)) {
            targets = [primary, ...targets.filter((x) => x !== primary)];
        }
        if (pressPull && operation !== "fuse") targets = targets.slice(0, 1);
        const resolved = targets.length === 0 ? undefined : operation;
        if (auto) {
            const label = targets.length === 0 ? "new" : (autoResolved ?? "new");
            this.setProperty("autoOperationLabel", AUTO_LABELS[label]);
        }
        this.showTargets(resolved, targets);
        return resolved === undefined ? { targets: [] } : { operation: resolved, targets };
    }

    /** The boolean of the preview prism against the target body's current shape. */
    private booleanPreview(
        operation: BooleanOperation,
        target: ParametricBodyNode,
        prism: IShape,
    ): Result<IShape> {
        switch (operation) {
            case "cut":
                return shapeFactory.booleanCut([target.shape.value], [prism]);
            case "common":
                return shapeFactory.booleanCommon([target.shape.value], [prism]);
            default:
                return shapeFactory.booleanFuse([target.shape.value], [prism], true);
        }
    }

    /** Faces to preview: the picked faces in world coordinates, or the whole sketch's outer profiles. */
    private static previewFaces(state: ExtrudeDragState, owned: IFace[]): IFace[] | undefined {
        if (state.faces.length > 0) return state.faces.map((x) => ExtrudeFeatureCommand.worldFace(x, owned));
        if (!(state.node instanceof SketchNode)) return undefined;
        const profiles = sketchProfiles(state.node);
        return profiles.isOk ? profiles.value.outer : undefined;
    }

    /**
     * The extrude's tool for `faces` (world placement): each face swept by its sides
     * (`sweepSidesOf`) from the start offset, touching prisms merged. `fuseHost` builds a
     * through-all join flush with that body, as the feature does; otherwise through all
     * passes every body (what the targets are detected with).
     */
    private buildTool(
        node: SketchNode | ParametricBodyNode,
        faces: IFace[],
        normal: XYZ,
        dist: number,
        fuseHost?: ParametricBodyNode,
    ): Result<IShape> {
        const owned: IShape[] = [];
        try {
            const end = this.extentEnd(node.document, owned, fuseHost);
            if (!end.isOk) return Result.err(end.error);
            return ExtrudeFeatureCommand.buildPrisms(
                faces,
                this.sweepSidesOf(node, normal, dist, end.value),
                this.offsetVectorOf(node, normal),
            );
        } finally {
            owned.forEach((x) => x.dispose());
        }
    }

    /** Where the extrusion ends, from the options (see `extrudeExtent.ts`). */
    private extentEnd(
        document: IDocument,
        owned: IShape[],
        fuseHost?: ParametricBodyNode,
    ): Result<ExtentEnd> {
        switch (this.extent) {
            case EXTENT_TO_OBJECT: {
                if (this._extentFace === undefined)
                    return Result.err(I18n.translate("option.command.extentFace.none") ?? "");
                const faces: IFace[] = [];
                const face = worldFaceOf(this._extentFace, faces);
                owned.push(...faces);
                return Result.ok({
                    kind: "toObject",
                    face,
                    offset: this.resolveLength(this.extentOffset) ?? 0,
                });
            }
            case EXTENT_THROUGH_ALL: {
                const bodies =
                    fuseHost === undefined ? ExtrudeFeatureCommand.allBodies(document) : [fuseHost];
                const bounds = bodies.map((body) => {
                    const transform = body.worldTransform();
                    if (transform.equals(Matrix4.identity())) return body.shape.value;
                    const placed = body.shape.value.transformedMul(transform);
                    owned.push(placed);
                    return placed;
                });
                if (bounds.length === 0) return Result.err(THROUGH_ALL_NO_BODY_ERROR);
                return Result.ok({ kind: "throughAll", bounds, flush: fuseHost !== undefined });
            }
            default:
                return Result.ok({ kind: "distance" });
        }
    }

    /** Every parametric body with a shape — what a through-all tool is sized against while detecting. */
    private static allBodies(document: IDocument): ParametricBodyNode[] {
        return (
            document.modelManager.findNodes((n) => n instanceof ParametricBodyNode) as ParametricBodyNode[]
        ).filter((x) => x.shape.isOk);
    }

    /**
     * The sides each face sweeps (`extentSides`): sketch profiles share the drag plane normal;
     * body faces sweep along their own outward normal, matching the feature's evaluation.
     * Symmetric extrusion sweeps both directions (never a to-object extent: it has no mirror).
     */
    private sweepSidesOf(
        node: INode,
        normal: XYZ,
        dist: number,
        end: ExtentEnd,
    ): (face: IFace) => SweepSide[] {
        const second = this.symmetric && end.kind !== "toObject" ? end : undefined;
        return node instanceof SketchNode
            ? () => extentSides(end, second, normal, dist)
            : (face) => extentSides(end, second, face.normal(0, 0)[1], dist);
    }

    /**
     * Start-offset vector per face: sketch profiles share the drag plane normal;
     * body faces offset along their own outward normal, matching `sweepSidesOf`.
     */
    private offsetVectorOf(node: INode, normal: XYZ): (face: IFace) => XYZ {
        return node instanceof SketchNode
            ? () => normal.multiply(this.startOffsetValue)
            : (face) => face.normal(0, 0)[1].multiply(this.startOffsetValue);
    }

    /**
     * The picked face in world coordinates; identity transforms reuse the raw shape,
     * transformed copies are pushed to `owned` for the caller to dispose.
     */
    private static worldFace(data: VisualShapeData, owned: IFace[]): IFace {
        const face = data.shape as unknown as IFace;
        if (data.transform.equals(Matrix4.identity())) return face;
        const world = face.transformedMul(data.transform) as IFace;
        owned.push(world);
        return world;
    }

    /**
     * Builds the fused prism shared by the preview and target detection. On a successful
     * fuse the inputs are disposed inside `fuseProfiles`; a failed combine leaves them
     * with us.
     */
    private static buildPrisms(
        faces: IFace[],
        sidesOf: (face: IFace) => SweepSide[],
        offsetOf: (face: IFace) => XYZ,
    ): Result<IShape> {
        const prisms: IShape[] = [];
        const owned: IFace[] = [];
        try {
            for (const face of faces) {
                const sweptFace = ExtrudeFeatureCommand.translateFace(face, offsetOf(face), owned);
                for (const side of sidesOf(face)) {
                    const prism = sweepSide(sweptFace, side);
                    if (!prism.isOk) {
                        prisms.forEach((x) => x.dispose());
                        return Result.err(prism.error);
                    }
                    prisms.push(prism.value);
                }
            }
        } finally {
            owned.forEach((x) => x.dispose());
        }
        const merged = fuseProfiles(prisms);
        if (!merged.isOk) prisms.forEach((x) => x.dispose());
        return merged;
    }

    /** Translates `face` along `vec` for a start offset; a zero offset returns the face unchanged. */
    private static translateFace(face: IFace, vec: XYZ, owned: IFace[]): IFace {
        if (vec.length() < Precision.Float) return face;
        const translated = face.transformedMul(Matrix4.fromTranslation(vec.x, vec.y, vec.z)) as IFace;
        owned.push(translated);
        return translated;
    }

    private readonly meshArrow = createExtrudeArrowMesher();

    protected override executeMainTask(): void {
        const node = this.sourceNode;
        const plane = this.dragData.plane!;
        // The feature stores what the user typed (the relation); the geometry needs the
        // number it resolves to. An expression that no longer resolves — the variable was
        // deleted between typing and committing — refuses the commit instead of sweeping
        // a prism of zero height.
        const depthResult = this.resolveParameter(this.depth, LENGTH_UNITS);
        if (!depthResult.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", depthResult.error);
            return;
        }
        const depth = depthResult.value;
        const refusal = this.extentRefusal();
        if (refusal !== undefined) {
            PubSub.default.pub("showToast", "error.default:{0}", refusal);
            return;
        }

        // Body-face fingerprints are captured in world coordinates (see the feature's
        // `source` contract); sketch profiles keep their raw faces.
        const owned: IFace[] = [];
        const worldFaces = this.dragData.shapes.map((x) => ExtrudeFeatureCommand.worldFace(x, owned));
        const feature = this.buildFeature(node, this.depth, worldFaces);
        try {
            const resolved = this.resolveCommitted(node, depth, plane.normal, worldFaces);
            if (
                this.extent === EXTENT_THROUGH_ALL &&
                (resolved.operation === undefined || resolved.targets.length === 0)
            ) {
                // A new body has nothing to go through: refuse rather than add a failing body.
                PubSub.default.pub("showToast", "error.default:{0}", THROUGH_ALL_NO_BODY_ERROR);
                return;
            }
            Transaction.execute(this.document, "excute feature.extrude", () => {
                this.commitFeature(node, feature, resolved);
                if (node instanceof SketchNode) {
                    // The sketch is consumed by the feature; hide it. Same transaction,
                    // so undo restores the visibility together with the body.
                    node.visible = false;
                }
                this.document.visual.update();
            });
        } finally {
            owned.forEach((x) => x.dispose());
        }
    }

    /** Why the extent cannot be committed as it stands; undefined when it can. */
    private extentRefusal(): string | undefined {
        if (this.extent === EXTENT_TO_OBJECT) {
            if (this._extentFace === undefined) return I18n.translate("option.command.extentFace.none");
            const offset = this.resolveParameter(this.extentOffset, LENGTH_UNITS);
            if (!offset.isOk) return offset.error;
        }
        return undefined;
    }

    /** The feature's extent fields: none for a distance (the format-2 shape), the picked face for "To object". */
    private extentData(): Pick<ExtrudeFeatureData, "extent"> {
        if (this.extent === EXTENT_THROUGH_ALL) return { extent: { type: "throughAll" } };
        if (this.extent !== EXTENT_TO_OBJECT || this._extentFace === undefined) return {};
        return { extent: toObjectExtentOf(this._extentFace, this.extentOffset) };
    }

    /** The feature payload of the committed drag. */
    private buildFeature(
        node: SketchNode | ParametricBodyNode,
        depth: ParameterValue,
        worldFaces: IFace[],
    ): ExtrudeFeatureData {
        return {
            id: Id.generate(),
            type: "extrude",
            depth,
            ...(this.symmetric && this.extent !== EXTENT_TO_OBJECT ? { symmetric: true } : {}),
            ...(this.startOffset !== 0 ? { startOffset: this.startOffset } : {}),
            ...this.extentData(),
            ...(node instanceof SketchNode
                ? {
                      sketchId: node.id,
                      ...(this.pickedFaces.length > 0
                          ? { profiles: this.pickedFaces.map((face) => captureProfileRef(face)) }
                          : {}),
                  }
                : {
                      // Press-pull: pair each fingerprint with the picked face's tracked
                      // id so rebuilds re-match by identity, not geometry (a merged face
                      // re-splitting is indistinguishable by fingerprint alone). The
                      // splitPiece stamp records a pick of one piece of an already split
                      // face (id shared at capture time), so the sweep never widens back
                      // to the whole span (see `narrowToPickedPiece` in sourceFaceMatcher.ts).
                      source: {
                          nodeId: node.id,
                          profiles: worldFaces.map((face, index) => {
                              const faceId = node.faceIdAt(this.dragData.shapes[index].indexes[0]);
                              if (faceId === undefined) {
                                  reportSilentIdLoss(node, "face", "a press-pull face has no tracked id");
                              }
                              return captureProfileRef(face, faceId, node.faceIdIsShared(faceId), true);
                          }),
                      },
                  }),
        };
    }

    /**
     * Join/cut/intersect (explicit or resolved by Auto): the feature is appended to the
     * host body and combines with its shape (Fusion-style), and reaches the other targets
     * through `applyExtrudeToTargets`; without a target (or for "new") the extrude becomes a
     * standalone body. The stored feature keeps the resolved operation — Auto never reaches
     * the file.
     */
    private commitFeature(
        _node: SketchNode | ParametricBodyNode,
        feature: ExtrudeFeatureData,
        resolved: ResolvedOperation,
    ): void {
        const { operation, targets } = resolved;
        if (operation !== undefined && targets.length > 0) {
            applyExtrudeToTargets({ ...feature, operation }, targets);
        } else {
            this.document.modelManager.addNode(
                new ParametricBodyNode({ document: this.document, features: [feature] }),
            );
        }
    }

    /** `resolveOperation` for the committed depth: rebuilds the prism the preview showed. */
    private resolveCommitted(
        node: SketchNode | ParametricBodyNode,
        depth: number,
        normal: XYZ,
        worldFaces: IFace[],
    ): ResolvedOperation {
        if (this.operation === OPERATION_NEW) return { targets: [] };
        let faces = worldFaces;
        if (node instanceof SketchNode && faces.length === 0) {
            const profiles = sketchProfiles(node);
            if (!profiles.isOk) return { targets: [] };
            faces = profiles.value.outer;
        }
        const built = this.buildTool(node, faces, normal, depth);
        if (!built.isOk) return { targets: [] };
        try {
            return this.resolveOperation(node.document, built.value, !(node instanceof SketchNode));
        } finally {
            built.value.dispose();
        }
    }
}
