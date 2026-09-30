// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "../foundation";
import type { Line, Plane, XYZ, XYZLike } from "../math";
import type { Continuity, ICurve } from "./curve";
import type { FilletRadiusSample } from "./filletRadiusLaw";
import type {
    ICompound,
    IEdge,
    IFace,
    IShape,
    IShell,
    ISolid,
    IVertex,
    IWire,
    JoinType,
    OffsetMode,
} from "./shape";

/** Ending boundary of an exact from-face prism; runtime options, never a saved payload. */
export type PrismFromEnd =
    | { kind: "distance"; depth: number }
    | { kind: "toObject"; face: IFace; offset?: number }
    | { kind: "throughAll"; bounds: IShape[]; flush?: boolean };

export interface TrackedShape {
    shape: IShape;
    /** output face index (findSubShapes order) -> input face index, -1 = new face */
    faceMap: number[];
    /**
     * output edge index (findSubShapes order) -> input edge index, -1 = new edge.
     * For booleans the input enumerates args edges first, then tools edges.
     */
    edgeMap: number[];
    /**
     * output face index (findSubShapes order) -> input edge index for faces generated
     * from an input edge (a sweep's side faces), -1 = not edge-generated. Lets callers
     * seed side faces with the generating edge's stable id instead of a fragile
     * enumeration-order-scoped one. Absent when the kernel predates this map.
     */
    faceEdgeMap?: number[];
    /**
     * Every (output, input) face derivation as flat pairs (out0, in0, out1, in1, ...) —
     * `faceMap` keeps only the first ancestor per output; this keeps them all, so a
     * face MERGED from several input faces records each of them. Filled for booleans
     * (merges are a boolean phenomenon); absent for sweeps/fillets and older kernels.
     */
    faceAncestors?: number[];
    /** The edge counterpart of `faceAncestors` — emitted alongside it, not yet consumed. */
    edgeAncestors?: number[];
    /**
     * Output face indexes (findSubShapes order) of a sweep's end cap, reported
     * directly by the kernel (LastShape): a prism's top face, a PARTIAL revolve's
     * end cap. Empty for non-sweeps and full-turn revolves (first/last shapes
     * coincide — those keep the geometric probe). Deliberately separate from
     * `faceMap`: the cap must not claim the profile face's derivation and collide
     * with the identical bottom/start face. Absent when the kernel predates this
     * channel — callers then fall back to the history-less-face heuristic.
     */
    capFaces?: number[];
    /** Runtime-only automatic next-face selection, relative to the supplied candidate shapes. */
    nextTarget?: { candidateIndex: number; faceIndex: number };
    /** Runtime pipe-shell history. Inputs enumerate section then path, separately by topology type. */
    pipeHistory?: {
        faceEdges: number[];
        faceVertices: number[];
        edgeVertices: number[];
        startEdges: number[];
        endEdges: number[];
        startFaces: number[];
    };
}

