// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    type Continuity,
    GeometryUtils,
    type ICompound,
    type ICurve,
    type IEdge,
    type IFace,
    type IShape,
    type IShapeFactory,
    type IShell,
    type ISolid,
    type IVertex,
    type IWire,
    type JoinType,
    type Line,
    MathUtils,
    type OffsetMode,
    PerformanceTrace,
    type Plane,
    Precision,
    type PrismFromEnd,
    Result,
    ShapeTypes,
    ShapeTypeUtils,
    type TrackedShape,
    type XYZ,
    type XYZLike,
} from "@spicy3d/core";
import type {
    IntVector,
    RegionsResult,
    ShapeResult,
    ShapesResult,
    TopoDS_Edge,
    TopoDS_Face,
    TopoDS_Shape,
    TrackedShapeResult,
} from "../lib/spicy-wasm";
import { OccCurve } from "./curve";
import { convertFromContinuity, getJoinType, getOffsetMode } from "./helper";
import { guardKernelResults } from "./kernelGuard";
import { prepareLoftSection } from "./loftSections";
import { OccEdge, OccShape } from "./shape";

function ensureOccShape(shapes: IShape | IShape[]): TopoDS_Shape[] {
    if (Array.isArray(shapes)) {
        return shapes.map((x) => {
            if (!(x instanceof OccShape)) {
                throw new Error("The OCC kernel only supports OCC geometries.");
            }
            return x.shape;
        });
    }

    if (shapes instanceof OccShape) {
        return [shapes.shape];
    }

    throw new Error("The OCC kernel only supports OCC geometries.");
}

/** Emscripten's advice appended to an abort message: noise for whoever reads the error. */
const ASSERTIONS_HINT = /\.? Build with -sASSERTIONS for more info\.?/;

/**
 * `"<op> failed: <error>"` for a kernel call that threw instead of answering an error result: an
 * abort of a module built without exception catching (`RuntimeError: Aborted(…)`), a JS `Error`
 * thrown by a binding, an embind argument error. A plain `Error` shows its message alone.
 */
export function kernelCallFailure(op: string, error: unknown): string {
    if (!(error instanceof Error)) return `${op} failed: ${String(error).replace(ASSERTIONS_HINT, "")}`;
    const message = error.message.replace(ASSERTIONS_HINT, "");
    const name = error.name || "Error";
    if (!message) return `${op} failed: ${name}`;
    if (name === "Error") return `${op} failed: ${message}`;
    return `${op} failed: ${name}: ${message}`;
}

/** Answer of `bspline` when the loaded module has no such binding. */
export const BSPLINE_EDGE_UNAVAILABLE = "B-spline edges are not available in this kernel build";

type BSplineBinding = (
    poles: XYZLike[],
    knots: number[],
    multiplicities: number[],
    degree: number,
    periodic: boolean,
    weights: number[],
) => ShapeResult;

/**
 * `ShapeFactory.bspline` of the loaded module, or undefined when the module predates it (the
 * committed binary has it): feature-detected on each call, so any module build is handled.
 */
function bsplineBinding(): BSplineBinding | undefined {
    const factoryClass = wasm.ShapeFactory as unknown as { bspline?: unknown };
    const binding = factoryClass.bspline;
    if (typeof binding !== "function") return undefined;
    return (...args) => binding.apply(factoryClass, args) as ShapeResult;
}

/** The knot-layout rules `Geom_BSplineCurve` raises on, checked before the kernel sees the data. */
function bsplineLayoutError(
    poles: number,
    knots: number[],
    multiplicities: number[],
    degree: number,
    periodic: boolean,
    weights: number[] | undefined,
): string | undefined {
    if (!Number.isInteger(degree) || degree < 1 || degree > 25)
        return "B-spline degree must be an integer 1..25";
    if (knots.length < 2 || knots.length !== multiplicities.length) {
        return "B-spline needs at least two knots, one multiplicity per knot";
    }
    if (![...knots, ...multiplicities].every(Number.isFinite)) return "B-spline knots must be finite";
    if (knots.some((knot, i) => i > 0 && !(knot > knots[i - 1])))
        return "B-spline knots must be strictly increasing";
    const last = multiplicities.length - 1;
    const badMultiplicity = multiplicities.some((m, i) => {
        const end = i === 0 || i === last;
        return !Number.isInteger(m) || m < 1 || m > (end && !periodic ? degree + 1 : degree);
    });
    if (badMultiplicity) return "B-spline multiplicity out of range";
    if (periodic && multiplicities[0] !== multiplicities[last]) {
        return "Periodic B-spline needs equal first and last multiplicities";
    }
    const sum = multiplicities.reduce((a, b) => a + b, 0);
    const expected = periodic ? sum - multiplicities[last] : sum - degree - 1;
    if (expected < 2 || poles !== expected)
        return `B-spline needs ${expected} poles for its knots, got ${poles}`;
    if (weights !== undefined && weights.length > 0) {
        if (weights.length !== poles) return "B-spline needs one weight per pole";
        if (!weights.every((w) => Number.isFinite(w) && w > 0)) return "B-spline weights must be positive";
    }
    return undefined;
}

