// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    BoundingBox,
    Combobox,
    command,
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
import type { BooleanOperation, ExtrudeFeatureData } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { allProfiles, sketchProfiles } from "../features/profileBuilder";
import { captureProfileRef } from "../features/profileRef";
import { fuseProfiles } from "../features/sweepGeometry";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { autoOperation, findExtrudeTarget } from "./extrudeContact";
import {
    createExtrudeArrowMesher,
    type ExtrudeDragHandler,
    type ExtrudeDragState,
    ExtrudeDragStep,
    type ExtrudePreview,
    planeOfPickedFace,
    SELECTED_PROFILE_STATE,
} from "./extrudeDragStep";
import { prioritizeSketchFaces } from "./profileFaceSort";
import { toolOverlay } from "./toolOverlay";

const OPERATION_NEW: I18nKeys = "option.command.operation.new";

/** The Auto operation: join/cut/new resolved from how the extrusion meets the bodies. */
export const OPERATION_AUTO: I18nKeys = "option.command.operation.auto";

/** What the Auto item reads once resolved ("Auto (Cut)"); keyed by the resolved operation. */
const AUTO_LABELS: Record<"cut" | "fuse" | "new", I18nKeys> = {
    cut: "option.command.operation.auto.cut",
    fuse: "option.command.operation.auto.join",
    new: "option.command.operation.auto.new",
};

/** The operation an extrude resolved to, and the body it combines with (none for a new body). */
interface ResolvedOperation {
    readonly operation?: BooleanOperation;
    readonly target?: ParametricBodyNode;
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

    /** Interactive pick: planar faces of allowed nodes only, sketches before solid faces. */
    private async pickFace(
        document: IDocument,
        view: IView,
        controller: AsyncController,
    ): Promise<SnapResult | undefined> {
        const shapes = await document.picker.pickShape("prompt.select.faces", controller, {
            shapeType: ShapeTypes.face,
            shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
            multi: false,
            nodeFilter: { allow: this.allowNode },
            selectedState: SELECTED_PROFILE_STATE,
            sortDetected: prioritizeSketchFaces,
        });
        if (shapes.length === 0) return undefined;
        return { view, shapes, nodes: [shapes[0].owner.node], type: "shape" };
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

    /** Every extrude starts in Auto: an explicit choice is for this extrude only. */
    protected override isPropertyCached(property: Property): boolean {
        return property.name !== "operation";
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
        // Without a live drag there is nothing to preview, and nothing to resolve against.
        if (!this._dragHandler) return;
        const resolved = this.resolveLength(value);
        if (resolved !== undefined) this._dragHandler.setStartOffset(resolved);
    }

    @property("option.command.depth", { unit: LENGTH_UNITS })
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
        if (Math.abs(state.dist) < Precision.Float) return { meshes: [] };
        const owned: IFace[] = [];
        try {
            const faces = ExtrudeFeatureCommand.previewFaces(state, owned);
            if (faces === undefined) return { meshes: [] };
            const vecsOf = this.sweepVectorsOf(state.node, state.normal, state.dist);
            const offsetOf = this.offsetVectorOf(state.node, state.normal);
            const merged = ExtrudeFeatureCommand.buildPrisms(faces, vecsOf, offsetOf);
            if (!merged.isOk) throw merged.error;
            const tool = merged.value;
            try {
                return this.operationPreview((state.node as SketchNode | ParametricBodyNode).document, tool);
            } finally {
                tool.dispose();
            }
        } finally {
            owned.forEach((x) => x.dispose());
        }
    };

