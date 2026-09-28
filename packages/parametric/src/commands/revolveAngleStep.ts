// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type I18nKeys,
    type IDocument,
    type IEventHandler,
    type IFace,
    type INode,
    type IStep,
    type IView,
    type Line,
    Plane,
    Precision,
    PubSub,
    Result,
    type ShapeMeshData,
    type SnapResult,
    XYZ,
} from "@spicy3d/core";
import {
    ARROW_COLOR,
    ARROW_HOVER_COLOR,
    ARROW_HOVER_TOLERANCE,
    ARROW_LENGTH,
    arrowMeshes,
    distanceToSegment,
    pxSizedArrowLength,
} from "./arrowHandle";
import type { ExtrudePreview } from "./extrudeDragStep";

/** Largest sweep either way, in degrees. */
export const MAX_REVOLVE_ANGLE = 360;

/**
 * The circle the angle handle travels on: centred on the axis, through `anchor` (a point of
 * the profile off the axis), in the plane perpendicular to the axis. Undefined when the anchor
 * sits on the axis — there is no circle to follow then.
 */
export interface RevolveHandleCircle {
    readonly center: XYZ;
    /** Unit axis direction; positive angles turn counter-clockwise around it. */
    readonly axis: XYZ;
    /** Unit vector from the centre to the anchor (angle 0). */
    readonly radial: XYZ;
    /** `axis × radial`: the direction the handle moves at angle 0. */
    readonly tangent: XYZ;
    readonly radius: number;
}

export function revolveHandleCircle(axis: Line, anchor: XYZ): RevolveHandleCircle | undefined {
    const direction = axis.direction.normalize();
    if (direction === undefined) return undefined;
    const center = axis.point.add(direction.multiply(anchor.sub(axis.point).dot(direction)));
    const offset = anchor.sub(center);
    const radius = offset.length();
    const radial = offset.normalize();
    if (radial === undefined || radius < Precision.Distance) return undefined;
    return { center, axis: direction, radial, tangent: direction.cross(radial), radius };
}

/** Where the handle sits at `degrees`, and which way it points (the way the angle grows). */
export function revolveHandlePose(
    circle: RevolveHandleCircle,
    degrees: number,
): { point: XYZ; direction: XYZ } {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const point = circle.center
        .add(circle.radial.multiply(circle.radius * cos))
        .add(circle.tangent.multiply(circle.radius * sin));
    const along = circle.radial.multiply(-sin).add(circle.tangent.multiply(cos));
    return { point, direction: degrees < -Precision.Angle ? along.multiply(-1) : along };
}

/**
 * The angle (degrees) of `point` around the circle, taken as the turn nearest to `previous` —
 * so a drag past ±180° keeps going instead of jumping to the other side — and clamped to
 * ±{@link MAX_REVOLVE_ANGLE}. Undefined for a point on the axis.
 */
export function revolveAngleAt(
    circle: RevolveHandleCircle,
    point: XYZ,
    previous: number,
): number | undefined {
    const offset = point.sub(circle.center);
    const x = offset.dot(circle.radial);
    const y = offset.dot(circle.tangent);
    if (Math.hypot(x, y) < Precision.Distance) return undefined;
    const principal = (Math.atan2(y, x) * 180) / Math.PI;
    const turns = Math.round((previous - principal) / 360);
    const angle = principal + turns * 360;
    return Math.max(-MAX_REVOLVE_ANGLE, Math.min(MAX_REVOLVE_ANGLE, angle));
}

/**
 * A point of the profile to hang the handle on: the corner of the profile's bounding box
 * farthest from the axis, so the handle travels on the widest circle the profile sweeps.
 */
export function revolveHandleAnchor(face: IFace, axis: Line): XYZ {
    const { min, max } = face.boundingBox();
    const corners = [min.x, max.x].flatMap((x) =>
        [min.y, max.y].flatMap((y) => [min.z, max.z].map((z) => new XYZ({ x, y, z }))),
    );
    const distance = (p: XYZ) => axis.nearestToPoint(p).distanceTo(p);
    return corners.reduce((best, p) => (distance(p) > distance(best) ? p : best));
}

export interface RevolveAngleData {
    /** World-space rotation axis. */
    readonly axis: Line;
    /** World-space profile point the handle starts on (angle 0). */
    readonly anchor: XYZ;
    /** The starting angle in degrees (the command's value). */
    readonly angle: number;
    /** Editing an existing revolve: the preview is rebuilt once more when a drag settles. */
    readonly editing?: boolean;
    buildPreview(angle: number, dragging: boolean): ExtrudePreview;
    /** The handler registers itself so the command can push typed angles back. */
    onReady?(handler: RevolveAngleHandler): void;
    onDone?(): void;
    /** The handler reports each new angle so the command syncs its angle input. */
    onAngle?(angle: number): void;
}