export interface IShapeFactory {
    readonly kernelName: string;
    /** Optional hybrid backend. Existing synchronous methods always remain available. */
    readonly asyncOperations?: IAsyncShapeFactory;
    /** Runtime-only strict worker path for potentially long direct modeling operations. */
    readonly boundedOperations?: IBoundedShapeFactory;
    edge(curve: ICurve): IEdge;
    face(wire: IWire[]): Result<IFace>;
    faceFromSurface(wires: IWire[], sourceFace: IFace): Result<IFace>;
    /**
     * Minimal bounded planar regions enclosed by `edges` on `plane`: the edges are split
     * at mutual intersections first, so crossing curves (e.g. overlapping sketch
     * rectangles without shared endpoints) yield every bounded region — unlike `face`,
     * which only chains endpoint-connected wires. Dangling edges produce no region.
     * `sources[k]` is the sorted unique indexes of the input edges bounding `faces[k]`.
     */
    facesFromEdges(edges: IEdge[], plane: Plane): Result<{ faces: IFace[]; sources: number[][] }>;
    shell(faces: IFace[]): Result<IShell>;
    solid(shells: IShell[]): Result<ISolid>;
    bezier(points: XYZLike[], weights?: number[]): Result<IEdge>;
    /**
     * One B-spline edge from its poles and knots, in OCCT's layout: `knots` distinct and increasing,
     * one multiplicity each; open curves have sum(multiplicities) − degree − 1 poles, periodic ones
     * sum(multiplicities) − the last multiplicity (the last knot closes the period, first and last
     * multiplicity equal). `weights` (one per pole, all positive) make it rational. A kernel build
     * without the binding answers an error — `supportsBSplineEdges` tells beforehand.
     * @unit none degree
     */
    bspline(
        poles: XYZLike[],
        knots: number[],
        multiplicities: number[],
        degree: number,
        periodic: boolean,
        weights?: number[],
    ): Result<IEdge>;
    /**
     * Whether `bspline` builds edges on the loaded kernel (feature-detected: builds older than the
     * binding lack it). Callers without it fall back to a chain of `bezier` segments.
     */
    readonly supportsBSplineEdges?: boolean;
    /**
     * @unit length radius pitch
     * @unit angle angle
     */
    helix(
        origin: XYZLike,
        normal: XYZLike,
        xDir: XYZLike,
        radius: number,
        pitch: number,
        angle: number,
    ): Result<IWire>;
    point(point: XYZLike): Result<IVertex>;
    line(start: XYZLike, end: XYZLike): Result<IEdge>;
    /** @unit angle angle */
    arc(normal: XYZLike, center: XYZLike, start: XYZLike, angle: number): Result<IEdge>;
    /** @unit length radius */
    circle(normal: XYZLike, center: XYZLike, radius: number): Result<IEdge>;
    /** @unit length dx dy */
    rect(plane: Plane, dx: number, dy: number): Result<IFace>;
    polygon(points: XYZLike[]): Result<IWire>;
    /** @unit length dx dy dz */
    box(plane: Plane, dx: number, dy: number, dz: number): Result<ISolid>;
    /** @unit length majorRadius minorRadius */
    ellipse(
        normal: XYZLike,
        center: XYZLike,
        xvec: XYZLike,
        majorRadius: number,
        minorRadius: number,
    ): Result<IEdge>;
    /** @unit length radius dz */
    cylinder(normal: XYZLike, center: XYZLike, radius: number, dz: number): Result<ISolid>;
    /** @unit length radius radiusUp dz */
    cone(normal: XYZLike, center: XYZLike, radius: number, radiusUp: number, dz: number): Result<ISolid>;
    /** @unit length radius */
    sphere(center: XYZLike, radius: number): Result<ISolid>;
    /** @unit length dx dy dz */
    pyramid(plane: Plane, dx: number, dy: number, dz: number): Result<ISolid>;
    wire(edges: IEdge[]): Result<IWire>;
    prism(shape: IShape, vec: XYZ): Result<IShape>;
    pushPull(shape: IShape, face: IShape, vec: XYZ): Result<IShape>;
    fuse(bottom: IShape, top: IShape): Result<IShape>;
    sweep(profile: IShape[], path: IWire, isRoundCorner: boolean): Result<IShape>;
    /** A single section swept along a path, retaining both profile and path ancestry. */
    sweepTracked?(section: IWire, path: IWire, solid: boolean, roundCorner: boolean): Result<TrackedShape>;
    /** A solid swept with a real support-normal frame; every path edge must lie on the trimmed face. */
    faceSweepTracked?(
        section: IWire,
        path: IWire,
        support: IFace,
        roundCorner: boolean,
    ): Result<TrackedShape>;
    /** @unit angle angle */
    revolve(profile: IShape, axis: Line, angle: number): Result<IShape>;
    booleanCommon(shape1: IShape[], shape2: IShape[]): Result<IShape>;
    booleanCut(shape1: IShape[], shape2: IShape[]): Result<IShape>;
    booleanFuse(shape1: IShape[], shape2: IShape[], simplifyShape: boolean): Result<IShape>;
    sewing(shapes: IShape[]): Result<IShape>;
    combine(shapes: IShape[]): Result<ICompound>;
    /** Deep copy with explicit native ModifiedShape face/edge ancestry. */
    copyTracked?(shape: IShape): Result<TrackedShape>;
    /** @unit length thickness */
    makeThickSolidBySimple(shape: IShape, thickness: number): Result<IShape>;
    /**
     * `joinType: "intersection"` on a shape with more faces than
     * `Config.thickSolidIntersectionMaxFaces` is refused: OCCT's intersection join may never
     * finish on many narrow faces, and a kernel call cannot be interrupted (docs/kernel.md).
     * @unit length thickness
     */
    makeThickSolidByJoin(
        shape: IShape,
        openFaces: IShape[],
        thickness: number,
        joinType: JoinType,
        mode?: OffsetMode,
        intersection?: boolean,
    ): Result<IShape>;
    /** @unit length radius */
    fillet(shape: IShape, edges: number[], radius: number): Result<IShape>;
    /** OCCT smooth radius interpolation per selected edge; normalized arc length, natural curve direction.
     * Tangent edges propagate automatically. Select one edge per tangent contour; closed contours require equal endpoint radii.
     * Optional for older kernels: callers must report unavailable support rather than substitute a constant radius.
     */
    filletVariableRadius?(shape: IShape, edges: number[], law: readonly FilletRadiusSample[]): Result<IShape>;
    filletVariableRadiusTracked?(
        shape: IShape,
        edges: number[],
        law: readonly FilletRadiusSample[],
    ): Result<TrackedShape>;
    /** @unit length distance */
    chamfer(shape: IShape, edges: number[], distance: number): Result<IShape>;
    prismTracked?(shape: IShape, vec: XYZ): Result<TrackedShape>;
    /**
     * Exact curved starting cap, with profile-relative history; offset is along direction.
     * @unit length offset
     */
    prismFromTracked?(
        profile: IShape,
        direction: XYZ,
        fromFace: IFace,
        offset: number,
        end: PrismFromEnd,
    ): Result<TrackedShape>;
    /**
     * Tool prism of the planar `profile` face(s) along `direction` (only its sense counts),
     * ending on `untilFace` moved by `offset` along the direction — any surface: planar,
     * tilted, curved, of this body or another. The face itself bounds the prism when it
     * intercepts the whole profile, else its untrimmed surface does (a plane extended, a
     * cylinder closed). The result is a tool like `prismTracked`'s, combined with a body
     * through the tracked booleans (join/cut); two-sided extents call it once per side.
     * Same channels as `prismTracked`: `faceMap`/`edgeMap`/`faceEdgeMap` relative to the
     * profile, `capFaces` = the pieces lying on the target surface — so the ids stay stable
     * when the target moves or resizes. Errors (never a kernel abort): zero or in-plane
     * direction, a target that is not a face or has no surface, a target parallel to the
     * direction, behind the profile, or not bounding it.
     * @unit length offset
     */
    prismUntilTracked?(
        profile: IShape,
        direction: XYZ,
        untilFace: IFace,
        offset?: number,
    ): Result<TrackedShape>;
    /**
     * Exact nearest complete candidate cap; never reverses direction or extends a trimmed target.
     * @unit length offset
     */
    prismNextTracked?(
        profile: IShape,
        direction: XYZ,
        candidates: IShape[],
        offset?: number,
        start?: { face: IFace; offset: number },
    ): Result<TrackedShape>;
    /**
     * Tool prism of `profile` along `direction` through everything in `bounds`: it ends on
     * the plane normal to the direction at their farthest point (`flush`, for a join) or
     * past it (default, for a cut). The end face is flat and reported in `capFaces`; other
     * channels as `prismTracked`. Errors when nothing of `bounds` lies ahead of the profile.
     */
    prismThruAllTracked?(
        profile: IShape,
        direction: XYZ,
        bounds: IShape[],
        flush?: boolean,
    ): Result<TrackedShape>;
    /** @unit angle angle */
    revolveTracked?(profile: IShape, axis: Line, angle: number): Result<TrackedShape>;
    booleanCommonTracked?(shape1: IShape[], shape2: IShape[]): Result<TrackedShape>;
    booleanCutTracked?(shape1: IShape[], shape2: IShape[]): Result<TrackedShape>;
    booleanFuseTracked?(shape1: IShape[], shape2: IShape[]): Result<TrackedShape>;
    /** @unit length radius */
    filletTracked?(shape: IShape, edges: number[], radius: number): Result<TrackedShape>;
    /** @unit length distance */
    chamferTracked?(shape: IShape, edges: number[], distance: number): Result<TrackedShape>;
    /** @unit length radius */
    fillet2d(face: IFace, edge1: IEdge, edge2: IEdge, radius: number): Result<IFace>;
    /** @unit length distance */
    chamfer2d(face: IFace, edge1: IEdge, edge2: IEdge, distance: number): Result<IFace>;
    /** @unit length radius */
    filletEdge2d(edge1: IEdge, edge2: IEdge, radius: number): Result<IEdge[]>;
    /** @unit length distance */
    chamferEdge2d(edge1: IEdge, edge2: IEdge, distance: number): Result<IEdge[]>;
    /**
     * Lofts through `sections` in order. A section is a vertex (only as the first or last),
     * a wire, an edge, a face (its outer wire) or a compound of edges such as a
     * sketch's loose entities, whose edges must form exactly ONE connected chain — several
     * chains are an error naming the section. Open chains are valid sections.
     */
    loft(sections: IShape[], isSolid: boolean, isRuled: boolean, continuity: Continuity): Result<IShape>;
    removeFeature(shape: IShape, faces: IFace[]): Result<IShape>;
    removeFillet(
        shape: IShape,
        faces: IFace[],
    ): Result<{
        shape: IShape;
        newEdges: IEdge[];
    }>;
    removeSubShape(shape: IShape, subShapes: IShape[]): Result<IShape>;
    replaceSubShapes(shape: IShape, oldSubShapes: IShape[], newSubShapes: IShape[]): Result<IShape>;
    curveProjection(curve: IEdge | IWire, targetFace: IFace, vec: XYZ): Result<IShape>;
    /**
     * @unit length linearTolerance
     * @unit none angleTolerance
     */
    simplifyShape(
        shape: IShape,
        removeEdges: boolean,
        removeFaces: boolean,
        keepShapes: IShape[],
        linearTolerance?: number,
        angleTolerance?: number,
    ): Result<IShape>;
}

