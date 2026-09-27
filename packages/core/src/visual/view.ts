// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { IDisposable, IPropertyChanged } from "../foundation";
import type { I18nKeys } from "../i18n";
import type { Plane, Ray, XY, XYLike, XYZ, XYZLike } from "../math";
import type { INode } from "../model";
import type { INodeFilter, IShapeFilter } from "../selectionFilter";
import type { ShapeType } from "../shape";
import type { ICameraController } from "./cameraController";
import type { VisualShapeData } from "./detectedData";
import type { IVisualObject } from "./visualObject";

export const ViewModes = ["solid", "wireframe", "solidAndWireframe"] as const;

export type ViewMode = (typeof ViewModes)[number];

export const ViewModeI18nKeys = {
    [ViewModes[0]]: "viewport.mode.solid",
    [ViewModes[1]]: "viewport.mode.wireframe",
    [ViewModes[2]]: "viewport.mode.solidAndWireframe",
} satisfies Record<
    ViewMode,
    Extract<I18nKeys, "viewport.mode.solid" | "viewport.mode.wireframe" | "viewport.mode.solidAndWireframe">
>;

export type HtmlTextOptions = {
    hideDelete?: boolean;
    className?: string;
    center?: XYLike;
    onDispose?: () => void;
    /** Re-enables pointer events (suppresses the noEvent class of hideDelete) and wires DOM handlers. */
    interactive?: boolean;
    onClick?: (event: MouseEvent) => void;
    onDoubleClick?: (event: MouseEvent) => void;
    onMouseEnter?: (event: MouseEvent) => void;
    onMouseLeave?: (event: MouseEvent) => void;
    onCreated?: (element: HTMLElement) => void;
};

/** Longest side of the document thumbnail taken on every save (home page, cloud versions). */
export const DOCUMENT_THUMBNAIL_MAX_SIZE = 512;

export interface IView extends IPropertyChanged, IDisposable {
    readonly document: IDocument;
    readonly cameraController: ICameraController;
    get isClosed(): boolean;
    get width(): number;
    get height(): number;
    get dom(): HTMLElement | undefined;
    mode: ViewMode;
    name: string;
    workplane: Plane;
    update(): void;
    up(): XYZ;
    /** The view as a PNG data URL (transparent where nothing is drawn), scaled down to fit `maxSize`. */
    toImage(maxSize?: number): string;
    /**
     * The view freshly rendered into a 2D canvas over the viewport's background colour, scaled down
     * to fit `maxSize` (never up); the caller encodes it (asynchronously, with `toBlob`).
     * `undefined` when the browser gives no 2D context.
     */
    snapshot(maxSize?: number): HTMLCanvasElement | undefined;
    direction(): XYZ;
    rayAt(mx: number, my: number): Ray;
    screenToWorld(mx: number, my: number): XYZ;
    worldToScreen(point: XYZ): XY;
    isolate(nodes: INode[]): void;
    unisolate(): void;
    resize(width: number, heigth: number): void;
    setDom(element: HTMLElement): void;
    htmlText(text: string, point: XYZLike, options?: HtmlTextOptions): IDisposable;
    close(): void;
    detectVisual(x: number, y: number, nodeFilter?: INodeFilter): IVisualObject[];
    detectVisualRect(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        nodeFilter?: INodeFilter,
    ): IVisualObject[];
    detectShapes(
        shapeType: ShapeType,
        x: number,
        y: number,
        shapeFilter?: IShapeFilter,
        nodeFilter?: INodeFilter,
    ): VisualShapeData[];
    detectShapesRect(
        shapeType: ShapeType,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        shapeFilter?: IShapeFilter,
        nodeFilter?: INodeFilter,
    ): VisualShapeData[];
}

export function screenDistance(view: IView, mx: number, my: number, point: XYZ) {
    const xy = view.worldToScreen(point);
    const dx = xy.x - mx;
    const dy = xy.y - my;
    return Math.sqrt(dx * dx + dy * dy);
}