function convertShapeResult<P extends unknown[] = unknown[]>(
    factory: (...params: P) => ShapeResult,
    params: P,
    op: string,
): Result<IShape, string> {
    let result: ShapeResult;
    const span = PerformanceTrace.enabled
        ? PerformanceTrace.begin("kernel.operation", {
              operation: op,
              boolean: /^(Fuse|Boolean)/.test(op),
              tracked: false,
          })
        : undefined;
    try {
        result = factory(...params);
    } catch (err) {
        return Result.err(kernelCallFailure(op, err));
    } finally {
        if (PerformanceTrace.enabled) PerformanceTrace.end(span);
    }

    let res: Result<IShape, string>;
    if (!result.isOk) {
        res = Result.err(result.error);
    } else {
        res = Result.ok(OccShape.wrap(result.shape));
    }

    result.delete();
    return res;
}

/**
 * A thick solid the kernel answered is checked before it is handed out:
 *
 * - it must hold a solid: `makeThickSolidByJoin` on an open shell without closing faces answers
 *   `IsDone` with a compound of the offset faces, which `checkShape()` accepts; `notSolidHint`
 *   says what to call instead;
 * - it must pass `checkShape()`: an offset of steep, narrow faces can come back invalid, and a
 *   later boolean or inspection on it may raise inside the kernel. Newer kernel builds check it in
 *   C++ too; this covers older ones.
 */
function validThickSolid(
    result: Result<IShape, string>,
    op: string,
    notSolidHint = "",
): Result<IShape, string> {
    if (!result.isOk) return result;
    const shape = result.value;
    if (!containsSolid(shape)) {
        const type = ShapeTypeUtils.stringValue(shape.shapeType);
        shape.dispose();
        return Result.err(`${op} failed: the result is not a solid (${type})${notSolidHint}`);
    }
    if (shape.checkShape()) return result;
    shape.dispose();
    return Result.err(`${op} failed: Thick solid is invalid (checkShape is false)`);
}

function containsSolid(shape: IShape): boolean {
    if (shape.shapeType === ShapeTypes.solid) return true;
    const solids = shape.findSubShapes(ShapeTypes.solid);
    for (const solid of solids) solid.dispose();
    return solids.length > 0;
}

/**
 * The error for an intersection join on an input with more faces than
 * `Config.thickSolidIntersectionMaxFaces`, undefined when the call may go ahead. OCCT's
 * intersection join (`BRepOffset_MakeOffset`, `GeomAbs_Intersection`) intersects the offset faces
 * pairwise; on a shell of many narrow faces it may never finish, and a kernel call on the main
 * thread cannot be interrupted, so the tab hangs. Arc joins and simple offsets do not.
 */
export function refuseIntersectionJoin(shape: IShape, joinType: JoinType): string | undefined {
    if (joinType !== "intersection") return undefined;
    const limit = Config.instance.thickSolidIntersectionMaxFaces;
    const faces = shape.findSubShapes(ShapeTypes.face);
    const count = faces.length;
    for (const face of faces) face.dispose();
    if (count <= limit) return undefined;
    return `MakeThickSolidByJoin refused: joinType "intersection" on a shape with ${count} faces (limit ${limit}) may never finish and would freeze the tab; use joinType "arc" or makeThickSolidBySimple (Config.thickSolidIntersectionMaxFaces raises the limit)`;
}

function convertShapesResult<P extends unknown[] = unknown[]>(
    factory: (...params: P) => ShapesResult,
    params: P,
    op: string,
): Result<IShape[], string> {
    let result: ShapesResult;
    try {
        result = factory(...params);
    } catch (err) {
        return Result.err(kernelCallFailure(op, err));
    }

    let res: Result<IShape[], string>;
    if (!result.isOk) {
        res = Result.err(result.error);
    } else {
        const shapes: IShape[] = [];
        const arr = result.shapes;
        for (let i = 0; i < arr.length; i++) {
            const ts = arr[i];
            if (ts && !ts.isNull()) {
                shapes.push(OccShape.wrap(ts));
            }
        }
        res = Result.ok(shapes);
    }

    result.delete();
    return res;
}