/** Preparation snapshots inputs synchronously. take() alone creates local results, exactly once. */
export interface IAsyncShapeOperation<T> {
    readonly ready: Promise<void>;
    /** After failed take(): only compatibility failures may be retried by the synchronous kernel. */
    readonly canFallback?: boolean;
    take(): Result<T>;
    /** Idempotent, also discards a completed but untaken result. */
    cancel(): void;
}

export interface AsyncTrackedBoolean {
    readonly result: TrackedShape;
    /** Owned immutable replicas in args-then-tools order, for geometry history completion. */
    readonly inputs: IShape[];
}

export interface IAsyncShapeFactory {
    readonly available?: boolean;
    /** Persistent native failure. Synchronous compatibility paths must not bypass this quarantine. */
    readonly failure?: string;
    /** Undefined means use the synchronous path (unsupported/unavailable backend). */
    booleanTracked(
        operation: "fuse" | "cut" | "common",
        args: IShape[],
        tools: IShape[],
        options?: { mesh?: boolean },
    ): IAsyncShapeOperation<AsyncTrackedBoolean> | undefined;
}

/** Whitelisted factory operations. Native handles never leave their owning realm. */
export type BoundedShapeRequest =
    | {
          method: "booleanFuse" | "booleanCut" | "booleanCommon";
          left: IShape[];
          right: IShape[];
          simplifyShape?: boolean;
      }
    | { method: "fillet" | "chamfer"; shape: IShape; edges: number[]; value: number }
    | { method: "loft"; sections: IShape[]; isSolid: boolean; isRuled: boolean; continuity: Continuity }
    | { method: "makeThickSolidBySimple"; shape: IShape; thickness: number }
    | {
          method: "makeThickSolidByJoin";
          shape: IShape;
          closingFaces: IShape[];
          thickness: number;
          joinType: JoinType;
          mode: OffsetMode;
          intersection: boolean;
      };

export interface IBoundedShapeFactory {
    shapeOperation(request: BoundedShapeRequest, signal?: AbortSignal): IAsyncShapeOperation<IShape>;
}
