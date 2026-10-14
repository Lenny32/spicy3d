// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";

/** A 2D point in millimetres, Y up (the SVG's Y axis is flipped on import). */
export interface SvgPoint {
    readonly x: number;
    readonly y: number;
}

/** A straight segment or a cubic Bézier; quadratics and arcs are converted to cubics. */
export type SvgSegment =
    | { readonly kind: "line"; readonly points: readonly [SvgPoint, SvgPoint] }
    | { readonly kind: "cubic"; readonly points: readonly [SvgPoint, SvgPoint, SvgPoint, SvgPoint] };

/** A chain of connected segments; `closed` = it ends where it starts. */
export interface SvgSubpath {
    readonly segments: readonly SvgSegment[];
    readonly closed: boolean;
}

/** The outlines of one SVG element (a `<path>`, `<rect>`, ...), in document order. */
export interface SvgElementOutline {
    readonly tag: string;
    readonly id?: string;
    readonly subpaths: readonly SvgSubpath[];
}

export interface SvgDrawing {
    readonly elements: readonly SvgElementOutline[];
    /** Bounds of every outline, in millimetres; `undefined` for a drawing without geometry. */
    readonly bounds?: { readonly min: SvgPoint; readonly max: SvgPoint };
    /** Elements that hold drawing content but cannot be imported (`<text>`, `<image>`). */
    readonly skipped: readonly string[];
}

/** CSS reference pixel: SVG user units without a viewBox are 1/96 inch. */
const MM_PER_PX = 25.4 / 96;
const UNIT_MM: Readonly<Record<string, number>> = {
    "": MM_PER_PX,
    px: MM_PER_PX,
    mm: 1,
    cm: 10,
    in: 25.4,
    pt: 25.4 / 72,
    pc: 25.4 / 6,
    q: 0.25,
    em: 16 * MM_PER_PX,
    ex: 8 * MM_PER_PX,
};
const SKIPPED_CONTAINERS = new Set([
    "defs",
    "symbol",
    "clippath",
    "mask",
    "pattern",
    "marker",
    "metadata",
    "title",
    "desc",
    "style",
    "script",
    "lineargradient",
    "radialgradient",
    "filter",
]);
const UNSUPPORTED_CONTENT = new Set(["text", "image", "foreignobject"]);
/** Closing gap under which an unclosed subpath still counts as closed, in user units. */
const CLOSE_TOLERANCE = 1e-6;
const MAX_USE_DEPTH = 16;

/** Row-major 2D affine matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function multiply(m: Affine, n: Affine): Affine {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function apply(m: Affine, p: SvgPoint): SvgPoint {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * Reads an SVG document into outlines in millimetres: `<path>`, `<rect>`, `<circle>`,
 * `<ellipse>`, `<line>`, `<polyline>`, `<polygon>` and `<use>`, through nested `<g>`/`<svg>`
 * and their `transform`s. The root's `width`/`height` + `viewBox` give the physical size (user
 * units without them are CSS pixels, 96 per inch). Y is flipped so the drawing reads upright
 * in the XY plane, its bottom-left page corner at the origin. Hidden elements
 * (`display="none"`) and definitions are left out; text and images are reported in `skipped`.
 */
export function parseSvg(text: string): Result<SvgDrawing> {
    let root: Element | null;
    try {
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        if (doc.getElementsByTagName("parsererror").length > 0) return Result.err("Invalid SVG file");
        root = doc.documentElement;
    } catch {
        return Result.err("Invalid SVG file");
    }
    if (!root || localName(root) !== "svg") return Result.err("Not an SVG file");

    const reader = new SvgReader(root);
    const page = reader.pageTransform(root);
    if (!page.isOk) return Result.err(page.error);
    reader.readChildren(root, page.value, 0);
    return Result.ok({
        elements: reader.elements,
        bounds: boundsOf(reader.elements),
        skipped: reader.skipped,
    });
}

class SvgReader {
    readonly elements: SvgElementOutline[] = [];
    readonly skipped: string[] = [];
    private readonly ids = new Map<string, Element>();

    constructor(root: Element) {
        for (const element of root.getElementsByTagName("*")) {
            const id = element.getAttribute("id");
            if (id && !this.ids.has(id)) this.ids.set(id, element);
        }
    }

