// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { AsyncController } from "../foundation";
import type { INodeFilter, IShapeFilter } from "../selectionFilter";
import type { IShape, ShapeType } from "../shape";
import { type IView, type VisualShapeData, type VisualState, VisualStates } from "../visual";
import { isToggleSelectEvent, SelectionHandler } from "./selectionEventHandler";

export abstract class ShapeSelectionHandler extends SelectionHandler {
    protected _highlights: VisualShapeData[] | undefined;
    private _detectAtMouse: VisualShapeData[] | undefined;
    private _lockDetected: IShape | undefined;

    highlightState: VisualState = VisualStates.edgeHighlight;

    /** In multi mode, finish the pick automatically once this returns true. */
    canFinish?: (selected: VisualShapeData[]) => boolean;

    /** Reorders what the pointer detects; index 0 is what gets highlighted and picked. */
    sortDetected?: (detected: VisualShapeData[]) => VisualShapeData[];

    constructor(
        document: IDocument,
        readonly shapeType: ShapeType,
        multiMode: boolean,
        controller?: AsyncController,
        readonly shapefilter?: IShapeFilter,
        readonly nodeFilter?: INodeFilter,
    ) {
        super(document, multiMode, controller);
    }

    private getDetecteds(view: IView, event: PointerEvent) {
        if (
            this.rect &&
            Math.abs(this.mouse.x - event.offsetX) > 3 &&
            Math.abs(this.mouse.y - event.offsetY) > 3
        ) {
            return view.detectShapesRect(
                this.shapeType,
                this.mouse.x,
                this.mouse.y,
                event.offsetX,
                event.offsetY,
                this.shapefilter,
                this.nodeFilter,
            );
        }
        const detecteds = view.detectShapes(
            this.shapeType,
            event.offsetX,
            event.offsetY,
            this.shapefilter,
            this.nodeFilter,
        );
        this._detectAtMouse = this.sortDetected?.(detecteds) ?? detecteds;
        const detected = this.getDetecting();
        return detected ? [detected] : [];
    }

    override pointerMove(view: IView, event: PointerEvent): void {
        super.pointerMove(view, event);
        this._lockDetected = undefined;
    }

    protected override setHighlight(view: IView, event: PointerEvent) {
        const detecteds = this.getDetecteds(view, event);
        this.highlightDetecteds(view, detecteds);
    }

    protected highlightDetecteds(view: IView, detecteds: VisualShapeData[]) {
        this.cleanHighlights();
        detecteds.forEach((x) => {
            this.document.visual.highlighter.addState(
                x.owner,
                this.highlightState,
                x.shape.shapeType,
                ...x.indexes,
            );
        });
        this._highlights = detecteds;
        view.update();
    }

    protected cleanHighlights() {
        this._highlights?.forEach((x) => {
            this.document.visual.highlighter.removeState(
                x.owner,
                this.highlightState,
                x.shape.shapeType,
                ...x.indexes,
            );
        });
        this._highlights = undefined;
    }

    protected highlightNext(view: IView) {
        if (this._detectAtMouse && this._detectAtMouse.length > 1) {
            const index = this._lockDetected
                ? (this.getDetcedtingIndex() + 1) % this._detectAtMouse.length
                : 1;
            this._lockDetected = this._detectAtMouse[index].shape;
            const detected = this.getDetecting();
            if (detected) this.highlightDetecteds(view, [detected]);
        }
    }

    protected override canFinishSelection(): boolean {
        return this.canFinish?.(this.document.selection.getSelectedShapes()) ?? false;
    }

    private getDetecting() {
        if (this._detectAtMouse) {
            const index = this._lockDetected ? this.getDetcedtingIndex() : 0;
            return this._detectAtMouse[index];
        }
        return undefined;
    }

    private getDetcedtingIndex() {
        return this._detectAtMouse?.findIndex((x) => this._lockDetected === x.shape) ?? -1;
    }
}

/**
 * Picks sub-shapes. Multi mode toggles on every click, as it always has (edge picks rely on
 * it), so Ctrl/Cmd+click toggles there too. With `toggleWithModifier` a single pick also
 * toggles on Ctrl/Cmd+click (`isToggleSelectEvent`) and stays open, so several shapes can be
 * gathered before a plain click (which replaces the selection with the clicked shape and
 * finishes) or Enter (which finishes with the selection as it is).
 */
export class SubshapeSelectionHandler extends ShapeSelectionHandler {
    selectedState: VisualState = VisualStates.edgeSelected;

    /** Single mode: Ctrl/Cmd+click toggles and keeps the pick open (see `PickShapeOptions`). */
    toggleWithModifier = false;

    protected override select(view: IView, event: PointerEvent): number {
        if (!this._highlights?.length) {
            return 0;
        }

        return this.document.selection.setSelectedShapes(
            this._highlights,
            this.selectedState,
            this.multiMode || this.modifierToggles(event),
        );
    }

    protected override keepsSelecting(event: PointerEvent): boolean {
        return this.modifierToggles(event);
    }

    private modifierToggles(event: PointerEvent): boolean {
        return this.toggleWithModifier && isToggleSelectEvent(event);
    }
}
