// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    type Continuity,
    type EdgeMeshData,
    type FaceMeshData,
    gc,
    type ICompound,
    type ICompoundSolid,
    type ICurve,
    type IDisposable,
    Id,
    type IEdge,
    type IFace,
    type IShape,
    type IShapeMeshData,
    type IShell,
    type ISolid,
    type ISubEdgeShape,
    type ISubFaceShape,
    type ISubVertexShape,
    type ISurface,
    type ITrimmedCurve,
    type IVertex,
    type IWire,
    isDisposable,
    type JoinType,
    Line,
    Logger,
    MathUtils,
    type Matrix4,
    MeshUtils,
    type Orientation,
    type OrientedBoundingBox,
    PerformanceTrace,
    Plane,
    Result,
    type Serialized,
    type SerializedData,
    type ShapeMeshRange,
    type ShapeType,
    ShapeTypes,
    serializable,
    type VertexMeshData,
    VisualConfig,
    XYZ,
    type XYZLike,
} from "@spicy3d/core";
import type {
    EdgeMeshData as OccEdgeMeshData,
    FaceMeshData as OccFaceMeshData,
    TopoDS_Compound,
    TopoDS_CompSolid,
    TopoDS_Edge,
    TopoDS_Face,
    TopoDS_Shape,
    TopoDS_Shell,
    TopoDS_Solid,
    TopoDS_Vertex,
    TopoDS_Wire,
} from "../lib/spicy-wasm";
import { OccCurve, OccTrimmedCurve } from "./curve";
import {
    convertFromMatrix,
    convertToContinuity,
    convertToMatrix,
    getJoinType,
    getOrientation,
    getShapeEnum,
    getShapeType,
    toDir,
    toPnt,
    toXYZ,
} from "./helper";
import { OccSurface } from "./surface";

/** Answer of `checkSelfIntersection` when the loaded module has no such binding. */
export const SELF_INTERSECTION_UNAVAILABLE = "Self-intersection check is not available in this kernel build";

type SelfIntersectionCheck = (shape: TopoDS_Shape) => boolean;

/**
 * `Shape.checkSelfIntersection` of the loaded module, or undefined when the module predates it
 * (a build older than the binding; the committed binary has it): feature-detected on each call.
 */
function selfIntersectionBinding(): SelfIntersectionCheck | undefined {
    const shapeClass = wasm.Shape as unknown as { checkSelfIntersection?: unknown };
    const check = shapeClass.checkSelfIntersection;
    if (typeof check !== "function") return undefined;
    return (shape) => Boolean(check.call(shapeClass, shape));
}

export interface OccShapeOptions {
    shape: TopoDS_Shape;
    id?: string;
}

function occShapeSerialize(target: OccShape): SerializedData {
    return {
        shape: target.serializedBrep(),
        id: target.id,
    };
}

