// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    documentLengthUnit,
    type I18nKeys,
    type IDocument,
    type IEventHandler,
    type IFace,
    type INode,
    type IStep,
    type IView,
    type IVisualObject,
    isToggleSelectEvent,
    Line,
    Plane,
    Precision,
    PubSub,
    parseLength,
    Result,
    type ShapeMeshData,
    ShapeTypes,
    type SnapResult,
    type VisualShapeData,
    VisualStates,
    VisualStateUtils,
    XYZ,
} from "@spicy3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { planeOfFace } from "../sketch/planeRef";
import { SketchNode } from "../sketch/sketchNode";
import {
    ARROW_COLOR,
    ARROW_HOVER_COLOR,
    ARROW_HOVER_TOLERANCE,
    ARROW_LENGTH,
    arrowMeshes,
    distanceToSegment,
    pxSizedArrowLength,
} from "./arrowHandle";
import { prioritizeSketchFaces } from "./profileFaceSort";
import type { PreviewOverlay } from "./toolOverlay";

const DRAG_THRESHOLD_SQ = 9; // px², below this a press-release is a click, not a drag

/**
 * State of a profile face picked for the extrude: the translucent fill a selection
 * usually gets, plus its boundary outlined, so the profile that will be swept reads
 * apart from the faces that are merely hovered.
 */
export const SELECTED_PROFILE_STATE = VisualStateUtils.addState(
    VisualStates.faceTransparent,
    VisualStates.edgeSelected,
);

/**
 * The arrow's shaft segment in world space: base sits at the extrude's end face
 * (anchor + normal * (dist + startOffset)) and the arrow keeps a fixed length,
 * pointing in the drag direction. Shared by the handler's hit test and the command's
 * rendering.
 */
export function extrudeArrowSegment(state: ExtrudeDragState): { start: XYZ; end: XYZ } {
    const dir = state.dist < -Precision.Float ? state.normal.multiply(-1) : state.normal;
    const start = state.anchor.add(state.normal.multiply(state.dist + state.startOffset));
    return { start, end: start.add(dir.multiply(state.arrowLength ?? ARROW_LENGTH)) };
}

/**
 * The arrow renderer both extrude sessions (create and edit) hand the drag handler. The
 * geometry is fixed (cylinder shaft + cone head), so it is meshed once per direction+color at
 * the origin and cached; each call returns scaled, translated copies.
 */
export function createExtrudeArrowMesher(): (state: ExtrudeDragState) => ShapeMeshData[] {
    const cache = new Map<string, ShapeMeshData[]>();
    return (state) => {
        const color = state.arrowHovered ? ARROW_HOVER_COLOR : ARROW_COLOR;
        const { start, end } = extrudeArrowSegment(state);
        const dir = end.sub(start).normalize()!;
        const key = `${dir.x},${dir.y},${dir.z},${color}`;
        let meshes = cache.get(key);
        if (meshes === undefined) {
            meshes = arrowMeshes(XYZ.zero, dir, ARROW_LENGTH, color);
            cache.set(key, meshes);
        }
        const scale = (state.arrowLength ?? ARROW_LENGTH) / ARROW_LENGTH;
        return meshes.map((mesh) => ({ ...mesh, position: scaledAt(mesh.position, start, scale) }));
    };
}

/** Uniformly scales the canonical geometry and translates it to `offset`. */
function scaledAt(data: Float32Array, offset: XYZ, scale: number): Float32Array {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 3) {
        out[i] = data[i] * scale + offset.x;
        out[i + 1] = data[i + 1] * scale + offset.y;
        out[i + 2] = data[i + 2] * scale + offset.z;
    }
    return out;
}

/**
 * Mutable state of a drag session. The handler updates it when the user drags the
 * arrow or clicks another profile face; the command reads it through the callbacks
 * below so the preview always reflects the live face set.
 */
