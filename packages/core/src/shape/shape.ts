// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDisposable, Result } from "../foundation";
import type { BoundingBox, Line, Matrix4, OrientedBoundingBox, Plane, XYZ, XYZLike } from "../math";
import type { Continuity, ICurve, ITrimmedCurve } from "./curve";
import type { EdgeMeshData, IShapeMeshData } from "./meshData";
import type { ShapeType } from "./shapeType";
import type { ISurface } from "./surface";

export type Orientation = "forward" | "reversed" | "internal" | "external";

/** Optional runtime display capability; the canonical mesh remains at full quality. */
export interface IProgressiveMeshShape {
    createCoarseDisplayMesh(deflection: number): (IShapeMeshData & IDisposable) | undefined;
}

/** Runtime capability for inspection guards, separate from the agent-facing shape query API. */
export interface IInspectionPrecheck {
    /** Whether this input needs a worker pre-check (kernel binding and inspection face cutoff). */
    readonly needsInspectionSelfIntersectionCheck: boolean;
    /** Runtime-only receipt of checks for these exact input objects, never exposed in tool schemas. */
    inspectionCommonVolume?(other: IShape, validated: ReadonlySet<IShape>): Result<number>;
    inspectionSectionCaps?(plane: Plane, validated: ReadonlySet<IShape>): Result<IShape>;
}

export interface IShape extends IDisposable {
    readonly shapeType: ShapeType;
    get id(): string;
    get mesh(): IShapeMeshData;
    transformed(matrix: Matrix4): IShape;
    transformedMul(matrix: Matrix4): IShape;
    edgesMeshPosition(): EdgeMeshData;
    matrix: Matrix4;
    isClosed(): boolean;
    isNull(): boolean;
    /**
     * they share the same TShape with the same Locations and Orientations.
     */
    isEqual(other: IShape): boolean;
    /**
     * they share the same TShape with the same Locations, Orientations may differ.
     */
    isSame(other: IShape): boolean;
    /**
     * they share the same TShape. Locations and Orientations may differ.
     */
    isPartner(other: IShape): boolean;
    orientation(): Orientation;
    findAncestor(ancestorType: ShapeType, fromShape: IShape): IShape[];
    findSubShapes(subshapeType: ShapeType): IShape[];
    directSubShapes(): IShape[];
    section(shape: IShape | Plane): IShape;
    /** @unit length tolerance */
    split(shapes: IShape[], tolerance?: number): IShape;
    reserve(): void;
    /**
     * An independent copy of this shape. Through run_program (`shape.clone`) the copy becomes
     * its own scene node next to the source, so edit ops on the clone consume the copy, never
     * the source.
     */
    clone(): IShape;
    hlr(position: XYZLike, direction: XYZLike, xDir: XYZLike): IShape;
    boundingBox(): BoundingBox;
    /** Conservative world-space bounds from geometry, without creating a render mesh. */
    geometryBoundingBox(): BoundingBox;
    orientedBoundingBox(): OrientedBoundingBox;
    extremaDistance(other: IShape): number;
    /** Exact closest points in world coordinates, or an error for missing geometry. */
    inspectionDistance?(other: IShape): Result<{ distance: number; first: XYZ; second: XYZ }>;
    /** Volume of the boolean common, in cubic document units; zero also covers touching. */
    inspectionCommonVolume?(other: IShape): Result<number>;
    /** Volume and centroid of a valid solid in world coordinates. */
    inspectionMass?(): Result<{ volume: number; center: XYZ }>;
    /** Exact planar cap faces of the positive-side cut; empty compound if no cut. */
    inspectionSectionCaps?(plane: Plane): Result<IShape>;
    /**
     * Topology validity (BRepCheck_Analyzer). It does not test self-intersection. Run it on
     * offset / thickened results before booleans or inspections.
     */
    checkShape(): boolean;
    checkFaces(): { index: number; isValid: boolean; status: string[] }[];
    /**
     * true when the shape has no self-intersection (each solid tested on its own; a shape
     * without solids as a whole), false when faces cross or the test could not complete. It
     * intersects faces pairwise: expensive on shapes with many faces. An error when the kernel
     * build has no such check.
     */
    checkSelfIntersection?(): Result<boolean>;
    /** Empty when clean; otherwise output face indices and approximate faulty region xyz (mm).
     * An error means the check could not complete. Use the bounded worker for expensive shapes.
     */
    selfIntersectionDetails?(): Result<string>;
    /** @unit length tolerance */
    fixShape(tolerance: number): IShape;
    /** @unit length tolerance */
    fixSmallFace(tolerance: number): IShape;
    /** @unit length tolerance */
    fixSolid(tolerance: number): IShape;
    /** @unit length tolerance */
    shellSewing(tolerance: number): IShape;
    /** @unit length tolerance */
    setTolerance(tolerance: number): void;
    volume(): number;
}