function convertTrackedShapeResult<P extends unknown[] = unknown[]>(
    factory: (...params: P) => TrackedShapeResult,
    params: P,
    op: string,
): Result<TrackedShape, string> {
    let result: TrackedShapeResult;
    // OCCT's tracked call includes history completion in C++; it cannot be timed separately here.
    const span = PerformanceTrace.enabled
        ? PerformanceTrace.begin("kernel.operation", {
              operation: op,
              boolean: /^(Fuse|Boolean)/.test(op),
              tracked: true,
          })
        : undefined;
    try {
        result = factory(...params);
    } catch (err) {
        return Result.err(kernelCallFailure(op, err));
    } finally {
        if (PerformanceTrace.enabled) PerformanceTrace.end(span);
    }

    const history = PerformanceTrace.enabled ? PerformanceTrace.begin("kernel.historyConversion") : undefined;
    let res: Result<TrackedShape, string>;
    if (!result.isOk) {
        res = Result.err(result.error);
    } else {
        res = Result.ok({
            shape: OccShape.wrap(result.shape),
            faceMap: toIntArray(result.faceMap),
            edgeMap: toIntArray(result.edgeMap),
            faceEdgeMap: toIntArray(result.faceEdgeMap),
            faceAncestors: toIntArray(result.faceAncestors),
            edgeAncestors: toIntArray(result.edgeAncestors),
            capFaces: toIntArray(result.capFaces),
        });
    }

    result.delete();
    if (PerformanceTrace.enabled) PerformanceTrace.end(history);
    return res;
}

function toIntArray(vector: IntVector): number[] {
    const array: number[] = [];
    for (let i = 0; i < vector.size(); i++) {
        array.push(vector.get(i)!);
    }
    vector.delete();
    return array;
}

/** The edges a fillet removal produced, skipping nulls, non-edges and already-seen handles. */
function filletResultEdges(edges: TopoDS_Shape[]): OccEdge[] {
    const newEdges: OccEdge[] = [];
    const visited = new Set();
    for (let i = 0; i < edges.length; i++) {
        const ts = edges[i];
        if (!ts || ts.shapeType() !== wasm.TopAbs_ShapeEnum.TopAbs_EDGE || visited.has(wasm.Shape.ptr(ts)))
            continue;

        newEdges.push(OccShape.wrap(ts) as OccEdge);
    }
    return newEdges;
}

export class ShapeFactory implements IShapeFactory {
    readonly kernelName = "opencascade";

    constructor(
        readonly asyncOperations?: import("@spicy3d/core").IAsyncShapeFactory,
        readonly boundedOperations?: import("@spicy3d/core").IBoundedShapeFactory,
    ) {
        // Once the kernel crashed, every call answers `Result.err` with the same message; `edge`
        // returns a plain edge, so it throws that message instead.
        // biome-ignore lint/correctness/noConstructorReturn: the guarded facade replaces the instance
        return guardKernelResults(this, ["edge"]);
    }

    edge(curve: ICurve): IEdge {
        if (!(curve instanceof OccCurve)) {
            throw new Error("Invalid curve");
        }
        return new OccEdge({ shape: wasm.Edge.fromCurve(curve.curve) });
    }

    fillet(shape: IShape, edges: number[], radius: number): Result<IShape> {
        if (radius < Precision.Distance) {
            return Result.err("The radius is too small.");
        }

        if (edges.length === 0) {
            return Result.err("The edges is empty.");
        }

        if (shape instanceof OccShape) {
            return convertShapeResult(wasm.ShapeFactory.fillet, [shape.shape, edges, radius], "Fillet");
        }
        return Result.err("Not OccShape");
    }

    chamfer(shape: IShape, edges: number[], distance: number): Result<IShape> {
        if (distance < Precision.Distance) {
            return Result.err("The distance is too small.");
        }

        if (edges.length === 0) {
            return Result.err("The edges is empty.");
        }

        if (shape instanceof OccShape) {
            return convertShapeResult(wasm.ShapeFactory.chamfer, [shape.shape, edges, distance], "Chamfer");
        }
        return Result.err("Not OccShape");
    }

    filletTracked(shape: IShape, edges: number[], radius: number): Result<TrackedShape> {
        if (radius < Precision.Distance) {
            return Result.err("The radius is too small.");
        }

        if (edges.length === 0) {
            return Result.err("The edges is empty.");
        }

        if (shape instanceof OccShape) {
            return convertTrackedShapeResult(
                wasm.ShapeFactory.filletTracked,
                [shape.shape, edges, radius],
                "Fillet",
            );
        }
        return Result.err("Not OccShape");
    }