export interface ExtrudeDragState {
    /** The sketch or parametric body the current faces belong to. */
    node: INode;
    faces: VisualShapeData[];
    origin: XYZ;
    normal: XYZ;
    anchor: XYZ;
    dist: number;
    /** Bottom offset of the extrude along `normal` (startOffset). */
    startOffset: number;
    /** True while the pointer hovers the arrow; the command renders it highlighted. */
    arrowHovered: boolean;
    /** World-space arrow length, adapted by the handler so the arrow is zoom-independent. */
    arrowLength?: number;
    /**
     * True while the depth is being dragged (arrow held, or click-move-click armed): a preview
     * can afford less then, and gets rebuilt once more when the drag settles (editing only).
     */
    dragging?: boolean;
}

export interface ExtrudePreview {
    meshes: ShapeMeshData[];
    /**
     * Nodes whose display the preview replaces — hidden for as long as it is shown.
     * A boolean preview *is* the target body with the operation applied, so the body
     * has to come down: drawn together, the two overlap and the result reads as a
     * ghost over the geometry it replaces instead of as the geometry itself.
     */
    hide?: INode[];
    /**
     * Translucent colored meshes drawn over `meshes` — a cut's tool volume in red, so the
     * preview shows what is taken away and not only the hole it leaves (see `toolOverlay`).
     */
    overlays?: PreviewOverlay[];
}

export interface ExtrudeDragData {
    node: INode;
    /** Initial profile faces from the pick step; empty means the whole sketch. */
    faces: VisualShapeData[];
    origin: XYZ;
    normal: XYZ;
    anchor: XYZ;
    /** The command's current signed depth, so the arrow starts in sync with its input. */
    depth?: number;
    /** The command's current start offset, so the arrow starts at the extruded end face. */
    startOffset?: number;
    buildPreview(state: ExtrudeDragState): ExtrudePreview;
    meshArrow(state: ExtrudeDragState): ShapeMeshData[];
    /**
     * Ctrl/Cmd+click on a body: the command adds it to or removes it from the bodies the
     * extrude acts on, and returns true when that changed anything (the preview then
     * rebuilds). Absent: such a click does nothing special. Works while editing too.
     */
    toggleTarget?(node: INode): boolean;
    /** The handler registers itself so the command can push option/depth changes back. */
    onReady?(handler: ExtrudeDragHandler): void;
    /** The handler reports its cleanup so the command can drop the reference. */
    onDone?(): void;
    /** The handler reports the signed depth so the command syncs its depth input. */
    onDist?(dist: number): void;
    /**
     * Editing an existing extrude: the profiles are the feature's own (re-picking them is
     * "Reselect"), so clicks never switch or toggle faces and nothing hovers; leaving the
     * click-move mode goes back to the stored depth instead of zero; and the preview is
     * rebuilt once more when a drag settles (see `ExtrudeDragState.dragging`).
     */
    editing?: boolean;
}

/** Outward plane of a picked solid face, in world coordinates. */
export function planeOfPickedFace(face: VisualShapeData): Plane {
    const world = (face.shape as IFace).transformedMul(face.transform) as IFace;
    const plane = planeOfFace(world);
    world.dispose();
    return plane;
}

/**
 * Push-pull step: shows a draggable arrow plus the confirm/cancel buttons from the
 * start. Two gestures set the depth: drag the arrow with the left button held, or
 * click the arrow and then click a second point (classic click-move-click) — both
 * project the mouse ray onto the extrude normal. A plain click on another profile face
 * (sketch profile or planar solid face) switches the profiles to it; Ctrl/Cmd+click or
 * Shift+click toggles a face of the current node, and Ctrl/Cmd+click on a body adds it to or
 * removes it from the bodies the extrude acts on. Typing a number enters an exact length. Confirm (button/Enter)
 * commits once a non-zero depth exists; Escape cancels (exiting click-move mode first).
 */
export class ExtrudeDragStep implements IStep {
    constructor(
        readonly tip: I18nKeys,
        private readonly handleStepData: () => ExtrudeDragData,
    ) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const data = this.handleStepData();
        const handler = new ExtrudeDragHandler(document, controller, data);
        try {
            await document.picker.pickAsync(handler, this.tip, controller, false, "draw");
        } finally {
            // Dispose first, always: the handler's cleanup is what puts back the nodes a
            // boolean preview hid, and a body left invisible is a far louder failure than
            // a stray preview mesh (a throwing pick subscriber must not cause either).
            handler.dispose();
        }

        const state = handler.state;
        const view = handler.commitView;
        if (controller.result?.status !== "success" || view === undefined) return undefined;