/**
 * The revolve's angle step: an arrow on the circle a profile point sweeps, dragged around the
 * axis with a live preview, plus the confirm/cancel buttons. Typing a number enters an exact
 * angle; Enter/Space or the confirm button commits a non-zero angle, Escape cancels.
 */
export class RevolveAngleStep implements IStep {
    constructor(
        readonly tip: I18nKeys,
        /** Undefined when there is nothing to turn (the command has said why): the step ends. */
        private readonly handleStepData: () => RevolveAngleData | undefined,
    ) {}

    async execute(document: IDocument, controller: AsyncController): Promise<SnapResult | undefined> {
        const data = this.handleStepData();
        if (data === undefined) {
            controller.cancel();
            return undefined;
        }
        const handler = new RevolveAngleHandler(document, controller, data);
        try {
            await document.picker.pickAsync(handler, this.tip, controller, false, "draw");
        } finally {
            handler.dispose();
        }
        const view = document.application.activeView;
        if (controller.result?.status !== "success" || view === undefined) return undefined;
        return { view, type: "input", shapes: [], distance: handler.angle };
    }
}

/** Degrees the drag snaps to. */
const ANGLE_STEP = 1;

export class RevolveAngleHandler implements IEventHandler {
    isEnabled = true;

    private _angle: number;
    private _dragging = false;
    private _hovered = false;
    private _arrowLength: number | undefined;
    private _arrowIds: number[] = [];
    private _previewIds: number[] = [];
    private _hidden: INode[] = [];
    private _cameraView: IView | undefined;
    private _cleaned = false;
    private readonly circle: RevolveHandleCircle | undefined;

    constructor(
        readonly document: IDocument,
        readonly controller: AsyncController,
        readonly data: RevolveAngleData,
    ) {
        this._angle = data.angle;
        this.circle = revolveHandleCircle(data.axis, data.anchor);
        controller.onCancelled(() => this.cleanup());
        controller.onCompleted(() => this.cleanup());
        controller.onFailed(() => this.cleanup());
        const view = document.application.activeView;
        if (view !== undefined) this.trackCamera(view);
        this.refreshArrow(view);
        this.refreshPreview();
        PubSub.default.pub("showSelectionControl", {
            success: () => this.confirm(),
            cancel: () => this.controller.cancel(),
        } as unknown as AsyncController);
        data.onReady?.(this);
    }

    get angle(): number {
        return this._angle;
    }

    /** The command pushes a typed angle into the handle. */
    setAngle(angle: number): void {
        if (Math.abs(angle - this._angle) < Precision.Angle) return;
        this._angle = angle;
        this.refreshArrow();
        this.refreshPreview();
    }

    pointerDown(view: IView, event: PointerEvent): void {
        if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        this.trackCamera(view);
        if (this.isOverArrow(view, event)) this._dragging = true;
    }

    pointerMove(view: IView, event: PointerEvent): void {
        this.trackCamera(view);
        if (!this._dragging) {
            this.setHover(view, this.isOverArrow(view, event));
            return;
        }
        const angle = this.projectAngle(view, event);
        if (angle === undefined || Math.abs(angle - this._angle) < Precision.Angle) return;
        this._angle = angle;
        this.data.onAngle?.(angle);
        this.refreshArrow(view);
        this.refreshPreview();
        PubSub.default.pub("showFloatTip", { level: "info", msg: `${angle}°` });
    }

    pointerUp(view: IView, event: PointerEvent): void {
        if (!this._dragging || (event.pointerType === "mouse" && event.button !== 0)) return;
        this._dragging = false;
        PubSub.default.pub("clearFloatTip");
        if (this.data.editing) this.refreshPreview();
        this.setHover(view, this.isOverArrow(view, event));
    }

    pointerOut(view: IView, _event: PointerEvent): void {
        if (!this._dragging) this.setHover(view, false);
    }

    mouseWheel(view: IView, _event: WheelEvent): void {
        this.trackCamera(view);
        view.update();
    }