    chamferTracked(shape: IShape, edges: number[], distance: number): Result<TrackedShape> {
        if (distance < Precision.Distance) {
            return Result.err("The distance is too small.");
        }

        if (edges.length === 0) {
            return Result.err("The edges is empty.");
        }

        if (shape instanceof OccShape) {
            return convertTrackedShapeResult(
                wasm.ShapeFactory.chamferTracked,
                [shape.shape, edges, distance],
                "Chamfer",
            );
        }
        return Result.err("Not OccShape");
    }

    fillet2d(face: IFace, edge1: IEdge, edge2: IEdge, radius: number): Result<IFace> {
        if (radius < Precision.Distance) {
            return Result.err("The radius is too small.");
        }

        const [occFace, occEdge1, occEdge2] = ensureOccShape([face, edge1, edge2]);
        return convertShapeResult(
            wasm.ShapeFactory.fillet2d,
            [occFace as TopoDS_Face, occEdge1 as TopoDS_Edge, occEdge2 as TopoDS_Edge, radius],
            "Fillet2d",
        ) as Result<IFace>;
    }

    filletEdge2d(edge1: IEdge, edge2: IEdge, radius: number): Result<IEdge[]> {
        if (radius < Precision.Distance) {
            return Result.err("The radius is too small.");
        }

        const [occEdge1, occEdge2] = ensureOccShape([edge1, edge2]);
        return convertShapesResult(
            wasm.ShapeFactory.filletEdge2d,
            [occEdge1 as TopoDS_Edge, occEdge2 as TopoDS_Edge, radius],
            "FilletEdge2d",
        ) as Result<IEdge[]>;
    }

    chamfer2d(face: IFace, edge1: IEdge, edge2: IEdge, distance: number): Result<IFace> {
        if (distance < Precision.Distance) {
            return Result.err("The distance is too small.");
        }

        const [occFace, occEdge1, occEdge2] = ensureOccShape([face, edge1, edge2]);
        return convertShapeResult(
            wasm.ShapeFactory.chamfer2d,
            [occFace as TopoDS_Face, occEdge1 as TopoDS_Edge, occEdge2 as TopoDS_Edge, distance],
            "Chamfer2d",
        ) as Result<IFace>;
    }

    chamferEdge2d(edge1: IEdge, edge2: IEdge, distance: number): Result<IEdge[]> {
        if (distance < Precision.Distance) {
            return Result.err("The distance is too small.");
        }

        const [occEdge1, occEdge2] = ensureOccShape([edge1, edge2]);
        return convertShapesResult(
            wasm.ShapeFactory.chamferEdge2d,
            [occEdge1 as TopoDS_Edge, occEdge2 as TopoDS_Edge, distance],
            "ChamferEdge2d",
        ) as Result<IEdge[]>;
    }

    removeFeature(shape: IShape, faces: IFace[]): Result<IShape> {
        if (!(shape instanceof OccShape)) {
            return Result.err("Not OccShape");
        }
        const occFaces = ensureOccShape(faces);
        const result = wasm.ShapeFactory.removeFeature(shape.shape, occFaces);
        if (!result.isOk) {
            return Result.err(result.error);
        }
        if (result.shape.isNull() || shape.shape.isEqual(result.shape)) {
            return Result.err("Can not remove feature");
        }
        return Result.ok(OccShape.wrap(result.shape));
    }

    removeFillet(shape: IShape, faces: IFace[]) {
        if (!(shape instanceof OccShape)) {
            return Result.err("Not OccShape");
        }
        const occFaces = ensureOccShape(faces);
        const result = wasm.ShapeFactory.removeFillet(shape.shape, occFaces);
        if (!result.isOk) {
            return Result.err(result.error);
        }
        if (result.shape.isNull() || shape.shape.isEqual(result.shape)) {
            return Result.err("Can not remove fillet");
        }

        return Result.ok({
            shape: OccShape.wrap(result.shape),
            newEdges: filletResultEdges(result.newEdges),
        });
    }

    removeSubShape(shape: IShape, subShapes: IShape[]): Result<IShape> {
        const occShape = ensureOccShape(shape);
        const occSubShapes = ensureOccShape(subShapes);
        return convertShapeResult(
            wasm.ShapeFactory.removeSubShape,
            [occShape[0], occSubShapes],
            "Remove SubShape",
        );
    }