        return {
            view,
            point: state.origin.add(state.normal.multiply(state.dist)),
            distance: Math.abs(state.dist),
            shapes: state.faces,
            nodes: [state.node as any],
            type: "input",
            // The live drag plane (it changes when the user switches faces mid-drag),
            // so the command can recover the signed length and direction.
            plane: new Plane({
                origin: state.origin,
                normal: state.normal,
                xvec: state.normal.isParallelTo(XYZ.unitZ)
                    ? XYZ.unitX
                    : XYZ.unitZ.cross(state.normal).normalize()!,
            }),
        };
    }
}

export class ExtrudeDragHandler implements IEventHandler {
    isEnabled: boolean = true;

    readonly state: ExtrudeDragState;
    commitView: IView | undefined;

    private _downX: number | undefined;
    private _downY: number | undefined;
    private _dragging = false;
    /** Click-move-click mode: the arrow was clicked, the next click commits the distance. */
    private _awaitingClick = false;
    /** Projection of the grab point on the axis minus dist at grab time; keeps dragging continuous. */
    private _grabOffset = 0;
    private _arrowIds: number[] = [];
    private _previewIds: number[] = [];
    /** Nodes the displayed preview hid (see `ExtrudePreview.hide`). */
    private _hidden: INode[] = [];
    /** Visual currently ghosted for the drag (see `syncSourceGhost`). */
    private _ghosted: IVisualObject | undefined;
    private _hovered: VisualShapeData | undefined;
    /** The face the arrow is anchored to; re-detection yields new points, so track identity. */
    private _anchorFace: VisualShapeData | undefined;
    /** The view whose camera changes are tracked for arrow rescaling. */
    private _cameraView: IView | undefined;
    private _cleaned = false;

    constructor(
        readonly document: IDocument,
        readonly controller: AsyncController,
        readonly data: ExtrudeDragData,
    ) {
        this.state = {
            node: data.node,
            faces: [...data.faces],
            origin: data.origin,
            normal: data.normal,
            anchor: data.anchor,
            dist: data.depth ?? 0,
            startOffset: data.startOffset ?? 0,
            arrowHovered: false,
        };
        // The initial anchor is the first face's pick point (see the command's getDragData).
        this._anchorFace = data.faces[0]?.point !== undefined ? data.faces[0] : undefined;
        controller.onCancelled(() => this.cleanup());
        controller.onCompleted(() => this.cleanup());
        controller.onFailed(() => this.cleanup());
        if (document.application.activeView !== undefined) {
            this.trackCamera(document.application.activeView);
        }
        this.refreshTempShapes(document.application.activeView);
        this.publishConfirmControl();
        data.onReady?.(this);
    }

    pointerMove(view: IView, event: PointerEvent): void {
        this.trackCamera(view);
        if (this._awaitingClick) {
            this.updateDrag(view, event);
        } else if (this._downX !== undefined) {
            if (!this._dragging) {
                const dx = event.offsetX - this._downX;
                const dy = event.offsetY - this._downY!;
                if (dx * dx + dy * dy <= DRAG_THRESHOLD_SQ) return;
                this._dragging = true;
                this.state.dragging = true;
                this._grabOffset = this.projectDist(view, event) - this.state.dist;
                this.clearHover();
            }
            this.updateDrag(view, event);
        } else {
            this.updateHover(view, event);
        }
    }

    pointerDown(view: IView, event: PointerEvent): void {
        if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        this.trackCamera(view);
        if (this._awaitingClick) return; // the release commits; nothing to track
        this._downX = event.offsetX;
        this._downY = event.offsetY;
        this._dragging = false;
    }

    pointerUp(view: IView, event: PointerEvent): void {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (this._awaitingClick) {
            this.finishMoveMode(view);
            return;
        }
        if (this._downX === undefined) return;
        const wasDragging = this._dragging;
        this._downX = undefined;
        this._downY = undefined;
        this._dragging = false;
        this.state.dragging = false;

        if (wasDragging && Math.abs(this.state.dist) >= Precision.Float) {
            this.commitView = view;
            this.settle(view);
            return;
        }
        // A plain click on the arrow starts the click-move-click gesture; Shift and Ctrl
        // keep their toggle meaning even on the arrow.
        if (!event.shiftKey && !isToggleSelectEvent(event) && this.isOverArrow(view, event)) {
            this.enterMoveMode(view, event);
            return;
        }
        this.handleClick(view, event);
    }