    keyDown(_view: IView, event: KeyboardEvent): void {
        if (event.key === "Escape") {
            this.controller.cancel();
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.confirm();
        } else if (["-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(event.key)) {
            PubSub.default.pub("showInput", event.key, (text: string) => {
                const value = Number.parseFloat(text.replace(/°|deg$/i, ""));
                if (!Number.isFinite(value) || Math.abs(value) > MAX_REVOLVE_ANGLE) {
                    return Result.err("error.input.invalidNumber" as I18nKeys);
                }
                this.data.onAngle?.(value);
                this.setAngle(value);
                return Result.ok(text);
            });
        }
    }

    dispose(): void {
        this.cleanup();
    }

    /** Commits a non-zero angle; a zero sweep is no revolve. */
    private confirm() {
        if (Math.abs(this._angle) >= Precision.Angle) this.controller.success();
    }

    /** The mouse ray on the handle circle's plane, as an angle around the axis. */
    private projectAngle(view: IView, event: PointerEvent): number | undefined {
        const circle = this.circle;
        if (circle === undefined) return undefined;
        const plane = new Plane({ origin: circle.center, normal: circle.axis, xvec: circle.radial });
        const hit = plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        if (hit === undefined) return undefined;
        const angle = revolveAngleAt(circle, hit, this._angle);
        return angle === undefined ? undefined : Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
    }

    private arrowSegment(): { start: XYZ; end: XYZ; direction: XYZ } | undefined {
        if (this.circle === undefined) return undefined;
        const { point, direction } = revolveHandlePose(this.circle, this._angle);
        return {
            start: point,
            end: point.add(direction.multiply(this._arrowLength ?? ARROW_LENGTH)),
            direction,
        };
    }

    private isOverArrow(view: IView, event: PointerEvent): boolean {
        const segment = this.arrowSegment();
        if (segment === undefined) return false;
        const a = view.worldToScreen(segment.start);
        const b = view.worldToScreen(segment.end);
        return distanceToSegment(event.offsetX, event.offsetY, a, b) <= ARROW_HOVER_TOLERANCE;
    }

    private setHover(view: IView, hovered: boolean) {
        if (this._hovered === hovered) return;
        this._hovered = hovered;
        this.refreshArrow(view);
    }

    private refreshArrow(view?: IView) {
        const context = this.document.visual.context;
        for (const id of this._arrowIds) context.removeMesh(id);
        this._arrowIds = [];
        const segment = this.arrowSegment();
        if (segment !== undefined) {
            if (view !== undefined) {
                const length = pxSizedArrowLength(view, segment.start, segment.direction);
                if (length !== undefined) this._arrowLength = length;
            }
            const color = this._hovered || this._dragging ? ARROW_HOVER_COLOR : ARROW_COLOR;
            const meshes: ShapeMeshData[] = arrowMeshes(
                segment.start,
                segment.direction,
                this._arrowLength ?? ARROW_LENGTH,
                color,
            );
            for (const mesh of meshes) {
                this._arrowIds.push(context.displayMesh([mesh], { meshOpacity: 1, onTop: true }));
            }
        }
        this.document.visual.update();
    }

    private refreshPreview() {
        const context = this.document.visual.context;
        for (const id of this._previewIds) context.removeMesh(id);
        this._previewIds = [];
        this.restoreHidden();
        if (Math.abs(this._angle) >= Precision.Angle) {
            const preview = this.data.buildPreview(this._angle, this._dragging);
            for (const mesh of preview.meshes) {
                this._previewIds.push(context.displayMesh([mesh], { meshOpacity: 1 }));
            }
            for (const node of preview.hide ?? []) {
                context.setVisible(node, false);
                this._hidden.push(node);
            }
        }
        this.document.visual.update();
    }

    /** Nodes the preview stood in for go back to what their own flags say. */
    private restoreHidden() {
        for (const node of this._hidden) {
            this.document.visual.context.setVisible(node, node.visible && node.parentVisible);
        }
        this._hidden = [];
    }

    /** Rescale the arrow after zoom/pan/rotate (the wheel event arrives before the camera moves). */
    private trackCamera(view: IView) {
        if (this._cameraView === view) return;
        this._cameraView?.cameraController.removePropertyChanged(this.handleCameraChanged);
        this._cameraView = view;
        view.cameraController.onPropertyChanged(this.handleCameraChanged);
    }

    private readonly handleCameraChanged = () => {
        if (this._cameraView !== undefined && !this._cleaned) this.refreshArrow(this._cameraView);
    };

    private cleanup() {
        if (this._cleaned) return;
        this._cleaned = true;
        this._cameraView?.cameraController.removePropertyChanged(this.handleCameraChanged);
        this._cameraView = undefined;
        const context = this.document.visual.context;
        for (const id of [...this._arrowIds, ...this._previewIds]) context.removeMesh(id);
        this._arrowIds = [];
        this._previewIds = [];
        this.restoreHidden();
        PubSub.default.pub("clearFloatTip");
        PubSub.default.pub("clearInput");
        PubSub.default.pub("clearSelectionControl");
        this.data.onDone?.();
        this.document.visual.update();
    }
}
