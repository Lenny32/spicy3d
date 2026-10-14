// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import type { IEdge, IShape, IWire } from "../shape/shape";
import type { IShapeFactory } from "../shape/shapeFactory";
import { flattenCubic, type SvgDrawing, type SvgPoint, type SvgSubpath } from "./svgParser";

export interface SvgShapeOptions {
    /** Uniform scale about the origin applied to the millimetre coordinates; 1 when omitted. */
    readonly scale?: number;
    /**
     * Closed outlines become planar faces (holes nested even-odd, like a font's "O"), ready to
     * extrude; `false` keeps every outline as a wire. Open outlines are always wires.
     */
    readonly faces?: boolean;
}

export interface SvgShape {
    readonly shape: IShape;
    readonly faceCount: number;
    readonly wireCount: number;
    /** Outlines the kernel refused (self-touching or degenerate), left out of `shape`. */
    readonly failed: number;
}

interface Ring {
    readonly wire: IWire;
    readonly polygon: SvgPoint[];
    readonly area: number;
    depth: number;
}

/**
 * Builds the drawing on the XY plane: one face per closed outline with its holes (each SVG
 * element on its own — overlapping elements stay separate faces), plus a wire per open
 * outline, all in one compound (or the single shape when there is only one).
 */
export function buildSvgShape(
    factory: IShapeFactory,
    drawing: SvgDrawing,
    options: SvgShapeOptions = {},
): Result<SvgShape> {
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) return Result.err("The scale must be a positive number");
    const makeFaces = options.faces ?? true;
    const shapes: IShape[] = [];
    let faceCount = 0;
    let wireCount = 0;
    let failed = 0;
    for (const element of drawing.elements) {
        const rings: Ring[] = [];
        for (const subpath of element.subpaths) {
            const wire = buildWire(factory, subpath, scale);
            if (!wire.isOk) {
                failed++;
                continue;
            }
            if (makeFaces && subpath.closed) {
                const polygon = flatten(subpath, scale);
                rings.push({ wire: wire.value, polygon, area: Math.abs(signedArea(polygon)), depth: 0 });
            } else {
                shapes.push(wire.value);
                wireCount++;
            }
        }
        const faces = buildFaces(factory, rings);
        shapes.push(...faces.faces);
        faceCount += faces.faces.length;
        failed += faces.failed;
    }
    if (shapes.length === 0) return Result.err("The SVG file has no outlines to import");
    if (shapes.length === 1) return Result.ok({ shape: shapes[0], faceCount, wireCount, failed });
    const compound = factory.combine(shapes);
    if (!compound.isOk) return Result.err(compound.error);
    return Result.ok({ shape: compound.value, faceCount, wireCount, failed });
}

function scaled(point: SvgPoint, scale: number) {
    return { x: point.x * scale, y: point.y * scale, z: 0 };
}

function buildWire(factory: IShapeFactory, subpath: SvgSubpath, scale: number): Result<IWire> {
    const edges: IEdge[] = [];
    for (const segment of subpath.segments) {
        const points = segment.points.map((point) => scaled(point, scale));
        const edge = segment.kind === "line" ? factory.line(points[0], points[1]) : factory.bezier(points);
        if (!edge.isOk) return Result.err(edge.error);
        edges.push(edge.value);
    }
    return factory.wire(edges);
}

function flatten(subpath: SvgSubpath, scale: number): SvgPoint[] {
    const polygon: SvgPoint[] = [];
    for (const segment of subpath.segments) {
        const points = segment.kind === "line" ? segment.points : flattenCubic(segment.points, 8);
        for (const point of points.slice(0, -1)) polygon.push({ x: point.x * scale, y: point.y * scale });
    }
    return polygon;
}

/** Even-odd nesting: a ring inside an even number of others is an outline, the next level its holes. */
function buildFaces(factory: IShapeFactory, rings: Ring[]): { faces: IShape[]; failed: number } {
    rings.sort((a, b) => b.area - a.area);
    const parents = new Map<Ring, Ring | undefined>();
    for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];
        let parent: Ring | undefined;
        // Larger rings come first; the innermost container is the last one that holds it.
        for (let j = 0; j < i; j++) {
            if (rings[j].area > ring.area && containsRing(rings[j].polygon, ring.polygon)) parent = rings[j];
        }
        ring.depth = parent ? parent.depth + 1 : 0;
        parents.set(ring, parent);
    }
    const faces: IShape[] = [];
    let failed = 0;
    for (const outer of rings.filter((ring) => ring.depth % 2 === 0)) {
        const holes = rings.filter((ring) => parents.get(ring) === outer).map((ring) => ring.wire);
        const face = factory.face([outer.wire, ...holes]);
        if (face.isOk) faces.push(face.value);
        else failed++;
    }
    return { faces, failed };
}

/** Whether `inner` lies inside `outer`: the majority of its vertices do (robust to touching). */
function containsRing(outer: SvgPoint[], inner: SvgPoint[]): boolean {
    let inside = 0;
    for (const point of inner) if (pointInPolygon(point, outer)) inside++;
    return inside * 2 > inner.length;
}

function pointInPolygon(point: SvgPoint, polygon: SvgPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];
        if (a.y > point.y !== b.y > point.y) {
            const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
            if (point.x < x) inside = !inside;
        }
    }
    return inside;
}

function signedArea(polygon: SvgPoint[]): number {
    let area = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        area += (polygon[j].x - polygon[i].x) * (polygon[j].y + polygon[i].y);
    }
    return area / 2;
}