    /** The second click of click-move-click: commits a non-zero depth, else just leaves the mode. */
    private finishMoveMode(view: IView) {
        this._awaitingClick = false;
        this.state.dragging = false;
        if (Math.abs(this.state.dist) >= Precision.Float) {
            this.commitView = view;
            this.settle(view);
        } else {
            // Second click landed at (near) zero depth: just leave the move mode.
            this.setArrowHover(view, false);
            PubSub.default.pub("clearFloatTip");
        }
    }

    pointerOut(view: IView, _event: PointerEvent): void {
        this.clearHover();
        if (!this._awaitingClick) this.setArrowHover(view, false);
        view.update();
    }

    mouseWheel(view: IView, event: WheelEvent): void {
        this.trackCamera(view);
        view.update();
    }

    keyDown(view: IView, event: KeyboardEvent): void {
        if (event.key === "Escape") {
            if (this._awaitingClick) {
                // The first Escape only leaves the click-move mode; the next cancels.
                event.preventDefault();
                event.stopImmediatePropagation();
                this.exitMoveMode(view);
                return;
            }
            this.controller.cancel();
        } else if (event.key === "Enter" || event.key === " ") {
            // Enter/Space confirms the pending extrude (and must not trigger HotKeyService).
            event.preventDefault();
            event.stopImmediatePropagation();
            this.confirm();
        } else {
            this.handleNumericInput(view, event);
        }
    }

    dispose(): void {
        this.cleanup();
    }

    /** The command pushes a new depth (from the options-tab input) into the drag state. */
    setDepth(dist: number): void {
        if (Math.abs(this.state.dist - dist) < Precision.Float) return;
        this.state.dist = dist;
        this.refreshTempShapes();
    }

    /** The command pushes a new start offset; the arrow base must follow the end face. */
    setStartOffset(value: number): void {
        if (Math.abs(this.state.startOffset - value) < Precision.Float) return;
        this.state.startOffset = value;
        this.refreshTempShapes();
    }

    /** The command asks for a preview rebuild after an option changed (operation/symmetric). */
    refresh(): void {
        this.refreshTempShapes();
    }

    /**
     * Shows the confirm/cancel buttons for the whole drag step (not just after a
     * release). The confirm button guards against a zero depth so it cannot commit an
     * empty extrude before the user has dragged.
     */
    private publishConfirmControl() {
        PubSub.default.pub("showSelectionControl", {
            success: () => this.confirm(),
            cancel: () => this.controller.cancel(),
        } as unknown as AsyncController);
    }

    /** Confirms the extrude once a non-zero depth exists; a zero depth is a no-op. */
    private confirm() {
        if (Math.abs(this.state.dist) >= Precision.Float) {
            // The button/Enter has no pointer event to provide the view, so fall back to
            // the active view; without it the step returns undefined and the command
            // closes as if cancelled (e.g. confirming a cached depth without dragging).
            if (this.commitView === undefined) {
                this.commitView = this.document.application.activeView;
            }
            this.controller.success();
        }
    }

    /** Enters click-move-click mode: grabs the current projection so the depth does not jump. */
    private enterMoveMode(view: IView, event: PointerEvent) {
        this._awaitingClick = true;
        this.state.dragging = true;
        this._grabOffset = this.projectDist(view, event) - this.state.dist;
        this.clearHover();
        this.setArrowHover(view, true);
    }

    /** Leaves click-move-click mode without committing, resetting the preview depth. */
    private exitMoveMode(view: IView) {
        this._awaitingClick = false;
        this.state.dragging = false;
        // Editing goes back to the stored depth; creating has none to go back to.
        const rest = this.data.editing ? (this.data.depth ?? 0) : 0;
        this.state.dist = rest;
        this.data.onDist?.(rest);
        this.setArrowHover(view, false);
        this.refreshTempShapes(view);
        PubSub.default.pub("clearFloatTip");
        view.document.visual.update();
    }