    /**
     * The preview of `tool` (not disposed here): the boolean result against the resolved
     * target body, which it stands in for, plus the tool overlay; the tool alone for a new
     * body or when the boolean fails.
     */
    private operationPreview(document: IDocument, tool: IShape): ExtrudePreview {
        const { operation, target } = this.resolveOperation(document, tool);
        if (operation === undefined || target === undefined) return ExtrudeFeatureCommand.meshesOf(tool.mesh);
        const result = this.booleanPreview(operation, target, tool);
        if (!result.isOk) return ExtrudeFeatureCommand.meshesOf(tool.mesh);
        try {
            // Intersect keeps only the overlap: there is no tool volume to show besides it.
            const overlay = operation === "common" ? undefined : this.toolOverlayOf(operation, tool);
            return {
                ...ExtrudeFeatureCommand.meshesOf(result.value.mesh),
                hide: [target],
                ...(overlay === undefined ? {} : { overlays: [overlay] }),
            };
        } finally {
            result.value.dispose();
        }
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
     * The operation this extrude applies with `tool` as its prism, and the body it applies
     * to — shared by the preview and the commit, so both agree on what is modified:
     * - Auto: into a body's material = cut, touching one and growing outward = join, no
     *   contact = new body (see `extrudeContact.ts`); hidden bodies are left alone. The
     *   options tab's Auto item follows the resolution ("Auto (Cut)").
     * - join/cut/intersect: against the body the tool goes into (else touches); without
     *   one the extrude is a new body.
     * - new: always a new body.
     */
    private resolveOperation(document: IDocument, tool: IShape): ResolvedOperation {
        if (this.operation === OPERATION_AUTO) {
            const target = findExtrudeTarget(document, tool);
            const operation = autoOperation(target);
            this.setProperty("autoOperationLabel", AUTO_LABELS[operation ?? "new"]);
            return operation === undefined ? {} : { operation, target: target?.node };
        }
        const operation = EXTRUDE_OPERATIONS[this.operation];
        if (operation === undefined) return {};
        const target = findExtrudeTarget(document, tool, { includeHidden: true });
        return target === undefined ? {} : { operation, target: target.node };
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
     * Sweep vectors per face: sketch profiles share the drag plane normal; body faces
     * sweep along their own outward normal, matching the feature's evaluation.
     * Symmetric extrusion sweeps both directions.
     */
    private sweepVectorsOf(node: INode, normal: XYZ, dist: number): (face: IFace) => XYZ[] {
        const bothWays = (vec: XYZ) => (this.symmetric ? [vec, vec.multiply(-1)] : [vec]);
        return node instanceof SketchNode
            ? () => bothWays(normal.multiply(dist))
            : (face) => bothWays(face.normal(0, 0)[1].multiply(dist));
    }

    /**
     * Start-offset vector per face: sketch profiles share the drag plane normal;
     * body faces offset along their own outward normal, matching `sweepVectorsOf`.
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
        vecsOf: (face: IFace) => XYZ[],
        offsetOf: (face: IFace) => XYZ,
    ): Result<IShape> {
        const prisms: IShape[] = [];
        const owned: IFace[] = [];
        try {
            for (const face of faces) {
                const sweptFace = ExtrudeFeatureCommand.translateFace(face, offsetOf(face), owned);
                for (const vec of vecsOf(face)) {
                    const prism = shapeFactory.prism(sweptFace, vec);
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

        // Body-face fingerprints are captured in world coordinates (see the feature's
        // `source` contract); sketch profiles keep their raw faces.
        const owned: IFace[] = [];
        const worldFaces = this.dragData.shapes.map((x) => ExtrudeFeatureCommand.worldFace(x, owned));
        const feature = this.buildFeature(node, this.depth, worldFaces);
        try {
            Transaction.execute(this.document, "excute feature.extrude", () => {
                this.commitFeature(node, feature, depth, plane.normal, worldFaces);
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
            ...(this.symmetric ? { symmetric: true } : {}),
            ...(this.startOffset !== 0 ? { startOffset: this.startOffset } : {}),
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
     * target body and combines with its shape (Fusion-style); without a target (or for
     * "new") the extrude becomes a standalone body. The stored feature keeps the resolved
     * operation — Auto never reaches the file.
     */
    private commitFeature(
        node: SketchNode | ParametricBodyNode,
        feature: ExtrudeFeatureData,
        depth: number,
        normal: XYZ,
        worldFaces: IFace[],
    ): void {
        const { operation, target } = this.resolveCommitted(node, depth, normal, worldFaces);
        if (operation !== undefined && target !== undefined) {
            target.setFeaturesEmitShapeChanged([...target.features, { ...feature, operation }]);
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
        if (this.operation === OPERATION_NEW) return {};
        let faces = worldFaces;
        if (node instanceof SketchNode && faces.length === 0) {
            const profiles = sketchProfiles(node);
            if (!profiles.isOk) return {};
            faces = profiles.value.outer;
        }
        const built = ExtrudeFeatureCommand.buildPrisms(
            faces,
            this.sweepVectorsOf(node, normal, depth),
            this.offsetVectorOf(node, normal),
        );
        if (!built.isOk) return {};
        try {
            return this.resolveOperation(node.document, built.value);
        } finally {
            built.value.dispose();
        }
    }
}