    replaceSubShapes(shape: IShape, oldSubShapes: IShape[], newSubShapes: IShape[]): Result<IShape> {
        const occShape = ensureOccShape(shape);
        const occOld = ensureOccShape(oldSubShapes);
        const occNew = ensureOccShape(newSubShapes);
        return convertShapeResult(
            wasm.ShapeFactory.replaceSubShapes,
            [occShape[0], occOld, occNew],
            "Replace SubShapes",
        );
    }

    face(wire: IWire[]): Result<IFace> {
        if (wire.length === 0) {
            return Result.err("The wire is empty.");
        }
        const normal = GeometryUtils.normal(wire[0]);
        for (let i = 1; i < wire.length; i++) {
            if (GeometryUtils.isCCW(normal, wire[i])) {
                wire[i].reserve();
            }
        }
        const shapes = ensureOccShape(wire);
        return convertShapeResult(wasm.ShapeFactory.face, [shapes], "Face") as Result<IFace>;
    }
    faceFromSurface(wires: IWire[], sourceFace: IFace): Result<IFace> {
        if (wires.length === 0) {
            return Result.err("The wire is empty.");
        }
        const normal = GeometryUtils.normal(wires[0]);
        for (let i = 1; i < wires.length; i++) {
            if (GeometryUtils.isCCW(normal, wires[i])) {
                wires[i].reserve();
            }
        }
        const shapes = ensureOccShape(wires);
        const [occFace] = ensureOccShape(sourceFace);
        return convertShapeResult(
            wasm.ShapeFactory.faceFromSurface,
            [shapes, occFace],
            "FaceFromSurface",
        ) as Result<IFace>;
    }
    facesFromEdges(edges: IEdge[], plane: Plane): Result<{ faces: IFace[]; sources: number[][] }> {
        if (edges.length === 0) {
            return Result.err("The edges are empty.");
        }
        const occEdges = ensureOccShape(edges);
        let result: RegionsResult;
        try {
            result = wasm.ShapeFactory.facesFromEdges(occEdges, {
                location: plane.origin,
                direction: plane.normal,
                xDirection: plane.xvec,
            });
        } catch (err) {
            return Result.err(kernelCallFailure("FacesFromEdges", err));
        }

        let res: Result<{ faces: IFace[]; sources: number[][] }, string>;
        if (!result.isOk) {
            res = Result.err(result.error);
        } else {
            const faces: IFace[] = [];
            for (let i = 0; i < result.faces.length; i++) {
                faces.push(OccShape.wrap(result.faces[i]) as IFace);
            }
            // sourceIds is flattened: region k owns sourceIds[sum(counts<k) .. +counts[k]].
            const counts = toIntArray(result.sourceCounts);
            const ids = toIntArray(result.sourceIds);
            const sources: number[][] = [];
            let offset = 0;
            for (const count of counts) {
                sources.push(ids.slice(offset, offset + count));
                offset += count;
            }
            res = Result.ok({ faces, sources });
        }
        result.delete();
        return res;
    }
    bezier(points: XYZLike[], weights?: number[]): Result<IEdge> {
        return convertShapeResult(
            wasm.ShapeFactory.bezier,
            [points, weights ?? []],
            "Bezier",
        ) as Result<IEdge>;
    }
    get supportsBSplineEdges(): boolean {
        return bsplineBinding() !== undefined;
    }
    bspline(
        poles: XYZLike[],
        knots: number[],
        multiplicities: number[],
        degree: number,
        periodic: boolean,
        weights?: number[],
    ): Result<IEdge> {
        const binding = bsplineBinding();
        if (binding === undefined) return Result.err(BSPLINE_EDGE_UNAVAILABLE);
        const error = bsplineLayoutError(poles.length, knots, multiplicities, degree, periodic, weights);
        if (error !== undefined) return Result.err(error);
        return convertShapeResult(
            binding,
            [poles, knots, multiplicities, degree, periodic, weights ?? []],
            "BSpline",
        ) as Result<IEdge>;
    }
    helix(
        origin: XYZLike,
        normal: XYZLike,
        xDir: XYZLike,
        radius: number,
        pitch: number,
        angle: number,
    ): Result<IWire> {
        return convertShapeResult(
            wasm.ShapeFactory.helix,
            [origin, normal, xDir, radius, pitch, MathUtils.degToRad(angle)],
            "Helix",
        ) as Result<IWire>;
    }
    point(point: XYZLike): Result<IVertex> {
        return convertShapeResult(wasm.ShapeFactory.point, [point], "Point") as Result<IVertex>;
    }
    line(start: XYZLike, end: XYZLike): Result<IEdge> {
        if (MathUtils.allEqualZero(start.x - end.x, start.y - end.y, start.z - end.z)) {
            return Result.err("The start and end points are too close.");
        }

        return convertShapeResult(wasm.ShapeFactory.line, [start, end], "Line") as Result<IEdge>;
    }
    arc(normal: XYZLike, center: XYZLike, start: XYZLike, angle: number): Result<IEdge> {
        return convertShapeResult(
            wasm.ShapeFactory.arc,
            [normal, center, start, MathUtils.degToRad(angle)],
            "Arc",
        ) as Result<IEdge>;
    }
    circle(normal: XYZLike, center: XYZLike, radius: number): Result<IEdge> {
        return convertShapeResult(
            wasm.ShapeFactory.circle,
            [normal, center, radius],
            "Circle",
        ) as Result<IEdge>;
    }
    rect(plane: Plane, dx: number, dy: number): Result<IFace> {
        return convertShapeResult(
            wasm.ShapeFactory.rect,
            [
                {
                    location: plane.origin,
                    direction: plane.normal,
                    xDirection: plane.xvec,
                },
                dx,
                dy,
            ],
            "Rect",
        ) as Result<IFace>;
    }
    polygon(points: XYZLike[]): Result<IWire> {
        return convertShapeResult(wasm.ShapeFactory.polygon, [points], "Polygon") as Result<IWire>;
    }
    box(plane: Plane, dx: number, dy: number, dz: number): Result<ISolid> {
        return convertShapeResult(
            wasm.ShapeFactory.box,
            [
                {
                    location: plane.origin,
                    direction: plane.normal,
                    xDirection: plane.xvec,
                },
                dx,
                dy,
                dz,
            ],
            "Box",
        ) as Result<ISolid>;
    }
    cylinder(dir: XYZ, center: XYZ, radius: number, dz: number): Result<ISolid> {
        return convertShapeResult(
            wasm.ShapeFactory.cylinder,
            [dir, center, radius, dz],
            "Cylinder",
        ) as Result<ISolid>;
    }
    cone(dir: XYZ, center: XYZ, radius: number, radiusUp: number, dz: number): Result<ISolid> {
        return convertShapeResult(
            wasm.ShapeFactory.cone,
            [dir, center, radius, radiusUp, dz],
            "Cone",
        ) as Result<ISolid>;
    }
    sphere(center: XYZ, radius: number): Result<ISolid> {
        return convertShapeResult(wasm.ShapeFactory.sphere, [center, radius], "Sphere") as Result<ISolid>;
    }
    ellipse(
        normal: XYZLike,
        center: XYZLike,
        xvec: XYZLike,
        majorRadius: number,
        minorRadius: number,
    ): Result<IEdge> {
        return convertShapeResult(
            wasm.ShapeFactory.ellipse,
            [normal, center, xvec, majorRadius, minorRadius],
            "Ellipse",
        ) as Result<IEdge>;
    }
    pyramid(plane: Plane, dx: number, dy: number, dz: number): Result<ISolid> {
        return convertShapeResult(
            wasm.ShapeFactory.pyramid,
            [
                {
                    location: plane.origin,
                    direction: plane.normal,
                    xDirection: plane.xvec,
                },
                dx,
                dy,
                dz,
            ],
            "Pyramid",
        ) as Result<ISolid>;
    }
    wire(edges: IEdge[]): Result<IWire> {
        return convertShapeResult(wasm.ShapeFactory.wire, [ensureOccShape(edges)], "Wire") as Result<IWire>;
    }
    shell(faces: IFace[]): Result<IShell> {
        return convertShapeResult(
            wasm.ShapeFactory.shell,
            [ensureOccShape(faces)],
            "Shell",
        ) as Result<IShell>;
    }
    solid(shells: IShell[]): Result<ISolid> {
        return convertShapeResult(
            wasm.ShapeFactory.solid,
            [ensureOccShape(shells)],
            "Solid",
        ) as Result<ISolid>;
    }
    prism(shape: IShape, vec: XYZ): Result<IShape> {
        if (vec.length() === 0) {
            return Result.err(`The vector length is 0, the prism cannot be created.`);
        }
        return convertShapeResult(wasm.ShapeFactory.prism, [ensureOccShape(shape)[0], vec], "Prism");
    }