    /** A drag came to rest: editing rebuilds the preview at full depth (see `dragging`). */
    private settle(view: IView) {
        if (this.data.editing) this.refreshTempShapes(view);
    }

    private updateDrag(view: IView, event: PointerEvent) {
        this.state.dist = this.projectDist(view, event) - this._grabOffset;
        this.data.onDist?.(this.state.dist);
        this.refreshTempShapes(view);
        view.document.visual.update();
    }

    /** Projects the mouse ray onto the extrude axis and returns the signed distance. */
    private projectDist(view: IView, event: PointerEvent): number {
        const ray = view.rayAt(event.offsetX, event.offsetY);
        const axis = new Line({ point: this.state.origin, direction: this.state.normal });
        return axis.nearestTo(ray.toLine()).sub(this.state.origin).dot(this.state.normal);
    }

    /**
     * A click that is not a drag: Shift or Ctrl/Cmd on a face of the current node toggles that
     * profile; Ctrl/Cmd on a body toggles it as a target; any other click on a profile face
     * switches to it (replacing the profiles). Editing keeps the feature's own profiles (see
     * `ExtrudeDragData.editing`), so only the target toggle applies there.
     */
    private handleClick(view: IView, event: PointerEvent) {
        const face = this.data.editing ? undefined : this.detectProfileFace(view, event);
        const toggle = event.shiftKey || isToggleSelectEvent(event);
        const profileToggle =
            face !== undefined &&
            toggle &&
            face.owner.node === this.state.node &&
            this.state.faces.length > 0;
        if (!profileToggle && isToggleSelectEvent(event) && this.toggleTargetAt(view, event)) return;
        if (face === undefined) return;

        if (profileToggle) {
            // Same node, same plane: the depth stays, so the preview follows the toggle live.
            if (!this.toggleFace(face)) return;
        } else {
            this.switchTarget(face);
            this.state.dist = 0;
            this.data.onDist?.(0);
        }

        // Refresh the arrow before syncing the selection: a throwing selection
        // subscriber must not leave the arrow at the stale position.
        this.refreshTempShapes(view);
        this.document.selection.setSelectedShapes(this.state.faces, SELECTED_PROFILE_STATE, false);
        view.document.visual.update();
    }

    /**
     * Ctrl/Cmd+click on a body (the topmost face under the pointer, sketch faces first, is a
     * body's): hands it to `toggleTarget` and rebuilds the preview. False when nothing changed.
     */
    private toggleTargetAt(view: IView, event: PointerEvent): boolean {
        if (this.data.toggleTarget === undefined) return false;
        const hit = prioritizeSketchFaces(
            view.detectShapes(ShapeTypes.face, event.offsetX, event.offsetY),
        )[0];
        const node = hit?.owner.node;
        if (!(node instanceof ParametricBodyNode) || !this.data.toggleTarget(node)) return false;
        this.refreshTempShapes(view);
        view.document.visual.update();
        return true;
    }

    /**
     * Shift/Ctrl-click on the current node toggles the face in the extrude set. Returns
     * false when the click is a no-op (removing the last remaining profile).
     */
    private toggleFace(face: VisualShapeData): boolean {
        const index = this.state.faces.findIndex((x) => ExtrudeDragHandler.sameFace(x, face));
        if (index < 0) {
            this.state.faces.push(face);
            // Follow the newly added profile with the arrow.
            if (face.point !== undefined) {
                this.state.anchor = face.point;
                this._anchorFace = face;
            }
            return true;
        }
        if (this.state.faces.length === 1) return false; // keep at least one profile
        this.state.faces.splice(index, 1);
        // The arrow was on the removed profile: fall back to the previous one.
        if (this._anchorFace !== undefined && ExtrudeDragHandler.sameFace(this._anchorFace, face)) {
            const previous = this.state.faces.at(-1);
            this.state.anchor = previous?.point ?? this.state.origin;
            this._anchorFace = previous?.point !== undefined ? previous : undefined;
        }
        return true;
    }

    /** A plain click switches the extrude to the clicked face (and its node's plane). */
    private switchTarget(face: VisualShapeData) {
        const node = face.owner.node;
        const plane = node instanceof SketchNode ? node.plane : planeOfPickedFace(face);
        this.state.node = node;
        this.state.faces = [face];
        this.state.origin = plane.origin;
        this.state.normal = plane.normal;
        this.state.anchor = face.point ?? plane.origin;
        this._anchorFace = face.point !== undefined ? face : undefined;
    }

