// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import type { INode } from "../model";
import type { IEventHandler } from "./eventHandler";
import type { IHighlighter } from "./highlighter";
import type { IMeshExporter } from "./meshExporter";
import type { IView } from "./view";
import type { IVisual } from "./visual";
import type { IVisualContext } from "./visualContext";
import type { IVisualObject } from "./visualObject";

// The visual of a document nobody looks at: a merged version being rebuilt to validate it (the
// merge's validation pass), never shown. Every display call is a no-op; it cannot make views.

const noEvents: IEventHandler = {
    isEnabled: false,
    pointerMove: () => {},
    pointerDown: () => {},
    pointerUp: () => {},
    keyDown: () => {},
    dispose: () => {},
};

const noHighlights: IHighlighter = {
    getState: () => undefined,
    clear: () => {},
    resetState: () => {},
    addState: () => {},
    removeState: () => {},
    highlightMesh: () => 0,
    removeHighlightMesh: () => {},
};

const noExport: IMeshExporter = {
    exportToStl: () => Result.err("no visual"),
    exportToPly: () => Result.err("no visual"),
    exportToObj: () => Result.err("no visual"),
};

class NullVisualContext implements IVisualContext {
    get shapeCount(): number {
        return 0;
    }
    addVisualObject(_object: IVisualObject): void {}
    boundingBoxIntersectFilter(): IVisualObject[] {
        return [];
    }
    removeVisualObject(_object: IVisualObject): void {}
    addNode(_nodes: INode[]): void {}
    removeNode(_nodes: INode[]): void {}
    getVisual(_node: INode): IVisualObject | undefined {
        return undefined;
    }
    getNode(_visual: IVisualObject): INode | undefined {
        return undefined;
    }
    redrawNode(_nodes: INode[]): void {}
    setVisible(_node: INode, _visible: boolean): void {}
    setNodeOnTop(_nodes: INode[], _onTop: boolean): void {}
    visuals(): IVisualObject[] {
        return [];
    }
    displayMesh(): number {
        return 0;
    }
    setMeshColor(): void {}
    removeMesh(): void {}
    displayInstancedMesh(): number {
        return 0;
    }
    displayLineSegments(): number {
        return 0;
    }
    setPosition(): void {}
    setInstanceMatrix(): void {}
    acquireAnalysisClip(): () => void {
        return () => {};
    }
    acquireAnalysisAppearance(): () => void {
        return () => {};
    }
    dispose(): void {}
}

/** A visual that displays nothing (a headless document). */
export class NullVisual implements IVisual {
    readonly context: IVisualContext = new NullVisualContext();
    readonly highlighter = noHighlights;
    readonly meshExporter = noExport;
    viewHandler = noEvents;
    defaultEventHandler = noEvents;
    eventHandler = noEvents;

    constructor(readonly document: IDocument) {}

    update(): void {}

    createView(): IView {
        throw new Error("A headless document has no views");
    }

    dispose(): void {}
}