    prismTracked(shape: IShape, vec: XYZ): Result<TrackedShape> {
        if (vec.length() === 0) {
            return Result.err(`The vector length is 0, the prism cannot be created.`);
        }
        return convertTrackedShapeResult(
            wasm.ShapeFactory.prismTracked,
            [ensureOccShape(shape)[0], vec],
            "Prism",
        );
    }

    prismFromTracked(
        profile: IShape,
        direction: XYZ,
        fromFace: IFace,
        offset: number,
        end: PrismFromEnd,
    ): Result<TrackedShape> {
        const binding = wasm.ShapeFactory.prismFromTracked;
        if (typeof binding !== "function")
            return Result.err("This kernel cannot start an extrusion from a face");
        return convertTrackedShapeResult(
            binding,
            [
                ensureOccShape(profile)[0],
                direction,
                ensureOccShape(fromFace)[0],
                offset,
                end.kind === "distance" ? 0 : end.kind === "toObject" ? 1 : 2,
                end.kind === "distance" ? end.depth : 0,
                ensureOccShape(end.kind === "toObject" ? end.face : fromFace)[0],
                end.kind === "toObject" ? (end.offset ?? 0) : 0,
                ensureOccShape(end.kind === "throughAll" ? end.bounds : []),
                end.kind === "throughAll" && end.flush === true,
            ],
            "Prism",
        );
    }