    private updateHover(view: IView, event: PointerEvent) {
        // Covers the case where no active view was available at construction time.
        if (this.state.arrowLength === undefined) this.refreshArrow(view);

        if (this.isOverArrow(view, event)) {
            this.clearHover();
            this.setArrowHover(view, true);
            return;
        }
        this.setArrowHover(view, false);
        if (this.data.editing) return;

        const face = this.detectProfileFace(view, event);
        if (face === this._hovered) return;

        this.clearHover();
        this._hovered = face;
        if (face !== undefined) {
            this.document.visual.highlighter.addState(
                face.owner,
                VisualStates.faceHighlight,
                ShapeTypes.face,
                ...face.indexes,
            );
        }
        view.update();
    }

    /** Screen-space hit test against the arrow shaft segment. */
    private isOverArrow(view: IView, event: PointerEvent): boolean {
        const { start, end } = extrudeArrowSegment(this.state);
        const a = view.worldToScreen(start);
        const b = view.worldToScreen(end);
        return distanceToSegment(event.offsetX, event.offsetY, a, b) <= ARROW_HOVER_TOLERANCE;
    }

    private setArrowHover(view: IView, hovered: boolean) {
        if (this.state.arrowHovered === hovered) return;
        this.state.arrowHovered = hovered;
        this.refreshArrow(view);
        view.update();
    }

    /** Sketch profile faces, or planar faces of a parametric body (press-pull). */
    private detectProfileFace(view: IView, event: PointerEvent): VisualShapeData | undefined {
        const faces = prioritizeSketchFaces(view.detectShapes(ShapeTypes.face, event.offsetX, event.offsetY));
        return faces.find(
            (x) =>
                x.owner.node instanceof SketchNode ||
                (x.owner.node instanceof ParametricBodyNode && (x.shape as IFace).surface().isPlanar()),
        );
    }

    private clearHover() {
        if (this._hovered === undefined) return;
        this.document.visual.highlighter.removeState(
            this._hovered.owner,
            VisualStates.faceHighlight,
            ShapeTypes.face,
            ...this._hovered.indexes,
        );
        this._hovered = undefined;
    }