export interface ISubShape extends IShape {
    /** Position in parent.findSubShapes(shapeType), independent of mesh-range order or omissions. */
    index: number;
    parent: IShape;
}

export interface ISubVertexShape extends ISubShape, IVertex {}

export interface ISubEdgeShape extends ISubShape, IEdge {}

export interface ISubFaceShape extends ISubShape, IFace {}

export interface IVertex extends IShape {
    point(): XYZ;
}

export interface IEdge extends IShape {
    update(curve: ICurve): void;
    intersect(other: IEdge | Line): { parameter: number; point: XYZ }[];
    length(): number;
    get curve(): ITrimmedCurve;
    firstParameter(): number;
    lastParameter(): number;
    /** @unit none parameter */
    pointAt(parameter: number): XYZ;
    startPoint(): XYZ;
    endPoint(): XYZ;
    ends(): [start: XYZ, end: XYZ];
    /** @unit length distance */
    offset(distance: number, dir: XYZ): Result<IEdge>;
    /**
     * Trims the edge to the parameter window [start, end]. Returns `undefined`
     * when the window is empty within tolerance — the kernel reports that as a
     * null edge instead of raising.
     * @unit none start end
     */
    trim(start: number, end: number): IEdge | undefined;
    hasContinuity(face1: IFace, face2: IFace): boolean;
    continuity(face1: IFace, face2: IFace): Continuity;
}

export type JoinType = "arc" | "tangent" | "intersection";

export type OffsetMode = "skin" | "pipe" | "rectoVerso";

export interface IWire extends IShape {
    toFace(): Result<IFace>;
    edgeLoop(): IEdge[];
    /** @unit length distance */
    offset(distance: number, joinType: JoinType): Result<IShape>;
}

export interface IFace extends IShape {
    /** @unit none parameter */
    inspectionTrimmedIso?(direction: "u" | "v", parameter: number): IShape | undefined;
    inspectionUVBounds?(): Result<{ u1: number; u2: number; v1: number; v2: number }>;
    /** @unit length minDistance maxDistance tolerance */
    inspectionRayHit?(
        point: XYZLike,
        direction: XYZLike,
        minDistance: number,
        maxDistance: number,
        tolerance?: number,
    ): Result<XYZ | undefined>;
    area(): number;
    /**
     * Point and outward unit normal at surface parameters (u, v), following the face orientation.
     * The normal is the zero vector for a surface-less face or where the surface derivatives degenerate
     * (|dS/du x dS/dv| <= 1e-12, e.g. at a sphere pole).
     * @unit none u v
     */
    normal(u: number, v: number): [point: XYZ, normal: XYZ];
    outerWire(): IWire;
    surface(): ISurface;
    /** @unit length tolerance */
    intersectLine(point: XYZLike, direction: XYZLike, tolerance?: number): XYZ | undefined;
    segmentsOfEdgeOnFace(edge: IEdge):
        | undefined
        | {
              start: number;
              end: number;
          };
    /** @unit length tolerance */
    containsPoint(point: XYZLike, containsEdge: boolean, tolerance: number): boolean;
}

export interface IShell extends IShape {}

export interface ISolid extends IShape {
    /** @unit length tolerance */
    containsPoint(point: XYZLike, containsSurface: boolean, tolerance: number): boolean;
}

export interface ICompound extends IShape {}

export interface ICompoundSolid extends IShape {}