function occShapeDeserialize(properties: Serialized) {
    return OccShape.wrap(
        wasm.Converter.convertFromBrep(properties["shape"] as string),
        properties["id"],
    ) as OccShape;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccShape implements IShape {
    // Tolerances are stored on shared native subshapes, so changing one invalidates parent exports too.
    private static toleranceRevision = 0;
    private serializedToleranceRevision = -1;
    private _serializedBrep?: string;

    /** Runtime-only export cache; document payloads keep exactly the existing BREP/id shape. */
    serializedBrep(): string {
        if (this.serializedToleranceRevision !== OccShape.toleranceRevision) this.invalidateSerializedBrep();
        this._serializedBrep ??= wasm.Converter.convertToBrep(this.shape);
        this.serializedToleranceRevision = OccShape.toleranceRevision;
        return this._serializedBrep;
    }

    /** Native geometry mutations and display triangulation changes invalidate the export. */
    invalidateSerializedBrep(): void {
        this._serializedBrep = undefined;
    }

    private _boundingBox: BoundingBox | undefined;
    protected _geometryBoundingBox: BoundingBox | undefined;
    private _orientedBoundingBox: OrientedBoundingBox | undefined;

    readonly shapeType: ShapeType;
    protected _mesh: IShapeMeshData | undefined;
    private transientTriangulation = false;
    private replicaInvalidations?: Set<() => void>;
    get mesh(): IShapeMeshData {
        this._mesh ??= new Mesher(this, this.transientTriangulation);
        return this._mesh;
    }

    /** Hybrid prefix replicas retain analytic geometry, not a second native copy of render buffers. */
    useTransientTriangulation(): void {
        this.transientTriangulation = true;
    }

    /** Explicit native-cache lifetime, independent of GC or FinalizationRegistry. */
    addReplicaInvalidation(handler: () => void): () => void {
        if (this.#isDisposed) {
            handler();
            return () => {};
        }
        this.replicaInvalidations ??= new Set();
        this.replicaInvalidations.add(handler);
        return () => this.replicaInvalidations?.delete(handler);
    }

    protected invalidateReplicas(): void {
        this.invalidateSerializedBrep();
        if (this.replicaInvalidations) for (const handler of this.replicaInvalidations) handler();
    }

    /** A verified worker mesh, with pick ranges bound to this local replica's topology. */
    installMesh(mesh: IShapeMeshData & IDisposable): void {
        if (isDisposable(this._mesh)) this._mesh.dispose();
        this._mesh = mesh;
        this._boundingBox = undefined;
    }

    protected _shape: TopoDS_Shape;
    get shape(): TopoDS_Shape {
        return this._shape;
    }

    readonly id: string;

    get matrix(): Matrix4 {
        return gc((c) => {
            return convertToMatrix(c(c(this.shape.getLocation()).transformation()));
        });
    }

    set matrix(matrix: Matrix4) {
        this.invalidateReplicas();
        gc((c) => {
            const location = c(new wasm.TopLoc_Location(c(convertFromMatrix(matrix))));
            this._shape.setLocation(location, false);
            // Location replaces the previous transform; recompute from geometry rather
            // than transforming an already world-space box (which also loosens rotations).
            this._geometryBoundingBox = undefined;

            if (this._boundingBox) {
                this._boundingBox = BoundingBox.transformed(this._boundingBox, matrix);
            }
            if (this._orientedBoundingBox) {
                this._orientedBoundingBox = {
                    center: {
                        location: matrix.ofPoint(this._orientedBoundingBox.center.location),
                        xDirection: matrix.ofVector(this._orientedBoundingBox.center.xDirection),
                        direction: matrix.ofVector(this._orientedBoundingBox.center.direction),
                    },
                    size: this._orientedBoundingBox.size,
                };
            }

            this.onTransformChanged();
        });
    }

    constructor(options: OccShapeOptions) {
        this.id = options.id ?? Id.generate();
        this._shape = options.shape;
        this.shapeType = getShapeType(options.shape);
    }

    static wrap(shape: TopoDS_Shape, id?: string): IShape {
        switch (shape.shapeType()) {
            case wasm.TopAbs_ShapeEnum.TopAbs_COMPOUND:
                return new OccCompound({ shape: wasm.TopoDS.compound(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_COMPSOLID:
                return new OccCompSolid({ shape: wasm.TopoDS.compsolid(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_SOLID:
                return new OccSolid({ shape: wasm.TopoDS.solid(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_SHELL:
                return new OccShell({ shape: wasm.TopoDS.shell(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_FACE:
                return new OccFace({ shape: wasm.TopoDS.face(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_WIRE:
                return new OccWire({ shape: wasm.TopoDS.wire(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_EDGE:
                return new OccEdge({ shape: wasm.TopoDS.edge(shape), id });
            case wasm.TopAbs_ShapeEnum.TopAbs_VERTEX:
                return new OccVertex({ shape: wasm.TopoDS.vertex(shape), id });
            default:
                return new OccShape({ shape, id });
        }
    }

    boundingBox(): BoundingBox {
        // Query geometry bounds without building a display mesh. Bounds that depend on
        // whether meshing happened first would make the face fingerprints built on them
        // (ProfileRef centers) order-dependent.
        this._boundingBox ??= wasm.Shape.boundingBox(this.shape, false);
        return this._boundingBox;
    }

    orientedBoundingBox(): OrientedBoundingBox {
        if (!this._orientedBoundingBox) {
            this._orientedBoundingBox = wasm.Shape.orientedBoundingBox(this.shape, this._mesh !== undefined);
        }
        return this._orientedBoundingBox;
    }

    geometryBoundingBox(): BoundingBox {
        this._geometryBoundingBox ??= wasm.Shape.boundingBox(this.shape, false);
        return this._geometryBoundingBox;
    }

    transformed(matrix: Matrix4): IShape {
        return gc((c) => {
            const location = c(new wasm.TopLoc_Location(c(convertFromMatrix(matrix))));
            const shape = this._shape.located(location, false); // TODO: check if this is correct
            return OccShape.wrap(shape);
        });
    }

    transformedMul(matrix: Matrix4): IShape {
        return gc((c) => {
            return OccShape.wrap(wasm.Shape.transformed(this._shape, c(convertFromMatrix(matrix))));
        });
    }

    protected onTransformChanged(): void {
        if (this._mesh) {
            Logger.warn("Shape matrix changed, mesh will be recreated");
            if (isDisposable(this._mesh)) this._mesh.dispose();
            this._mesh = undefined;
        }
    }

    edgesMeshPosition(): EdgeMeshData {
        const occMesher = new wasm.Mesher(this.shape, 0.005, true);
        const position = occMesher.edgesMeshPosition();
        occMesher.delete();
        return {
            lineType: "solid",
            position: new Float32Array(position),
            range: [],
            color: VisualConfig.defaultEdgeColor,
        };
    }

    extremaDistance(other: IShape): number {
        if (other instanceof OccShape) {
            return wasm.Shape.extremaDistance(this.shape, other.shape);
        }
        throw new Error("Invalid shape type");
    }

    inspectionDistance(other: IShape): Result<{ distance: number; first: XYZ; second: XYZ }> {
        if (!(other instanceof OccShape) || this.isNull() || other.isNull()) {
            return Result.err("Inspection requires two non-null OCCT shapes");
        }
        const value = wasm.Shape.inspectionDistance(this.shape, other.shape);
        if (
            !value ||
            !Number.isFinite(value.distance) ||
            value.distance < 0 ||
            ![
                value.first.x,
                value.first.y,
                value.first.z,
                value.second.x,
                value.second.y,
                value.second.z,
            ].every(Number.isFinite)
        ) {
            return Result.err("Closest points are unavailable");
        }
        return Result.ok({
            distance: value.distance,
            first: toXYZ(value.first),
            second: toXYZ(value.second),
        });
    }

    inspectionCommonVolume(other: IShape): Result<number> {
        if (!(other instanceof OccShape) || this.isNull() || other.isNull()) {
            return Result.err("Intersection requires two non-null OCCT shapes");
        }
        // The kernel's boolean may raise on an invalid solid; do not call into it with one.
        if (!this.checkShape()) {
            return Result.err("Intersection volume: the target shape is invalid (checkShape is false)");
        }
        if (!other.checkShape()) {
            return Result.err("Intersection volume: the other shape is invalid (checkShape is false)");
        }
        const value = wasm.Shape.inspectionCommonVolume(this.shape, other.shape);
        return value == null || !Number.isFinite(value) || value < 0
            ? Result.err("Intersection volume is unavailable")
            : Result.ok(value);
    }

    inspectionMass(): Result<{ volume: number; center: XYZ }> {
        if (
            this.isNull() ||
            (this.shapeType !== ShapeTypes.solid &&
                this.shapeType !== ShapeTypes.compound &&
                this.shapeType !== ShapeTypes.compoundSolid)
        ) {
            return Result.err("Volume center requires a non-null solid or solid compound");
        }
        if (!this.checkShape()) {
            return Result.err("Volume center: the shape is invalid (checkShape is false)");
        }
        const value = wasm.Shape.inspectionMass(this.shape);
        return value &&
            Number.isFinite(value.volume) &&
            value.volume > 0 &&
            [value.center.x, value.center.y, value.center.z].every(Number.isFinite)
            ? Result.ok({ volume: value.volume, center: toXYZ(value.center) })
            : Result.err("Volume center is unavailable");
    }

    clone(): IShape {
        return OccShape.wrap(wasm.Shape.clone(this._shape));
    }

    isClosed(): boolean {
        return wasm.Shape.isClosed(this.shape);
    }

    isNull(): boolean {
        return this.shape.isNull();
    }

    isEqual(other: IShape): boolean {
        if (other instanceof OccShape) {
            return this.shape.isEqual(other.shape);
        }
        return false;
    }

    isSame(other: IShape): boolean {
        if (other instanceof OccShape) {
            return this.shape.isSame(other.shape);
        }
        return false;
    }

    isPartner(other: IShape): boolean {
        if (other instanceof OccShape) {
            return this.shape.isPartner(other.shape);
        }
        return false;
    }

    orientation(): Orientation {
        return getOrientation(this.shape);
    }

    findAncestor(ancestorType: ShapeType, fromShape: IShape): IShape[] {
        if (fromShape instanceof OccShape) {
            return wasm.Shape.findAncestor(fromShape.shape, this.shape, getShapeEnum(ancestorType)).map((x) =>
                OccShape.wrap(x),
            );
        }
        return [];
    }

    findSubShapes(subshapeType: ShapeType): IShape[] {
        return wasm.Shape.findSubShapes(this.shape, getShapeEnum(subshapeType)).map((x) => OccShape.wrap(x));
    }

    directSubShapes(): IShape[] {
        let subShape = wasm.Shape.getDirectSubShapes(this.shape);
        if (subShape.length === 1 && subShape[0].shapeType() === this.shape.shapeType()) {
            subShape = wasm.Shape.getDirectSubShapes(subShape[0]);
        }
        return subShape.map((x) => OccShape.wrap(x));
    }

    volume(): number {
        return wasm.Shape.volume(this.shape);
    }

    inspectionSectionCaps(plane: Plane): Result<IShape> {
        if (
            this.isNull() ||
            (this.shapeType !== ShapeTypes.solid &&
                this.shapeType !== ShapeTypes.compound &&
                this.shapeType !== ShapeTypes.compoundSolid) ||
            ![...plane.origin.toArray(), ...plane.normal.toArray(), ...plane.xvec.toArray()].every(
                Number.isFinite,
            )
        ) {
            return Result.err("Section caps require a valid solid and finite plane");
        }
        const caps = wasm.Shape.inspectionSectionCaps(this.shape, {
            location: plane.origin,
            direction: plane.normal,
            xDirection: plane.xvec,
        });
        return caps.isNull() ? Result.err("Section caps are unavailable") : Result.ok(OccShape.wrap(caps));
    }

    section(shape: IShape | Plane): IShape {
        if (shape instanceof OccShape) {
            const section = wasm.Shape.sectionSS(this.shape, shape.shape);
            return OccShape.wrap(section);
        }
        if (shape instanceof Plane) {
            const section = wasm.Shape.sectionSP(this.shape, {
                location: shape.origin,
                direction: shape.normal,
                xDirection: shape.xvec,
            });
            return OccShape.wrap(section);
        }

        throw new Error("Unsupported type");
    }

    fixShape(tolerance: number): IShape {
        return OccShape.wrap(wasm.ShapeFactory.fixShape(this.shape, tolerance).shape);
    }

    fixSmallFace(tolerance: number): IShape {
        return OccShape.wrap(wasm.ShapeFactory.fixSmallFace(this.shape, tolerance).shape);
    }

    fixSolid(tolerance: number): IShape {
        return OccShape.wrap(wasm.ShapeFactory.fixSolid(this.shape, tolerance).shape);
    }

    split(shapes: IShape[], tolerance: number = 1e-5): IShape {
        const occShapes = shapes.map((x) => {
            if (x instanceof OccShape) {
                return x.shape;
            }
            throw new Error("Unsupported type");
        });
        return OccShape.wrap(wasm.Shape.splitShapes([this.shape], occShapes, tolerance));
    }

    reserve(): void {
        this.invalidateReplicas();
        this.shape.reverse();
    }

    setTolerance(tolerance: number): void {
        this.invalidateReplicas();
        OccShape.toleranceRevision++;
        wasm.Shape.setTolerance(this.shape, tolerance);
        this._geometryBoundingBox = undefined;
    }

    hlr(position: XYZLike, direction: XYZLike, xDir: XYZLike): IShape {
        return gc((c) => {
            const shape = wasm.Shape.hlr(this.shape, c(toPnt(position)), c(toDir(direction)), c(toDir(xDir)));
            return OccShape.wrap(shape);
        });
    }

    shellSewing(tolerance: number) {
        return OccShape.wrap(wasm.Shape.shellSewing(this.shape, tolerance));
    }

    checkShape(): boolean {
        return wasm.Shape.check(this.shape);
    }

    checkSelfIntersection(): Result<boolean> {
        const check = selfIntersectionBinding();
        if (!check) return Result.err(SELF_INTERSECTION_UNAVAILABLE);
        if (this.isNull()) return Result.err("Self-intersection check requires a non-null shape");
        try {
            return Result.ok(check(this.shape));
        } catch (err) {
            return Result.err(
                `CheckSelfIntersection failed: ${err instanceof Error ? err.message || err.name : String(err)}`,
            );
        }
    }

    checkFaces(): { index: number; isValid: boolean; status: string[] }[] {
        const vec = wasm.Shape.checkFaces(this.shape);
        const results: { index: number; isValid: boolean; status: string[] }[] = [];
        for (let i = 0; i < vec.size(); i++) {
            const item = vec.get(i);
            if (!item) continue;
            results.push({
                index: item.index,
                isValid: item.isValid,
                status: item.status ? (item.status as string).split(", ") : [],
            });
        }
        return results;
    }

    #isDisposed = false;
    readonly dispose = () => {
        if (!this.#isDisposed) {
            this.#isDisposed = true;
            try {
                this.invalidateReplicas();
            } finally {
                this.replicaInvalidations?.clear();
                this.disposeInternal();
            }
        }
    };

    protected disposeInternal(): void {
        this._shape.nullify();
        this._shape.delete();
        this._shape = null as any;

        if (this._mesh && isDisposable(this._mesh)) {
            this._mesh.dispose();
            this._mesh = null as any;
        }
    }
}

export interface OccVertexOptions {
    shape: TopoDS_Vertex;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccVertex extends OccShape implements IVertex {
    readonly vertex: TopoDS_Vertex;

    constructor(options: OccVertexOptions) {
        super(options);
        this.vertex = options.shape;
    }

    point(): XYZ {
        return toXYZ(wasm.Vertex.point(this.vertex));
    }
}

export interface OccEdgeOptions {
    shape: TopoDS_Edge;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccEdge extends OccShape implements IEdge {
    private _edge: TopoDS_Edge;
    get edge(): TopoDS_Edge {
        return this._edge;
    }

    constructor(options: OccEdgeOptions) {
        super(options);
        this._edge = options.shape;
    }

    update(curve: ICurve): void {
        if (!(curve instanceof OccCurve)) {
            throw new Error("Invalid curve");
        }
        this.invalidateReplicas();
        this._shape = wasm.Edge.fromCurve(curve.curve);
        this._geometryBoundingBox = undefined;
        this._mesh = undefined;
        this._ends = undefined;
    }

    intersect(other: IEdge | Line): { parameter: number; point: XYZ }[] {
        return gc((c) => {
            let edge: TopoDS_Edge | undefined;
            if (other instanceof OccEdge) {
                edge = other.edge;
            }
            if (other instanceof Line) {
                const line = c(wasm.Curve.makeLine(other.point, other.direction));
                edge = c(wasm.Edge.fromCurve(line.get()));
            }
            if (edge === undefined) {
                throw new Error("Unsupported type");
            }
            return wasm.Edge.intersect(this.edge, edge).map((x) => ({
                parameter: x.parameter,
                point: toXYZ(x.point),
            }));
        });
    }

    length(): number {
        return wasm.Edge.curveLength(this.edge);
    }

    firstParameter(): number {
        return wasm.Edge.firstParameter(this.edge);
    }

    lastParameter(): number {
        return wasm.Edge.lastParameter(this.edge);
    }

    pointAt(parameter: number): XYZ {
        return toXYZ(wasm.Edge.pointAt(this.edge, parameter));
    }

    // Endpoints are kernel queries hit in O(n²) loops (sketch profile grouping), so both
    // are fetched in one call and kept until the geometry or placement changes.
    private _ends: [start: XYZ, end: XYZ] | undefined;

    startPoint(): XYZ {
        return this.ends()[0];
    }

    endPoint(): XYZ {
        return this.ends()[1];
    }

    ends(): [start: XYZ, end: XYZ] {
        if (!this._ends) {
            const points = wasm.Edge.ends(this.edge);
            this._ends = [toXYZ(points[0]), toXYZ(points[1])];
        }
        // A fresh tuple so callers cannot swap the cached entries.
        return [this._ends[0], this._ends[1]];
    }

    private _curve: ITrimmedCurve | undefined;
    get curve(): ITrimmedCurve {
        this._curve ??= gc((c) => {
            const curve = c(wasm.Edge.curve(this.edge));
            return new OccTrimmedCurve(curve.get()!);
        });
        return this._curve as ITrimmedCurve;
    }

    protected override onTransformChanged(): void {
        super.onTransformChanged();
        this._ends = undefined;
        if (this._curve) {
            this._curve.dispose();
            this._curve = undefined;
        }
    }

    offset(distance: number, dir: XYZ): Result<IEdge> {
        return gc((c) => {
            const occDir = c(toDir(dir));
            if (MathUtils.anyEqualZero(distance)) {
                return Result.err("Invalid distance");
            }
            const edge = wasm.Edge.offset(this.edge, occDir, distance);
            if (edge.isNull()) {
                return Result.err("Offset failed");
            }
            return Result.ok(OccShape.wrap(edge));
        });
    }

    trim(start: number, end: number): IEdge | undefined {
        const newEdge = wasm.Edge.trim(this.edge, start, end);
        // Edge::trim returns a null edge for an empty (within tolerance) parameter
        // window instead of raising — surface that as undefined rather than
        // wrapping a null shape, like OccCurve.trim does for a null handle.
        if (newEdge.isNull()) return undefined;
        return new OccEdge({ shape: newEdge });
    }

    hasContinuity(face1: IFace, face2: IFace): boolean {
        if (face1 instanceof OccFace && face2 instanceof OccFace) {
            return wasm.BrepHelps.hasContinue(this._edge, face1.face, face2.face);
        }
        throw new Error("Invalid face types");
    }

    continuity(face1: IFace, face2: IFace): Continuity {
        if (face1 instanceof OccFace && face2 instanceof OccFace) {
            return convertToContinuity(wasm.BrepHelps.continuity(this._edge, face1.face, face2.face));
        }
        throw new Error("Invalid face types");
    }

    protected override disposeInternal(): void {
        super.disposeInternal();
        if (this._curve && isDisposable(this._curve)) {
            this._curve.dispose();
            this._curve = null as any;
        }
    }
}

export interface OccWireOptions {
    shape: TopoDS_Wire;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccWire extends OccShape implements IWire {
    readonly wire: TopoDS_Wire;

    constructor(options: OccWireOptions) {
        super(options);
        this.wire = options.shape;
    }

    edgeLoop(): IEdge[] {
        return wasm.Wire.edgeLoop(this.wire).map((x) => OccShape.wrap(x)) as IEdge[];
    }

    toFace(): Result<IFace> {
        const face = wasm.Wire.makeFace(this.wire);
        if (face.isNull()) {
            return Result.err("To face failed");
        }
        return Result.ok(new OccFace({ shape: face }));
    }

    offset(distance: number, joinType: JoinType): Result<IShape> {
        if (MathUtils.anyEqualZero(distance)) {
            return Result.err("Invalid distance");
        }
        const offseted = wasm.Wire.offset(this.wire, distance, getJoinType(joinType));
        if (offseted.isNull()) {
            return Result.err("Offset failed");
        }
        return Result.ok(OccShape.wrap(offseted));
    }
}

export interface OccFaceOptions {
    shape: TopoDS_Face;
    id?: string;
}

// The kernel reports D1U ^ D1V, whose length depends on the surface parametrization.
// Below this length the direction is numerically meaningless (e.g. a sphere pole).
// Same cutoff as `minNormalLength` in Face::normal (cpp/src/shape.cpp); keep both in sync.
export const MIN_NORMAL_LENGTH = 1e-12;

export function unitOrZero(vector: XYZ): XYZ {
    const length = vector.length();
    return Number.isFinite(length) && length > MIN_NORMAL_LENGTH
        ? new XYZ({ x: vector.x / length, y: vector.y / length, z: vector.z / length })
        : new XYZ({ x: 0, y: 0, z: 0 });
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccFace extends OccShape implements IFace {
    readonly face: TopoDS_Face;

    constructor(options: OccFaceOptions) {
        super(options);
        this.face = options.shape;
    }

    inspectionTrimmedIso(direction: "u" | "v", parameter: number): IShape | undefined {
        if (!Number.isFinite(parameter)) return undefined;
        const shape = wasm.Face.inspectionTrimmedIso(this.face, direction === "u", parameter);
        return shape.isNull() ? undefined : OccShape.wrap(shape);
    }

    inspectionUVBounds(): Result<{ u1: number; u2: number; v1: number; v2: number }> {
        const bounds = wasm.Face.inspectionUVBounds(this.face);
        return bounds ? Result.ok(bounds) : Result.err("Face has no finite trimmed UV domain");
    }

    inspectionRayHit(
        point: XYZLike,
        direction: XYZLike,
        minDistance: number,
        maxDistance: number,
        tolerance = 1e-6,
    ): Result<XYZ | undefined> {
        const hit = wasm.Face.inspectionRayHit(
            this.face,
            point,
            direction,
            minDistance,
            maxDistance,
            tolerance,
        );
        return hit.valid
            ? Result.ok(hit.hasHit ? toXYZ(hit.point) : undefined)
            : Result.err("Forward ray could not be evaluated on this face");
    }

    area(): number {
        return wasm.Face.area(this.face);
    }

    normal(u: number, v: number): [point: XYZ, normal: XYZ] {
        return gc((c) => {
            const pnt = c(new wasm.gp_Pnt(0, 0, 0));
            const normal = c(new wasm.gp_Vec(0, 0, 0));
            wasm.Face.normal(this.shape, u, v, pnt, normal);
            return [toXYZ(pnt), unitOrZero(toXYZ(normal))];
        });
    }

    intersectLine(point: XYZLike, direction: XYZLike, tolerance: number = 0.001): XYZ | undefined {
        const int = wasm.Face.intersectLine(this.face, point, direction, tolerance);
        if (!int) return undefined;

        return toXYZ(int);
    }
    outerWire(): IWire {
        const wire = wasm.Face.outerWire(this.face);
        if (wire.isNull()) {
            throw new Error("Face.outerWire: face has no outer wire");
        }
        return new OccWire({ shape: wire });
    }
    surface(): ISurface {
        return gc((c) => {
            const handleSurface = c(wasm.Face.surface(this.face));
            const surface = handleSurface.get();
            if (surface === null) {
                throw new Error("Face.surface: face has no geometric surface");
            }
            return OccSurface.wrap(surface);
        });
    }
    segmentsOfEdgeOnFace(edge: IEdge): undefined | { start: number; end: number } {
        if (edge instanceof OccEdge) {
            const domain = wasm.Face.curveOnSurface(this.face, edge.edge);
            if (MathUtils.allEqualZero(domain.start, domain.end)) {
                return undefined;
            }
            return domain;
        }
        return undefined;
    }
    containsPoint(point: XYZLike, containsEdge: boolean, tolerance: number) {
        return wasm.Face.containsPoint(this.face, point, containsEdge, tolerance);
    }
}

export interface OccShellOptions {
    shape: TopoDS_Shell;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccShell extends OccShape implements IShell {
    constructor(options: OccShellOptions) {
        super(options);
    }
}

export interface OccSolidOptions {
    shape: TopoDS_Solid;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccSolid extends OccShape implements ISolid {
    readonly solid: TopoDS_Solid;

    constructor(options: OccSolidOptions) {
        super(options);
        this.solid = options.shape;
    }

    containsPoint(point: XYZLike, containsSurface: boolean, tolerance: number): boolean {
        return wasm.Solid.containsPoint(this.solid, point, containsSurface, tolerance);
    }
}

export interface OccCompSolidOptions {
    shape: TopoDS_CompSolid;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccCompSolid extends OccShape implements ICompoundSolid {
    constructor(options: OccCompSolidOptions) {
        super(options);
    }
}

export interface OccCompoundOptions {
    shape: TopoDS_Compound;
    id?: string;
}

@serializable({
    deserialize: occShapeDeserialize,
    serialize: occShapeSerialize,
})
export class OccCompound extends OccShape implements ICompound {
    constructor(options: OccCompoundOptions) {
        super(options);
    }
}

export interface OccSubVertexShapeOptions {
    parent: IShape;
    shape: TopoDS_Vertex;
    index: number;
    id?: string;
}

export class OccSubVertexShape extends OccVertex implements ISubVertexShape {
    override get mesh(): IShapeMeshData {
        this._mesh ??= {
            faces: undefined,
            vertexs: {
                position: new Float32Array(
                    this.parent.mesh.vertexs!.position.subarray(this.index * 3, (this.index + 1) * 3),
                ),
                size: this.parent.mesh.vertexs?.size ?? 1,
                range: [],
            },
            edges: undefined,
        };
        return this._mesh;
    }

    readonly parent: IShape;
    readonly index: number;

    constructor(options: OccSubVertexShapeOptions) {
        super(options);
        this.parent = options.parent;
        this.index = options.index;
    }
}

export interface OccSubEdgeShapeOptions {
    parent: IShape;
    shape: TopoDS_Edge;
    index: number;
    meshIndex?: number;
    id?: string;
}

export class OccSubEdgeShape extends OccEdge implements ISubEdgeShape {
    private readonly meshIndex: number;
    override get mesh(): IShapeMeshData {
        this._mesh ??= {
            faces: undefined,
            vertexs: undefined,
            edges: {
                position: MeshUtils.subEdge(this.parent.mesh.edges!, this.meshIndex)!,
                lineType: this.parent.mesh.edges!.lineType,
                range: [],
            },
        };
        return this._mesh;
    }

    readonly parent: IShape;
    readonly index: number;

    constructor(options: OccSubEdgeShapeOptions) {
        super(options);
        this.parent = options.parent;
        this.index = options.index;
        this.meshIndex = options.meshIndex ?? options.index;
    }
}

export interface OccSubFaceShapeOptions {
    parent: IShape;
    shape: TopoDS_Face;
    index: number;
    meshIndex?: number;
    id?: string;
}

export class OccSubFaceShape extends OccFace implements ISubFaceShape {
    private readonly meshIndex: number;
    override get mesh(): IShapeMeshData {
        this._mesh ??= {
            faces: MeshUtils.subFace(this.parent.mesh.faces!, this.meshIndex),
            vertexs: undefined,
            edges: undefined,
        };
        return this._mesh;
    }

    readonly parent: IShape;
    readonly index: number;

    constructor(options: OccSubFaceShapeOptions) {
        super(options);
        this.parent = options.parent;
        this.index = options.index;
        this.meshIndex = options.meshIndex ?? options.index;
    }
}

export class Mesher implements IShapeMeshData, IDisposable {
    private _isMeshed = false;
    private _lines?: EdgeMeshData;
    private _faces?: FaceMeshData;
    private _points?: VertexMeshData;

    get edges(): EdgeMeshData | undefined {
        if (this._lines === undefined) {
            this.mesh();
        }
        return this._lines;
    }
    set edges(value: EdgeMeshData | undefined) {
        this._lines = value;
    }

    get faces(): FaceMeshData | undefined {
        if (this._faces === undefined) {
            this.mesh();
        }
        return this._faces;
    }
    set faces(value: FaceMeshData | undefined) {
        this._faces = value;
    }

    get vertexs(): VertexMeshData | undefined {
        if (this._points === undefined && this.shape instanceof OccVertex) {
            const point = this.shape.point();
            this._points = {
                position: new Float32Array(point.toArray()),
                color: VisualConfig.defaultEdgeColor,
                range: [
                    {
                        start: 0,
                        count: 1,
                        shape: new OccSubVertexShape({
                            parent: this.shape,
                            shape: this.shape.shape,
                            index: 0,
                        }),
                    },
                ],
                size: 3,
            };
        }
        return this._points;
    }
    set vertexs(value: VertexMeshData | undefined) {
        this._points = value;
    }

    constructor(
        private shape: OccShape,
        private readonly transientTriangulation = false,
    ) {}

    private mesh() {
        if (this._isMeshed) {
            return;
        }
        this._isMeshed = true;
        this.shape.invalidateSerializedBrep();

        gc((c) => {
            const span = PerformanceTrace.enabled
                ? PerformanceTrace.begin("mesh.kernel", {
                      shapeId: this.shape.id,
                      meshKind: "unclassified",
                      ...PerformanceTrace.shapeDetails(this.shape),
                  })
                : undefined;
            const occMesher = c(new wasm.Mesher(this.shape.shape, 0.005, true));
            const meshData = c(occMesher.mesh());
            if (PerformanceTrace.enabled) PerformanceTrace.end(span);
            const conversion = PerformanceTrace.enabled
                ? PerformanceTrace.begin("mesh.buffers", {
                      shapeId: this.shape.id,
                  })
                : undefined;
            const faceMeshData = c(meshData.faceMeshData);
            const edgeMeshData = c(meshData.edgeMeshData);

            this._faces = this.parseFaceMeshData(faceMeshData);
            this._lines = this.parseEdgeMeshData(edgeMeshData);
            // JS arrays and local pick ranges are complete. A retained hybrid prefix must not keep
            // all native tessellations too: visiting many rollback positions otherwise grows a
            // second mesh cache per complete BREP replica. Cleaning changes no analytic topology.
            if (this.transientTriangulation) wasm.Shape.clean(this.shape.shape);
            if (PerformanceTrace.enabled) PerformanceTrace.end(conversion);
        });
    }

    private parseFaceMeshData(faceMeshData: OccFaceMeshData): FaceMeshData {
        return {
            position: new Float32Array(faceMeshData.position),
            normal: new Float32Array(faceMeshData.normal),
            uv: new Float32Array(faceMeshData.uv),
            index: new Uint32Array(faceMeshData.index),
            range: this.getFaceRanges(faceMeshData),
            color: VisualConfig.defaultFaceColor,
            groups: [],
        };
    }

    private parseEdgeMeshData(edgeMeshData: OccEdgeMeshData): EdgeMeshData {
        return {
            lineType: "solid",
            position: new Float32Array(edgeMeshData.position),
            range: this.getEdgeRanges(edgeMeshData),
            color: VisualConfig.defaultEdgeColor,
        };
    }

    dispose(): void {
        this._faces?.range.forEach((g) => g.shape.dispose());
        this._lines?.range.forEach((g) => g.shape.dispose());

        this.shape = null as any;
        this._faces = null as any;
        this._lines = null as any;
    }

    private getEdgeRanges(data: OccEdgeMeshData): ShapeMeshRange[] {
        const result: ShapeMeshRange[] = [];
        for (let i = 0; i < data.edges.length; i++) {
            result.push({
                start: data.group[2 * i],
                count: data.group[2 * i + 1],
                shape: new OccSubEdgeShape({
                    parent: this.shape,
                    shape: data.edges[i],
                    index: i,
                    id: `${this.shape.id}_e${i.toString().padStart(4, "0")}`,
                }),
            });
        }
        return result;
    }

    private getFaceRanges(data: OccFaceMeshData): ShapeMeshRange[] {
        const result: ShapeMeshRange[] = [];
        for (let i = 0; i < data.faces.length; i++) {
            result.push({
                start: data.group[2 * i],
                count: data.group[2 * i + 1],
                shape: new OccSubFaceShape({
                    parent: this.shape,
                    shape: data.faces[i],
                    index: i,
                    id: `${this.shape.id}_f${i.toString().padStart(4, "0")}`,
                }),
            });
        }
        return result;
    }
}