    private handleNumericInput(view: IView, event: KeyboardEvent) {
        if (!["#", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(event.key)) return;

        PubSub.default.pub("showInput", event.key, (text: string) => {
            // Typed in the project unit (or with an explicit one, `1in`); the drag works in mm.
            const parsed = parseLength(text, documentLengthUnit(this.document));
            if (!parsed.isOk) return Result.err("error.input.invalidNumber" as I18nKeys);

            const value = parsed.value;
            this.state.dist = this.state.dist < -Precision.Float ? -value : value;
            this.data.onDist?.(this.state.dist);
            this.commitView = view;
            this.settle(view);
            return Result.ok(text);
        });
    }

    private refreshTempShapes(view?: IView) {
        this.refreshArrow(view);
        for (const id of this._previewIds) {
            this.document.visual.context.removeMesh(id);
        }
        this._previewIds = [];
        this.restoreHiddenNodes();
        if (Math.abs(this.state.dist) >= Precision.Float) {
            const preview = this.data.buildPreview(this.state);
            const context = this.document.visual.context;
            for (const mesh of preview.meshes) {
                this._previewIds.push(context.displayMesh([mesh], { meshOpacity: 1 }));
            }
            for (const overlay of preview.overlays ?? []) {
                const id = context.displayMesh(overlay.meshes, {
                    meshOpacity: overlay.opacity,
                    lineOpacity: overlay.opacity,
                    onTop: overlay.onTop,
                });
                context.setMeshColor(id, overlay.color);
                this._previewIds.push(id);
            }
            for (const node of preview.hide ?? []) {
                this.document.visual.context.setVisible(node, false);
                this._hidden.push(node);
            }
        }
        this.syncSourceGhost();
        this.document.visual.update();
    }

    /**
     * Ghosts a sketch the drag extrudes from. Its profile faces are real geometry in the
     * node's mesh (`SketchNode.showProfileFaces`, what makes them pickable), so the
     * transparent highlight lands on an opaque face and just tints it — the face has to
     * go transparent too. Whole-visual state: the mesh's faces take the transparent
     * material, its edges keep theirs, and picking is unaffected (it goes through the
     * geometry, not the materials), so faces stay hoverable and toggleable mid-drag.
     */
    private syncSourceGhost() {
        const node = this.state.node;
        const visual = node instanceof SketchNode ? this.document.visual.context.getVisual(node) : undefined;
        if (visual === this._ghosted) return;

        this.clearSourceGhost();
        if (visual === undefined) return;

        // The drag owns the interaction: the picked profile faces are the selection that
        // matters now, so the whole node comes out of the selection — a node-selected
        // sketch would otherwise stay outlined edge to edge for the whole drag.
        this.document.selection.setSelectedNodes([], false);
        this.document.visual.highlighter.addState(visual, VisualStates.faceTransparent, ShapeTypes.shape);
        this._ghosted = visual;
    }

    private clearSourceGhost() {
        if (this._ghosted === undefined) return;
        this.document.visual.highlighter.removeState(
            this._ghosted,
            VisualStates.faceTransparent,
            ShapeTypes.shape,
        );
        this._ghosted = undefined;
    }

    /**
     * Brings back the nodes the displayed preview hid. Each goes back to what its own
     * flags say rather than to visible: an explicit join/cut/intersect targets hidden
     * bodies too (`findExtrudeTarget` with `includeHidden`), so one can be the preview's target.
     */
    private restoreHiddenNodes() {
        for (const node of this._hidden) {
            this.document.visual.context.setVisible(node, node.visible && node.parentVisible);
        }
        this._hidden = [];
    }

    private refreshArrow(view?: IView) {
        if (view !== undefined) this.updateArrowScale(view);
        for (const id of this._arrowIds) {
            this.document.visual.context.removeMesh(id);
        }
        this._arrowIds = [];
        const context = this.document.visual.context;
        for (const mesh of this.data.meshArrow(this.state)) {
            this._arrowIds.push(context.displayMesh([mesh], { meshOpacity: 1, onTop: true }));
        }
        this.document.visual.update();
    }

    /** Adapts the world-space arrow length so the arrow renders at a fixed pixel size. */
    private updateArrowScale(view: IView) {
        // Measure at the fixed anchor, not at the moving extrude depth: under a
        // perspective camera the depth change would make the arrow pulsing while dragging.
        const length = pxSizedArrowLength(view, this.state.anchor, this.state.normal);
        if (length !== undefined) this.state.arrowLength = length;
    }

    /**
     * The viewport dispatches the wheel event to this handler before the camera zooms,
     * so rescaling there would use the stale camera. Track camera changes instead:
     * `cameraPosition` is emitted after every zoom/pan/rotate.
     */
    private trackCamera(view: IView) {
        if (this._cameraView === view) return;
        this._cameraView?.cameraController.removePropertyChanged(this.handleCameraChanged);
        this._cameraView = view;
        view.cameraController.onPropertyChanged(this.handleCameraChanged);
    }

    private readonly handleCameraChanged = () => {
        if (this._cameraView !== undefined && !this._cleaned) {
            this.refreshArrow(this._cameraView);
        }
    };

    private removeTempShapes() {
        for (const id of [...this._arrowIds, ...this._previewIds]) {
            this.document.visual.context.removeMesh(id);
        }
        this._arrowIds = [];
        this._previewIds = [];
        this.restoreHiddenNodes();
    }

    private cleanup() {
        if (this._cleaned) return;
        this._cleaned = true;
        this._cameraView?.cameraController.removePropertyChanged(this.handleCameraChanged);
        this._cameraView = undefined;
        this.removeTempShapes();
        this.clearSourceGhost();
        this.clearHover();
        PubSub.default.pub("clearInput");
        PubSub.default.pub("clearSelectionControl");
        this.data.onDone?.();
        this.document.visual.update();
    }

    private static sameFace(a: VisualShapeData, b: VisualShapeData): boolean {
        return a.owner === b.owner && a.indexes.join(",") === b.indexes.join(",");
    }
}