    prismUntilTracked(profile: IShape, direction: XYZ, untilFace: IFace, offset = 0): Result<TrackedShape> {
        return convertTrackedShapeResult(
            wasm.ShapeFactory.prismUntilTracked,
            [ensureOccShape(profile)[0], direction, ensureOccShape(untilFace)[0], offset],
            "Prism",
        );
    }

    prismThruAllTracked(
        profile: IShape,
        direction: XYZ,
        bounds: IShape[],
        flush = false,
    ): Result<TrackedShape> {
        return convertTrackedShapeResult(
            wasm.ShapeFactory.prismThruAllTracked,
            [ensureOccShape(profile)[0], direction, ensureOccShape(bounds), flush],
            "Prism",
        );
    }

    pushPull(shape: IShape, face: IShape, vec: XYZ): Result<IShape> {
        if (vec.length() === 0) {
            return Result.err(`The vector length is 0, the prism cannot be created.`);
        }
        return convertShapeResult(
            wasm.ShapeFactory.pushPull,
            [ensureOccShape(shape)[0], ensureOccShape(face)[0], vec],
            "PushPull",
        );
    }
    fuse(bottom: IShape, top: IShape): Result<IShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertShapeResult(
            wasm.ShapeFactory.booleanFuse,
            [ensureOccShape(bottom), ensureOccShape(top)],
            "Fuse",
        );
    }
    sweep(profile: IShape[], path: IWire, isRound: boolean): Result<IShape> {
        return convertShapeResult(
            wasm.ShapeFactory.sweep,
            [ensureOccShape(profile), ensureOccShape(path)[0], true, isRound],
            "Sweep",
        );
    }
    revolve(profile: IShape, axis: Line, angle: number): Result<IShape> {
        return convertShapeResult(
            wasm.ShapeFactory.revolve,
            [
                ensureOccShape(profile)[0],
                {
                    location: axis.point,
                    direction: axis.direction,
                },
                MathUtils.degToRad(angle),
            ],
            "Revolve",
        );
    }

    revolveTracked(profile: IShape, axis: Line, angle: number): Result<TrackedShape> {
        return convertTrackedShapeResult(
            wasm.ShapeFactory.revolveTracked,
            [
                ensureOccShape(profile)[0],
                {
                    location: axis.point,
                    direction: axis.direction,
                },
                MathUtils.degToRad(angle),
            ],
            "Revolve",
        );
    }
    booleanCommon(shape1: IShape[], shape2: IShape[]): Result<IShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertShapeResult(
            wasm.ShapeFactory.booleanCommon,
            [ensureOccShape(shape1), ensureOccShape(shape2)],
            "BooleanCommon",
        );
    }
    booleanCut(shape1: IShape[], shape2: IShape[]): Result<IShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertShapeResult(
            wasm.ShapeFactory.booleanCut,
            [ensureOccShape(shape1), ensureOccShape(shape2)],
            "BooleanCut",
        );
    }

    booleanCommonTracked(shape1: IShape[], shape2: IShape[]): Result<TrackedShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertTrackedShapeResult(
            wasm.ShapeFactory.booleanCommonTracked,
            [ensureOccShape(shape1), ensureOccShape(shape2)],
            "BooleanCommon",
        );
    }

    booleanCutTracked(shape1: IShape[], shape2: IShape[]): Result<TrackedShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertTrackedShapeResult(
            wasm.ShapeFactory.booleanCutTracked,
            [ensureOccShape(shape1), ensureOccShape(shape2)],
            "BooleanCut",
        );
    }

    booleanFuseTracked(shape1: IShape[], shape2: IShape[]): Result<TrackedShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        return convertTrackedShapeResult(
            wasm.ShapeFactory.booleanFuseTracked,
            [ensureOccShape(shape1), ensureOccShape(shape2)],
            "BooleanFuse",
        );
    }
    booleanFuse(shape1: IShape[], shape2: IShape[], simplifyShape: boolean): Result<IShape> {
        if (this.asyncOperations?.failure !== undefined) return Result.err(this.asyncOperations.failure);
        const occShape1 = ensureOccShape(shape1);
        const occShape2 = ensureOccShape(shape2);

        const fused = convertShapeResult(
            wasm.ShapeFactory.booleanFuse,
            [occShape1, occShape2],
            "BooleanFuse",
        );

        if (!fused.isOk || !simplifyShape) {
            return fused;
        }

        const occShape = fused.value as OccShape;
        const simplified = convertShapeResult(
            wasm.ShapeFactory.simplifyShape,
            [occShape.shape, true, true, [], 1e-5, 1e-6],
            "SimplifyShape",
        );
        if (!simplified.isOk) {
            return fused;
        }
        return simplified;
    }
    sewing(shapes: IShape[]): Result<IShape> {
        const occShapes = ensureOccShape(shapes);
        return convertShapeResult(wasm.ShapeFactory.sewing, [occShapes], "Sewing");
    }
    combine(shapes: IShape[]): Result<ICompound> {
        return convertShapeResult(
            wasm.ShapeFactory.combine,
            [ensureOccShape(shapes)],
            "Combine",
        ) as Result<ICompound>;
    }
    makeThickSolidBySimple(shape: IShape, thickness: number): Result<IShape> {
        return validThickSolid(
            convertShapeResult(
                wasm.ShapeFactory.makeThickSolidBySimple,
                [ensureOccShape(shape)[0], thickness],
                "MakeThickSolidBySimple",
            ),
            "MakeThickSolidBySimple",
        );
    }
    makeThickSolidByJoin(
        shape: IShape,
        closingFaces: IShape[],
        thickness: number,
        joinType: JoinType,
        mode: OffsetMode = "skin",
        intersection: boolean = false,
    ): Result<IShape> {
        const refused = refuseIntersectionJoin(shape, joinType);
        if (refused) return Result.err(refused);
        return validThickSolid(
            convertShapeResult(
                wasm.ShapeFactory.makeThickSolidByJoin,
                [
                    ensureOccShape(shape)[0],
                    ensureOccShape(closingFaces),
                    thickness,
                    getJoinType(joinType),
                    getOffsetMode(mode),
                    intersection,
                ],
                "MakeThickSolidByJoin",
            ),
            "MakeThickSolidByJoin",
            "; for an open shell use makeThickSolidBySimple",
        );
    }
    loft(sections: IShape[], isSolid: boolean, isRuled: boolean, continuity: Continuity): Result<IShape> {
        const prepared: IShape[] = [];
        // Shapes built here (edge -> wire, chained compound, a face's outer wire), never the caller's.
        const created: IShape[] = [];
        try {
            for (const [index, section] of sections.entries()) {
                const result = prepareLoftSection(section, index, (edges) => this.wire(edges));
                if (!result.isOk) return Result.err(result.error);
                prepared.push(result.value);
                if (result.value !== section) created.push(result.value);
            }
            return convertShapeResult(
                wasm.ShapeFactory.loft,
                [ensureOccShape(prepared), isSolid, isRuled, convertFromContinuity(continuity)],
                "Loft",
            );
        } finally {
            for (const shape of created) shape.dispose();
        }
    }
    curveProjection(curve: IEdge | IWire, targetFace: IFace, vec: XYZ): Result<IShape> {
        return convertShapeResult(
            wasm.ShapeFactory.curveProjection,
            [ensureOccShape(curve)[0], ensureOccShape(targetFace)[0], new wasm.gp_Dir(vec.x, vec.y, vec.z)],
            "CurveProjection",
        );
    }
    simplifyShape(
        shape: IShape,
        removeEdges: boolean,
        removeFaces: boolean,
        keepShapes: IShape[],
        linearTolerance: number = 1e-5,
        angleTolerance: number = 1e-6,
    ): Result<IShape> {
        return convertShapeResult(
            wasm.ShapeFactory.simplifyShape,
            [
                ensureOccShape(shape)[0],
                removeEdges,
                removeFaces,
                ensureOccShape(keepShapes),
                linearTolerance,
                angleTolerance,
            ],
            "SimplifyShape",
        );
    }
}