    /** User units → millimetres, Y flipped about the page's bottom edge. */
    pageTransform(root: Element): Result<Affine> {
        const viewBox = parseNumbers(root.getAttribute("viewBox") ?? "");
        const width = parseLength(root.getAttribute("width"));
        const height = parseLength(root.getAttribute("height"));
        if (width === null || height === null) return Result.err("Unsupported SVG width or height");
        const hasViewBox = viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;
        let toMm: Affine = [MM_PER_PX, 0, 0, MM_PER_PX, 0, 0];
        let pageHeight: number | undefined = height ?? (hasViewBox ? viewBox[3] * MM_PER_PX : undefined);
        if (hasViewBox) {
            const [minX, minY, vbWidth, vbHeight] = viewBox;
            const w = width ?? (height !== undefined ? (height * vbWidth) / vbHeight : vbWidth * MM_PER_PX);
            const h = height ?? (width !== undefined ? (width * vbHeight) / vbWidth : vbHeight * MM_PER_PX);
            pageHeight = h;
            toMm = viewBoxTransform(root.getAttribute("preserveAspectRatio"), viewBox, minX, minY, w, h);
        }
        const flip: Affine = pageHeight === undefined ? [1, 0, 0, -1, 0, 0] : [1, 0, 0, -1, 0, pageHeight];
        return Result.ok(multiply(flip, toMm));
    }

    readChildren(parent: Element, transform: Affine, useDepth: number) {
        for (const child of parent.children) this.readElement(child, transform, useDepth);
    }

    private readElement(element: Element, parentTransform: Affine, useDepth: number) {
        const tag = localName(element);
        if (SKIPPED_CONTAINERS.has(tag) || isHidden(element)) return;
        if (UNSUPPORTED_CONTENT.has(tag)) {
            this.skipped.push(tag);
            return;
        }
        const own = parseTransform(element.getAttribute("transform") ?? "");
        let transform = multiply(parentTransform, own);
        if (tag === "g" || tag === "a" || tag === "switch") {
            this.readChildren(element, transform, useDepth);
            return;
        }
        if (tag === "svg") {
            const x = parseUserLength(element.getAttribute("x"));
            const y = parseUserLength(element.getAttribute("y"));
            transform = multiply(transform, [1, 0, 0, 1, x, y]);
            const viewBox = parseNumbers(element.getAttribute("viewBox") ?? "");
            const w = parseUserLength(element.getAttribute("width"), Number.NaN);
            const h = parseUserLength(element.getAttribute("height"), Number.NaN);
            if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 && w > 0 && h > 0) {
                const preserve = element.getAttribute("preserveAspectRatio");
                transform = multiply(
                    transform,
                    viewBoxTransform(preserve, viewBox, viewBox[0], viewBox[1], w, h),
                );
            }
            this.readChildren(element, transform, useDepth);
            return;
        }
        if (tag === "use") {
            this.readUse(element, transform, useDepth);
            return;
        }
        const subpaths = shapeSubpaths(tag, element);
        if (subpaths === undefined) return;
        const mapped = subpaths
            .map((subpath) => transformSubpath(subpath, transform))
            .filter((subpath) => subpath.segments.length > 0);
        if (mapped.length === 0) return;
        const id = element.getAttribute("id") ?? undefined;
        this.elements.push({ tag, ...(id && { id }), subpaths: mapped });
    }

    private readUse(element: Element, transform: Affine, useDepth: number) {
        if (useDepth >= MAX_USE_DEPTH) return;
        const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
        const target = href.startsWith("#") ? this.ids.get(href.slice(1)) : undefined;
        if (!target) return;
        const x = parseUserLength(element.getAttribute("x"));
        const y = parseUserLength(element.getAttribute("y"));
        const placed = multiply(transform, [1, 0, 0, 1, x, y]);
        // A <symbol> is a template: its children are drawn, the symbol itself is skipped.
        if (localName(target) === "symbol") this.readChildren(target, placed, useDepth + 1);
        else this.readElement(target, placed, useDepth + 1);
    }
}

function localName(element: Element): string {
    return (element.localName ?? element.tagName).toLowerCase();
}

function isHidden(element: Element): boolean {
    if (element.getAttribute("display") === "none") return true;
    const style = element.getAttribute("style") ?? "";
    return /(^|;)\s*display\s*:\s*none\s*(;|$)/i.test(style);
}

/** The root `width`/`height` in millimetres; `undefined` when absent or relative, `null` when invalid. */
function parseLength(value: string | null): number | undefined | null {
    if (value === null || value.trim() === "" || value.trim().endsWith("%")) return undefined;
    const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value);
    if (!match) return null;
    const factor = UNIT_MM[match[2].toLowerCase()];
    const length = Number(match[1]);
    if (factor === undefined || !(length > 0)) return null;
    return length * factor;
}

/** A length inside the drawing, in user units (absolute units converted at 96 px per inch). */
function parseUserLength(value: string | null, fallback = 0): number {
    if (value === null) return fallback;
    const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value);
    if (!match) return fallback;
    const factor = UNIT_MM[match[2].toLowerCase()];
    return factor === undefined ? fallback : (Number(match[1]) * factor) / MM_PER_PX;
}

function viewBoxTransform(
    preserveAspectRatio: string | null,
    viewBox: number[],
    minX: number,
    minY: number,
    width: number,
    height: number,
): Affine {
    let sx = width / viewBox[2];
    let sy = height / viewBox[3];
    let tx = -minX * sx;
    let ty = -minY * sy;
    const [align = "xMidYMid", meetOrSlice = "meet"] = (preserveAspectRatio ?? "").trim().split(/\s+/);
    if (align !== "none") {
        const scale = meetOrSlice === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
        const extraX = width - viewBox[2] * scale;
        const extraY = height - viewBox[3] * scale;
        const alignX = align.includes("xMid") ? 0.5 : align.includes("xMax") ? 1 : 0;
        const alignY = align.includes("YMid") ? 0.5 : align.includes("YMax") ? 1 : 0;
        sx = scale;
        sy = scale;
        tx = -minX * scale + extraX * alignX;
        ty = -minY * scale + extraY * alignY;
    }
    return [sx, 0, 0, sy, tx, ty];
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function parseNumbers(text: string): number[] {
    return (text.match(NUMBER) ?? []).map(Number);
}

/** The `transform` attribute's list, composed left to right. */
function parseTransform(text: string): Affine {
    let result: Affine = IDENTITY;
    for (const match of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
        const args = parseNumbers(match[2]);
        result = multiply(result, transformOf(match[1], args));
    }
    return result;
}

function transformOf(name: string, args: number[]): Affine {
    switch (name) {
        case "matrix":
            return args.length === 6 ? (args as unknown as Affine) : IDENTITY;
        case "translate":
            return [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        case "scale":
            return [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        case "rotate": {
            const angle = ((args[0] ?? 0) * Math.PI) / 180;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const rotation: Affine = [cos, sin, -sin, cos, 0, 0];
            if (args.length < 3) return rotation;
            const [, cx, cy] = args;
            return multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
        }
        case "skewX":
            return [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        case "skewY":
            return [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        default:
            return IDENTITY;
    }
}

/** `segment` with every point mapped through `map(point, index)`. */
function mapSegment(segment: SvgSegment, map: (point: SvgPoint, index: number) => SvgPoint): SvgSegment {
    const [a, b, c, d] = segment.points.map(map);
    return segment.kind === "line"
        ? { kind: "line", points: [a, b] }
        : { kind: "cubic", points: [a, b, c, d] };
}

function transformSubpath(subpath: SvgSubpath, m: Affine): SvgSubpath {
    const segments = subpath.segments.map((segment) => mapSegment(segment, (p) => apply(m, p)));
    return { segments, closed: subpath.closed };
}

function attr(element: Element, name: string): number {
    return parseUserLength(element.getAttribute(name));
}

/** The element's outlines in its own user units; `undefined` for anything that draws nothing. */
function shapeSubpaths(tag: string, element: Element): SvgSubpath[] | undefined {
    switch (tag) {
        case "path":
            return parsePathData(element.getAttribute("d") ?? "");
        case "rect":
            return rectSubpaths(element);
        case "circle": {
            const r = attr(element, "r");
            return r > 0 ? [ellipseSubpath(attr(element, "cx"), attr(element, "cy"), r, r)] : undefined;
        }
        case "ellipse": {
            const rx = attr(element, "rx");
            const ry = attr(element, "ry");
            return rx > 0 && ry > 0
                ? [ellipseSubpath(attr(element, "cx"), attr(element, "cy"), rx, ry)]
                : undefined;
        }
        case "line":
            return [
                polylineSubpath(
                    [
                        { x: attr(element, "x1"), y: attr(element, "y1") },
                        { x: attr(element, "x2"), y: attr(element, "y2") },
                    ],
                    false,
                ),
            ];
        case "polyline":
        case "polygon": {
            const numbers = parseNumbers(element.getAttribute("points") ?? "");
            const points: SvgPoint[] = [];
            for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
            return points.length >= 2 ? [polylineSubpath(points, tag === "polygon")] : undefined;
        }
        default:
            return undefined;
    }
}

function rectSubpaths(element: Element): SvgSubpath[] | undefined {
    const x = attr(element, "x");
    const y = attr(element, "y");
    const width = attr(element, "width");
    const height = attr(element, "height");
    if (!(width > 0 && height > 0)) return undefined;
    const rxAttr = element.getAttribute("rx");
    const ryAttr = element.getAttribute("ry");
    let rx = rxAttr !== null ? attr(element, "rx") : ryAttr !== null ? attr(element, "ry") : 0;
    let ry = ryAttr !== null ? attr(element, "ry") : rx;
    rx = Math.min(Math.max(rx, 0), width / 2);
    ry = Math.min(Math.max(ry, 0), height / 2);
    if (rx === 0 || ry === 0) {
        return [
            polylineSubpath(
                [
                    { x, y },
                    { x: x + width, y },
                    { x: x + width, y: y + height },
                    { x, y: y + height },
                ],
                true,
            ),
        ];
    }
    const builder = new SubpathBuilder({ x: x + rx, y });
    builder.lineTo({ x: x + width - rx, y });
    builder.arcTo(rx, ry, 0, false, true, { x: x + width, y: y + ry });
    builder.lineTo({ x: x + width, y: y + height - ry });
    builder.arcTo(rx, ry, 0, false, true, { x: x + width - rx, y: y + height });
    builder.lineTo({ x: x + rx, y: y + height });
    builder.arcTo(rx, ry, 0, false, true, { x, y: y + height - ry });
    builder.lineTo({ x, y: y + ry });
    builder.arcTo(rx, ry, 0, false, true, { x: x + rx, y });
    return [builder.finish(true)];
}

function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): SvgSubpath {
    const builder = new SubpathBuilder({ x: cx + rx, y: cy });
    builder.arcTo(rx, ry, 0, false, true, { x: cx, y: cy + ry });
    builder.arcTo(rx, ry, 0, false, true, { x: cx - rx, y: cy });
    builder.arcTo(rx, ry, 0, false, true, { x: cx, y: cy - ry });
    builder.arcTo(rx, ry, 0, false, true, { x: cx + rx, y: cy });
    return builder.finish(true);
}

function polylineSubpath(points: SvgPoint[], closed: boolean): SvgSubpath {
    const builder = new SubpathBuilder(points[0]);
    for (const point of points.slice(1)) builder.lineTo(point);
    return builder.finish(closed);
}

function samePoint(a: SvgPoint, b: SvgPoint, tolerance = 0): boolean {
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/** Accumulates one subpath, dropping zero-length segments. */
class SubpathBuilder {
    private readonly segments: SvgSegment[] = [];
    current: SvgPoint;

    constructor(readonly start: SvgPoint) {
        this.current = start;
    }

    get isEmpty() {
        return this.segments.length === 0;
    }

    lineTo(to: SvgPoint) {
        if (!samePoint(this.current, to)) this.segments.push({ kind: "line", points: [this.current, to] });
        this.current = to;
    }

    cubicTo(c1: SvgPoint, c2: SvgPoint, to: SvgPoint) {
        const from = this.current;
        if (samePoint(from, to) && samePoint(from, c1) && samePoint(from, c2)) return;
        this.segments.push({ kind: "cubic", points: [from, c1, c2, to] });
        this.current = to;
    }

    /** SVG elliptical arc, as cubics of at most 90° each. */
    arcTo(rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, to: SvgPoint) {
        for (const [c1, c2, end] of arcToCubics(this.current, rx, ry, rotation, largeArc, sweep, to)) {
            if (end === to && c1 === this.current && c2 === to) this.lineTo(to);
            else this.cubicTo(c1, c2, end);
        }
        this.current = to;
    }

    finish(closed: boolean): SvgSubpath {
        const isClosed =
            closed || (this.segments.length > 1 && samePoint(this.current, this.start, CLOSE_TOLERANCE));
        if (isClosed && !samePoint(this.current, this.start)) {
            if (samePoint(this.current, this.start, CLOSE_TOLERANCE)) this.snapEndToStart();
            else this.lineTo(this.start);
        }
        return { segments: this.segments, closed: isClosed && this.segments.length > 0 };
    }

    /** Moves the last segment's end onto the start so the outline closes exactly. */
    private snapEndToStart() {
        const last = this.segments.pop();
        if (!last) return;
        const end = last.points.length - 1;
        this.segments.push(mapSegment(last, (point, index) => (index === end ? this.start : point)));
        this.current = this.start;
    }
}

/**
 * Endpoint → center parameterization (SVG 2, appendix B.2.4), split into ≤ 90° cubics. A
 * zero radius is a straight line: returned as one cubic whose controls are its ends, marked by
 * identity so the caller emits a line instead.
 */
function arcToCubics(
    from: SvgPoint,
    rxIn: number,
    ryIn: number,
    rotationDeg: number,
    largeArc: boolean,
    sweep: boolean,
    to: SvgPoint,
): [SvgPoint, SvgPoint, SvgPoint][] {
    if (samePoint(from, to)) return [];
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (rx === 0 || ry === 0) return [[from, to, to]];
    const phi = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (from.x - to.x) / 2;
    const dy = (from.y - to.y) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }
    const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let factor = Math.sqrt(Math.max(0, numerator / denominator));
    if (largeArc === sweep) factor = -factor;
    const cx1 = (factor * rx * y1) / ry;
    const cy1 = (-factor * ry * x1) / rx;
    const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
    const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number) =>
        Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;

    const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
    const step = delta / count;
    const k = (4 / 3) * Math.tan(step / 4);
    const point = (t: number): SvgPoint => {
        const ex = rx * Math.cos(t);
        const ey = ry * Math.sin(t);
        return { x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey };
    };
    const derivative = (t: number): SvgPoint => {
        const ex = -rx * Math.sin(t);
        const ey = ry * Math.cos(t);
        return { x: cos * ex - sin * ey, y: sin * ex + cos * ey };
    };
    const result: [SvgPoint, SvgPoint, SvgPoint][] = [];
    let start = from;
    for (let i = 0; i < count; i++) {
        const t0 = theta1 + i * step;
        const t1 = t0 + step;
        const d0 = derivative(t0);
        const d1 = derivative(t1);
        const end = i === count - 1 ? to : point(t1);
        result.push([
            { x: start.x + k * d0.x, y: start.y + k * d0.y },
            { x: end.x - k * d1.x, y: end.y - k * d1.y },
            end,
        ]);
        start = end;
    }
    return result;
}

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|[\s,]+|(.)/g;

/** The `d` attribute of a `<path>` as subpaths; parsing stops at the first error, as browsers do. */
export function parsePathData(d: string): SvgSubpath[] {
    // Numbers stay raw text until taken: "011" in an arc can be the flags 0, 1 and a number.
    const tokens: { command?: string; number?: string }[] = [];
    for (const match of d.matchAll(PATH_TOKEN)) {
        if (match[3] !== undefined) break;
        if (match[1]) tokens.push({ command: match[1] });
        else if (match[2]) tokens.push({ number: match[2] });
    }
    const subpaths: SvgSubpath[] = [];
    let builder: SubpathBuilder | undefined;
    let current: SvgPoint = { x: 0, y: 0 };
    let lastControl: SvgPoint | undefined;
    let lastCommand = "";
    let index = 0;
    let command = "";

    const flush = (closed: boolean) => {
        if (builder && !builder.isEmpty) subpaths.push(builder.finish(closed));
        builder = undefined;
    };
    const ensureBuilder = () => {
        builder ??= new SubpathBuilder(current);
        return builder;
    };
    const hasNumbers = (n: number) => {
        for (let i = 0; i < n; i++) if (tokens[index + i]?.number === undefined) return false;
        return true;
    };
    const take = () => Number(tokens[index++].number);
    // Arc flags may be written without separators ("a1 1 0 011 1" → 0, 1, 1).
    const takeFlag = (): number | undefined => {
        const text = tokens[index]?.number;
        if (text === undefined) return undefined;
        if (text === "0" || text === "1") return take();
        if (/^[01]\d/.test(text)) {
            tokens.splice(index, 1, { number: text[0] }, { number: text.slice(1) });
            return take();
        }
        return undefined;
    };

    while (index < tokens.length) {
        const token = tokens[index];
        if (token.command) {
            command = token.command;
            index++;
        } else if (!command || command === "Z" || command === "z") {
            break;
        } else if (command === "M") {
            command = "L";
        } else if (command === "m") {
            command = "l";
        }
        const relative = command === command.toLowerCase();
        const base = relative ? current : { x: 0, y: 0 };
        const upper = command.toUpperCase();
        if (upper === "Z") {
            const start = builder?.start ?? current;
            flush(true);
            current = start;
            lastControl = undefined;
            lastCommand = "Z";
            continue;
        }
        let control: SvgPoint | undefined;
        if (upper === "M") {
            if (!hasNumbers(2)) break;
            flush(false);
            current = { x: base.x + take(), y: base.y + take() };
            builder = new SubpathBuilder(current);
        } else if (upper === "L") {
            if (!hasNumbers(2)) break;
            current = { x: base.x + take(), y: base.y + take() };
            ensureBuilder().lineTo(current);
        } else if (upper === "H") {
            if (!hasNumbers(1)) break;
            current = { x: (relative ? current.x : 0) + take(), y: current.y };
            ensureBuilder().lineTo(current);
        } else if (upper === "V") {
            if (!hasNumbers(1)) break;
            current = { x: current.x, y: (relative ? current.y : 0) + take() };
            ensureBuilder().lineTo(current);
        } else if (upper === "C" || upper === "S") {
            const n = upper === "C" ? 6 : 4;
            if (!hasNumbers(n)) break;
            const c1 =
                upper === "C"
                    ? { x: base.x + take(), y: base.y + take() }
                    : lastControl && "CS".includes(lastCommand)
                      ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y }
                      : current;
            control = { x: base.x + take(), y: base.y + take() };
            const to = { x: base.x + take(), y: base.y + take() };
            ensureBuilder().cubicTo(c1, control, to);
            current = to;
        } else if (upper === "Q" || upper === "T") {
            const n = upper === "Q" ? 4 : 2;
            if (!hasNumbers(n)) break;
            control =
                upper === "Q"
                    ? { x: base.x + take(), y: base.y + take() }
                    : lastControl && "QT".includes(lastCommand)
                      ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y }
                      : current;
            const to = { x: base.x + take(), y: base.y + take() };
            const c1 = {
                x: current.x + (2 / 3) * (control.x - current.x),
                y: current.y + (2 / 3) * (control.y - current.y),
            };
            const c2 = { x: to.x + (2 / 3) * (control.x - to.x), y: to.y + (2 / 3) * (control.y - to.y) };
            ensureBuilder().cubicTo(c1, c2, to);
            current = to;
        } else if (upper === "A") {
            if (!hasNumbers(3)) break;
            const rx = take();
            const ry = take();
            const rotation = take();
            const largeArc = takeFlag();
            const sweep = takeFlag();
            if (largeArc === undefined || sweep === undefined || !hasNumbers(2)) break;
            const to = { x: base.x + take(), y: base.y + take() };
            ensureBuilder().arcTo(rx, ry, rotation, largeArc === 1, sweep === 1, to);
            current = to;
        } else {
            break;
        }
        lastControl = control;
        lastCommand = upper;
    }
    flush(false);
    return subpaths;
}

function boundsOf(elements: readonly SvgElementOutline[]): SvgDrawing["bounds"] {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const element of elements) {
        for (const subpath of element.subpaths) {
            for (const segment of subpath.segments) {
                for (const point of segment.kind === "line"
                    ? segment.points
                    : flattenCubic(segment.points, 16)) {
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                }
            }
        }
    }
    if (minX > maxX) return undefined;
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** `count + 1` points along a cubic, ends included. */
export function flattenCubic(points: readonly SvgPoint[], count: number): SvgPoint[] {
    const [p0, p1, p2, p3] = points;
    const result: SvgPoint[] = [];
    for (let i = 0; i <= count; i++) {
        const t = i / count;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        result.push({
            x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
            y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
        });
    }
    return result;
}
