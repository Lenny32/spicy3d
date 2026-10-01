// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { volumeTolerance } from "@spicy3d/core/src/shape/volumeValidity";

import type {
    ClassHandle,
    IntVector,
    MainModule,
    MeshData,
    ShapeResult,
    TopoDS_Shape,
    TrackedShapeResult,
} from "../lib/spicy-wasm";
import { replicaTopology, sameReplicaTopology } from "./replicaTopology";
import type {
    BoundedReplicaRequest,
    CornerReplica,
    KernelHandle,
    KernelOperations,
    KernelRequest,
    KernelResult,
    ShapeReplica,
    WorkerMesh,
    WorkerNativeEvent,
    WorkerTracking,
} from "./workerProtocol";

/** Native ownership is confined to this worker instance. No core/UI barrel imports. */
export class WorkerKernel {
    private readonly shapes = new Map<KernelHandle, TopoDS_Shape>();
    private readonly replicaLeases = new Set<KernelHandle>();
    private readonly validatedShapes = new WeakSet<TopoDS_Shape>();
    private nextHandle = 0;
    private trapped = false;
    private requestId = 0;
    private eventId = 0;
    private events?: WorkerNativeEvent[];
    private tracing = false;
    private nativeMs?: number;
    private readonly session = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");

    constructor(private readonly module: MainModule) {}

    execute(request: KernelRequest, created: KernelHandle[]): KernelResult<unknown> {
        this.requestId = request.id;
        this.events = undefined;
        this.nativeMs = undefined;
        this.tracing =
            request.trace !== undefined && Number.isSafeInteger(request.trace) && request.trace > 0;
        try {
            return this.native(() => this.executeNative(request, created));
        } finally {
            this.tracing = false;
        }
    }

    private executeNative(request: KernelRequest, created: KernelHandle[]): KernelResult<unknown> {
        const m = this.module;
        const referenced =
            request.operation === "boolean"
                ? [...request.args.left, ...request.args.right]
                : request.args && "handle" in request.args
                  ? [request.args.handle]
                  : [];
        if (referenced.some((handle) => !this.shapes.has(handle))) {
            return { ok: false, error: { code: "invalid", message: "Unknown or released worker shape" } };
        }
        // Low-level operations must not mutate an operand that a later cached request considers
        // immutable. The hybrid path already consumes its leases before reaching the boolean.
        if (request.operation === "boolean" || request.operation === "mesh") {
            for (const handle of referenced) this.replicaLeases.delete(handle);
        }
        switch (request.operation) {
            case "cornerSetbackReplica":
                return this.cornerSetbackReplica(request.args);
            case "checkSelfIntersectionReplica": {
                const check = (
                    m.Shape as unknown as { checkSelfIntersection?: (shape: TopoDS_Shape) => boolean }
                ).checkSelfIntersection;
                if (typeof check !== "function")
                    return {
                        ok: false,
                        error: {
                            code: "unavailable",
                            message: "Self-intersection check is not available in this kernel build",
                        },
                    };
                const shape = m.Converter.convertFromBrep(request.args.shape.brep);
                return this.native(
                    () => {
                        if (
                            shape.isNull() ||
                            !sameReplicaTopology(request.args.shape.topology, replicaTopology(m, shape))
                        )
                            return {
                                ok: false,
                                error: { code: "invalid", message: "Input BREP topology order changed" },
                            };
                        return {
                            ok: true,
                            value: this.measure(
                                "worker.kernel.operation",
                                () => Boolean(check.call(m.Shape, shape)),
                                "checkSelfIntersection",
                            ),
                        };
                    },
                    () => shape.delete(),
                );
            }
            case "boundedReplica":
                return this.boundedReplica(request.args);
            case "ready":
                return { ok: true, value: undefined };
            case "stats":
                return { ok: true, value: { shapes: this.shapes.size } };
            case "booleanReplica": {
                const inputs = [...request.args.left, ...request.args.right];
                // Leases belong to this request from receipt, not just after a successful import.
                const requestedLeases = inputs.flatMap((input) => ("handle" in input ? [input.handle] : []));
                const owned = [
                    ...new Set(requestedLeases.filter((handle) => this.replicaLeases.has(handle))),
                ];
                const validLeases = requestedLeases.every((handle) => this.replicaLeases.has(handle));
                for (const handle of owned) this.replicaLeases.delete(handle);
                return this.native(
                    () => {
                        if (!validLeases)
                            return {
                                ok: false,
                                error: {
                                    code: "invalid",
                                    message: "Unknown or consumed replica lease",
                                },
                            };
                        const inputHandles: KernelHandle[] = [];
                        for (const snapshot of inputs) {
                            if ("handle" in snapshot) {
                                if (!this.shapes.has(snapshot.handle))
                                    return {
                                        ok: false,
                                        error: {
                                            code: "invalid",
                                            message: "Unknown or consumed replica lease",
                                        },
                                    };
                                inputHandles.push(snapshot.handle);
                                continue;
                            }
                            const saved = this.tracing
                                ? this.measure("worker.replica.import", () =>
                                      this.keep(m.Converter.convertFromBrep(snapshot.brep), owned),
                                  )
                                : this.keep(m.Converter.convertFromBrep(snapshot.brep), owned);
                            if (!saved.ok) return saved;
                            inputHandles.push(saved.value);
                            const matches = this.tracing
                                ? this.measure("worker.replica.verify", () =>
                                      sameReplicaTopology(
                                          snapshot.topology,
                                          replicaTopology(m, this.get(saved.value)),
                                      ),
                                  )
                                : sameReplicaTopology(
                                      snapshot.topology,
                                      replicaTopology(m, this.get(saved.value)),
                                  );
                            if (!matches) {
                                return {
                                    ok: false,
                                    error: { code: "invalid", message: "Input BREP topology order changed" },
                                };
                            }
                        }
                        const result = this.executeNative(
                            {
                                type: "request",
                                id: request.id,
                                operation: "boolean",
                                args: {
                                    operation: request.args.operation,
                                    left: inputHandles.slice(0, request.args.left.length),
                                    right: inputHandles.slice(request.args.left.length),
                                },
                            },
                            owned,
                        );
                        if (!result.ok) return result;
                        const output = result.value as { handle: KernelHandle; tracking: WorkerTracking };
                        const shape = this.get(output.handle);
                        // This request owns every operand. Cached operands are consumed exactly once:
                        // OCCT may modify inputs, so they must never become reusable cache entries again.
                        // Export the owned output directly; no clone/read cycle for the next worker step.
                        const { brep, topology } = this.tracing
                            ? this.measure("worker.replica.export", () => this.exportReplica(shape))
                            : this.exportReplica(shape);
                        const mesh = request.args.mesh ? this.mesh(shape, true) : undefined;
                        // Meshing can populate native caches; only unmeshed outputs are eligible leases.
                        const handle = request.args.retain && !request.args.mesh ? output.handle : undefined;
                        if (handle) {
                            owned.splice(owned.indexOf(handle), 1);
                            this.replicaLeases.add(handle);
                            created.push(handle);
                        }
                        return {
                            ok: true,
                            value: {
                                brep,
                                topology,
                                handle,
                                tracking: output.tracking,
                                nativeMs: this.nativeMs,
                                mesh,
                            },
                        };
                    },
                    () => this.release(owned),
                );
            }
            case "release":
                this.release(request.args.handles);
                return { ok: true, value: undefined };
            case "box": {
                const { origin, size } = request.args;
                if (
                    ![origin.x, origin.y, origin.z, size.x, size.y, size.z].every(Number.isFinite) ||
                    Math.min(size.x, size.y, size.z) <= 1e-7
                ) {
                    return { ok: false, error: { code: "invalid", message: "Invalid box dimensions" } };
                }
                return this.shapeResult(
                    m.ShapeFactory.box(
                        {
                            location: origin,
                            direction: { x: 0, y: 0, z: 1 },
                            xDirection: { x: 1, y: 0, z: 0 },
                        },
                        size.x,
                        size.y,
                        size.z,
                    ),
                    created,
                );
            }
            case "importBrep": {
                const shape = m.Converter.convertFromBrep(request.args.brep);
                return this.keep(shape, created);
            }
            case "exportBrep":
                return { ok: true, value: m.Converter.convertToBrep(this.get(request.args.handle)) };
            case "bounds":
                return { ok: true, value: m.Shape.boundingBox(this.get(request.args.handle), false) };
            case "mesh":
                return { ok: true, value: this.mesh(this.get(request.args.handle)) };
            case "boolean": {
                const { operation, left, right } = request.args;
                if (!left.length || !right.length) {
                    return { ok: false, error: { code: "invalid", message: "Boolean operands are empty" } };
                }
                const a = left.map((id) => this.get(id));
                const b = right.map((id) => this.get(id));
                for (const [index, shape] of [...a, ...b].entries()) {
                    const error = this.shapeError(shape, false);
                    if (error) return this.geometryFailure(`Boolean ${operation} input ${index}: ${error}`);
                }
                const methods = {
                    fuse: m.ShapeFactory.booleanFuseTracked,
                    cut: m.ShapeFactory.booleanCutTracked,
                    common: m.ShapeFactory.booleanCommonTracked,
                };
                const result = this.tracing
                    ? this.measure(
                          "worker.kernel.operation",
                          () => methods[operation](a, b),
                          `boolean${operation[0].toUpperCase()}${operation.slice(1)}Tracked`,
                      )
                    : methods[operation](a, b);
                return this.native(
                    () => {
                        if (!result.isOk)
                            return { ok: false, error: { code: "kernel", message: result.error } };
                        const tracking = this.tracing
                            ? this.measure("worker.kernel.historyConversion", () =>
                                  this.convertTracking(result),
                              )
                            : this.convertTracking(result);
                        const shape = this.copyResultShape(result);
                        const saved = this.keep(shape, created);
                        if (!saved.ok) return saved;
                        const error = this.shapeError(shape);
                        if (error) return this.geometryFailure(`Boolean ${operation} result: ${error}`);
                        return { ok: true, value: { handle: saved.value, tracking } };
                    },
                    () => result.delete(),
                );
            }
        }
    }

    private cornerSetbackReplica(
        request: KernelOperations["cornerSetbackReplica"]["args"],
    ): KernelResult<CornerReplica> {
        const m = this.module;
        const owned: TopoDS_Shape[] = [];
        const invalid = (message: string): KernelResult<CornerReplica> => ({
            ok: false,
            error: { code: "invalid", message },
        });
        if (
            request.edges.length !== 3 ||
            request.distances.length !== 3 ||
            new Set(request.edges).size !== 3 ||
            !Number.isFinite(request.radius) ||
            request.radius <= 0 ||
            request.edges.some(
                (index) =>
                    !Number.isSafeInteger(index) || index < 0 || index >= request.shape.topology.edges.length,
            ) ||
            request.distances.some(
                (distance) => !Number.isFinite(distance) || distance <= request.radius + 1e-4,
            )
        )
            return invalid("Invalid corner setback edges, radius or distances");
        type NativeCorner = {
            shape: TopoDS_Shape;
            isOk: boolean;
            error: string;
            g0Error: number;
            g1Error: number;
            fitDistanceError: number;
            fitAngleError: number;
            faceMap: IntVector;
            edgeMap: IntVector;
            faceEdgeMap: IntVector;
            faceAncestors: IntVector;
            edgeAncestors: IntVector;
            cornerFaces: IntVector;
        };
        const binding = (
            m.ShapeFactory as unknown as {
                filletCornerSetbackTracked?: (
                    shape: TopoDS_Shape,
                    edges: number[],
                    radius: number,
                    distances: number[],
                ) => NativeCorner;
            }
        ).filletCornerSetbackTracked;
        if (!binding)
            return {
                ok: false,
                error: {
                    code: "unavailable",
                    message: "Corner setbacks are not available in this worker kernel",
                },
            };
        return this.native(
            () => {
                const input = m.Converter.convertFromBrep(request.shape.brep);
                owned.push(input);
                if (input.isNull() || !sameReplicaTopology(request.shape.topology, replicaTopology(m, input)))
                    return invalid("Input BREP topology order changed");
                const inputError = this.shapeError(input);
                if (inputError) return this.geometryFailure(`Fillet corner input: ${inputError}`);
                const result = this.measure(
                    "worker.kernel.operation",
                    () => binding(input, request.edges, request.radius, request.distances),
                    "filletCornerSetback",
                );
                owned.push(result.shape); // Value-object shape is owning, unlike ShapeResult's borrowed getter.
                const vectors = {
                    faceMap: result.faceMap,
                    edgeMap: result.edgeMap,
                    faceEdgeMap: result.faceEdgeMap,
                    faceAncestors: result.faceAncestors,
                    edgeAncestors: result.edgeAncestors,
                    cornerFaces: result.cornerFaces,
                };
                return this.native(
                    () => {
                        if (!result.isOk) return invalid(result.error);
                        const error = this.shapeError(result.shape);
                        if (error) return this.geometryFailure(`Fillet corner result: ${error}`);
                        const arrays = Object.fromEntries(
                            Object.entries(vectors).map(([key, vector]) => [key, Int32Array.from(vector)]),
                        ) as Record<keyof typeof vectors, Int32Array>;
                        return {
                            ok: true,
                            value: {
                                ...this.exportReplica(result.shape),
                                tracking: { ...arrays, capFaces: new Int32Array() },
                                cornerFaces: arrays.cornerFaces,
                                g0Error: result.g0Error,
                                g1Error: result.g1Error,
                                fitDistanceError: result.fitDistanceError,
                                fitAngleError: result.fitAngleError,
                                nativeMs: this.nativeMs,
                                mesh: request.mesh ? this.mesh(result.shape, true) : undefined,
                            },
                        };
                    },
                    () => {
                        for (const vector of Object.values(vectors)) vector.delete();
                    },
                );
            },
            () => {
                for (const shape of owned.reverse()) shape.delete();
            },
        );
    }

    private boundedReplica(request: BoundedReplicaRequest): KernelResult<ShapeReplica> {
        const m = this.module;
        const owned: TopoDS_Shape[] = [];
        const snapshot = (replica: ShapeReplica): TopoDS_Shape => {
            const shape = m.Converter.convertFromBrep(replica.brep);
            owned.push(shape);
            if (shape.isNull() || !sameReplicaTopology(replica.topology, replicaTopology(m, shape))) {
                throw new Error("Input BREP topology order changed");
            }
            const error = this.shapeError(shape, !request.method.startsWith("boolean"));
            if (error)
                throw new InvalidGeometryError(`${request.method} input ${owned.length - 1}: ${error}`);
            return shape;
        };
        const invoke = (): ShapeResult => {
            switch (request.method) {
                case "booleanFuse":
                case "booleanCut":
                case "booleanCommon":
                    if (!request.left.length || !request.right.length)
                        throw new Error("Boolean operands are empty");
                    return m.ShapeFactory[request.method](
                        request.left.map(snapshot),
                        request.right.map(snapshot),
                    );
                case "fillet":
                case "chamfer": {
                    const shape = snapshot(request.shape);
                    if (
                        !Number.isFinite(request.value) ||
                        request.value < 1e-7 ||
                        !request.edges.length ||
                        request.edges.some(
                            (i) =>
                                !Number.isSafeInteger(i) || i < 0 || i >= request.shape.topology.edges.length,
                        )
                    ) {
                        throw new Error("Invalid corner radius/distance or edge indexes");
                    }
                    return m.ShapeFactory[request.method](shape, request.edges, request.value);
                }
                case "loft": {
                    const continuity = {
                        c0: m.GeomAbs_Shape.GeomAbs_C0,
                        g1: m.GeomAbs_Shape.GeomAbs_G1,
                        c1: m.GeomAbs_Shape.GeomAbs_C1,
                        g2: m.GeomAbs_Shape.GeomAbs_G2,
                        c2: m.GeomAbs_Shape.GeomAbs_C2,
                        c3: m.GeomAbs_Shape.GeomAbs_C3,
                        cn: m.GeomAbs_Shape.GeomAbs_CN,
                    };
                    return m.ShapeFactory.loft(
                        request.sections.map(snapshot),
                        request.isSolid,
                        request.isRuled,
                        continuity[request.continuity],
                    );
                }
                case "makeThickSolidBySimple":
                    if (!Number.isFinite(request.thickness)) throw new Error("Thickness must be finite");
                    return m.ShapeFactory.makeThickSolidBySimple(snapshot(request.shape), request.thickness);
                case "makeThickSolidByJoin": {
                    if (!Number.isFinite(request.thickness)) throw new Error("Thickness must be finite");
                    const shape = snapshot(request.shape);
                    const faces = m.Shape.findSubShapes(shape, m.TopAbs_ShapeEnum.TopAbs_FACE);
                    owned.push(...faces);
                    if (
                        request.closingFaces.some(
                            (i) => !Number.isSafeInteger(i) || i < 0 || i >= faces.length,
                        )
                    )
                        throw new Error("Opening face is not part of the input replica");
                    const joins = {
                        arc: m.GeomAbs_JoinType.GeomAbs_Arc,
                        tangent: m.GeomAbs_JoinType.GeomAbs_Tangent,
                        intersection: m.GeomAbs_JoinType.GeomAbs_Intersection,
                    };
                    const modes = {
                        skin: m.BRepOffset_Mode.BRepOffset_Skin,
                        pipe: m.BRepOffset_Mode.BRepOffset_Pipe,
                        rectoVerso: m.BRepOffset_Mode.BRepOffset_RectoVerso,
                    };
                    return m.ShapeFactory.makeThickSolidByJoin(
                        shape,
                        request.closingFaces.map((i) => faces[i]),
                        request.thickness,
                        joins[request.joinType],
                        modes[request.mode],
                        request.intersection,
                    );
                }
            }
        };
        return this.native(
            () => {
                let result: ShapeResult;
                try {
                    result = this.measure("worker.kernel.operation", invoke, request.method);
                } catch (error) {
                    if (error instanceof WebAssembly.RuntimeError) throw error;
                    return {
                        ok: false,
                        error: {
                            code: error instanceof InvalidGeometryError ? "geometry" : "invalid",
                            message: error instanceof Error ? error.message : "Invalid bounded operation",
                        },
                    };
                }
                return this.native(
                    () => {
                        if (!result.isOk)
                            return { ok: false, error: { code: "invalid", message: result.error } };
                        let shape = this.copyResultShape(result);
                        owned.push(shape);
                        if (request.method === "booleanFuse" && request.simplifyShape) {
                            const simplified = m.ShapeFactory.simplifyShape(
                                shape,
                                true,
                                true,
                                [],
                                1e-5,
                                1e-6,
                            );
                            this.native(
                                () => {
                                    if (simplified.isOk) {
                                        shape = this.copyResultShape(simplified);
                                        owned.push(shape);
                                    }
                                },
                                () => simplified.delete(),
                            );
                        }
                        // Match the feature's existing orientation repair for a wholly inverted
                        // thick solid, then reject any negative component left in the result.
                        const thicken =
                            request.method === "makeThickSolidBySimple" ||
                            request.method === "makeThickSolidByJoin";
                        if (
                            thicken &&
                            m.Shape.volume(shape) <
                                -volumeTolerance(m.Shape.volume(shape), m.Shape.boundingBox(shape, false))
                        ) {
                            const fixed = m.ShapeFactory.fixSolid(shape, 1e-6);
                            const repaired = this.native(
                                () => {
                                    if (!fixed.isOk) return false;
                                    shape = this.copyResultShape(fixed);
                                    owned.push(shape);
                                    return m.Shape.volume(shape) > 0;
                                },
                                () => fixed.delete(),
                            );
                            if (!repaired)
                                return this.geometryFailure(
                                    `${request.method} result: thick solid is inside out`,
                                );
                        }
                        const error = this.shapeError(shape);
                        if (error) return this.geometryFailure(`${request.method} result: ${error}`);
                        if (
                            request.method === "makeThickSolidBySimple" ||
                            request.method === "makeThickSolidByJoin"
                        ) {
                            const solids = m.Shape.findSubShapes(shape, m.TopAbs_ShapeEnum.TopAbs_SOLID);
                            owned.push(...solids);
                            if (!solids.length)
                                return {
                                    ok: false,
                                    error: { code: "invalid", message: "Thick solid result is not a solid" },
                                };
                        }
                        return { ok: true, value: this.exportReplica(shape) };
                    },
                    () => result.delete(),
                );
            },
            () => {
                for (const shape of owned.reverse()) shape.delete();
            },
        );
    }

    /** Boolean operands need only orientation checks; reuse validated resident results. */
    private shapeError(shape: TopoDS_Shape, analyze = true): string | undefined {
        if (!analyze && this.validatedShapes.has(shape)) return undefined;
        const m = this.module;
        if (analyze && !m.Shape.check(shape)) return "invalid shape (checkShape is false)";
        const solids = m.Shape.findSubShapes(shape, m.TopAbs_ShapeEnum.TopAbs_SOLID);
        try {
            const tolerance = solids.length
                ? volumeTolerance(m.Shape.volume(shape), m.Shape.boundingBox(shape, false))
                : 0;
            // A positive compound total can hide an inside-out solid among valid ones.
            for (const [index, solid] of solids.entries()) {
                const volume = m.Shape.volume(solid);
                if (!Number.isFinite(volume) || volume < -tolerance)
                    return `solid ${index} has invalid volume (${volume} mm³)`;
            }
        } finally {
            for (const solid of solids) solid.delete();
        }
        if (analyze) this.validatedShapes.add(shape);
        return undefined;
    }

    private geometryFailure(message: string): KernelResult<never> {
        return { ok: false, error: { code: "geometry", message } };
    }

    private exportReplica(shape: TopoDS_Shape) {
        this.module.Shape.clean(shape);
        return {
            brep: this.module.Converter.convertToBrep(shape),
            topology: replicaTopology(this.module, shape),
        };
    }

    private convertTracking(result: TrackedShapeResult): WorkerTracking {
        return {
            faceMap: this.vector(result.faceMap),
            edgeMap: this.vector(result.edgeMap),
            faceEdgeMap: this.vector(result.faceEdgeMap),
            faceAncestors: this.vector(result.faceAncestors),
            edgeAncestors: this.vector(result.edgeAncestors),
            capFaces: this.vector(result.capFaces),
        };
    }

    private get(handle: KernelHandle): TopoDS_Shape {
        const shape = this.shapes.get(handle);
        if (!shape) throw new Error("Unknown or released worker shape");
        return shape;
    }

    private keep(shape: TopoDS_Shape, created: KernelHandle[]): KernelResult<KernelHandle> {
        if (shape.isNull()) {
            shape.delete();
            return { ok: false, error: { code: "kernel", message: "Kernel returned a null shape" } };
        }
        const handle = `${this.session}:${++this.nextHandle}`;
        this.shapes.set(handle, shape);
        created.push(handle);
        return { ok: true, value: handle };
    }

    private shapeResult(result: ShapeResult, created: KernelHandle[]): KernelResult<KernelHandle> {
        return this.native(
            () => {
                return result.isOk
                    ? this.keep(this.copyResultShape(result), created)
                    : { ok: false, error: { code: "kernel", message: result.error } };
            },
            () => result.delete(),
        );
    }

    private copyResultShape(result: { shape: TopoDS_Shape }): TopoDS_Shape {
        // ShapeResult.shape is bound with return_value_policy::reference. It dies with result!
        // Located with the same location returns an owned TopoDS value, sharing the TShape rather
        // than copying geometry (which would lose history identity). Do not delete the borrowed member.
        const borrowed = result.shape;
        const location = borrowed.getLocation();
        return this.native(
            () => {
                return borrowed.located(location, false);
            },
            () => location.delete(),
        );
    }

    private vector(vector: IntVector): Int32Array {
        return this.native(
            () => {
                return Int32Array.from(vector);
            },
            () => vector.delete(),
        );
    }

    private mesh(shape: TopoDS_Shape, topology = false): WorkerMesh {
        const owned: ClassHandle[] = [];
        const own = <T extends ClassHandle>(value: T): T => {
            owned.push(value);
            return value;
        };
        return this.native(
            () => {
                const meshStarted = this.tracing ? performance.now() : undefined;
                let mesh: MeshData;
                try {
                    const mesher = own(new this.module.Mesher(shape, 0.005, true));
                    mesh = own(mesher.mesh());
                } finally {
                    if (meshStarted !== undefined) this.record("worker.mesh.kernel", meshStarted);
                }
                const buffersStarted = this.tracing ? performance.now() : undefined;
                try {
                    const faces = own(mesh.faceMeshData);
                    const edges = own(mesh.edgeMeshData);
                    // These getters allocate embind wrappers too; do not leak them or send them across realms.
                    const meshFaces = faces.faces.map(own);
                    const meshEdges = edges.edges.map(own);
                    const indexes = (meshShapes: TopoDS_Shape[], kind: "TopAbs_FACE" | "TopAbs_EDGE") => {
                        const subs = this.module.Shape.findSubShapes(
                            shape,
                            this.module.TopAbs_ShapeEnum[kind],
                        ).map(own);
                        const buckets = new Map<number, Array<{ shape: TopoDS_Shape; index: number }>>();
                        subs.forEach((sub, index) => {
                            const pointer = this.module.Shape.ptr(sub);
                            const bucket = buckets.get(pointer) ?? [];
                            bucket.push({ shape: sub, index });
                            buckets.set(pointer, bucket);
                        });
                        return Uint32Array.from(meshShapes, (sub) => {
                            const index = buckets
                                .get(this.module.Shape.ptr(sub))
                                ?.find((candidate) => candidate.shape.isSame(sub))?.index;
                            if (index === undefined) throw new Error("Mesher topology not found");
                            return index;
                        });
                    };
                    return {
                        positions: new Float32Array(faces.position),
                        normals: new Float32Array(faces.normal),
                        uv: new Float32Array(faces.uv),
                        indices: new Uint32Array(faces.index),
                        faceGroups: new Uint32Array(faces.group),
                        edgePositions: new Float32Array(edges.position),
                        edgeGroups: new Uint32Array(edges.group),
                        ...(topology
                            ? {
                                  faceTopology: indexes(meshFaces, "TopAbs_FACE"),
                                  edgeTopology: indexes(meshEdges, "TopAbs_EDGE"),
                              }
                            : {}),
                    };
                } finally {
                    if (buffersStarted !== undefined) this.record("worker.mesh.buffers", buffersStarted);
                }
            },
            () => {
                for (const value of owned.reverse()) value.delete();
            },
        );
    }

    release(handles: KernelHandle[]): void {
        this.native(() => {
            for (const handle of handles) {
                this.replicaLeases.delete(handle);
                this.shapes.get(handle)?.delete();
                this.shapes.delete(handle);
            }
        });
    }

    /** Queued cancellation must release transferred leases even though execute() never ran. */
    discardRequest(request: KernelRequest): void {
        if (request.operation === "booleanReplica")
            this.release(
                [...request.args.left, ...request.args.right].flatMap((input) =>
                    "handle" in input && this.replicaLeases.has(input.handle) ? [input.handle] : [],
                ),
            );
    }

    dispose(): void {
        if (!this.trapped) this.release([...this.shapes.keys()]);
    }

    takeEvents(): WorkerNativeEvent[] | undefined {
        const events = this.events;
        this.events = undefined;
        return events;
    }

    private measure<T>(stage: WorkerNativeEvent["stage"], action: () => T, operation?: string): T {
        if (!this.tracing) return action();
        const started = performance.now();
        try {
            return action();
        } finally {
            this.record(stage, started, operation);
        }
    }

    private record(stage: WorkerNativeEvent["stage"], started: number, operation?: string): void {
        const durationMs = performance.now() - started;
        if (stage === "worker.kernel.operation") this.nativeMs = durationMs;
        this.events ??= [];
        this.events.push({
            stage,
            started,
            durationMs,
            details: {
                workerId: this.session,
                requestId: this.requestId,
                eventId: ++this.eventId,
                boolean: stage === "worker.kernel.operation" && operation?.startsWith("boolean") === true,
                operation,
            },
        });
    }

    /** Every native scope marks a trap BEFORE its finally and any outer finally can run. */
    private native<T>(action: () => T, cleanup?: () => void): T {
        if (this.trapped) throw new WebAssembly.RuntimeError("Geometry worker heap is unavailable");
        try {
            return action();
        } catch (error) {
            if (error instanceof WebAssembly.RuntimeError) this.trapped = true;
            throw error;
        } finally {
            if (!this.trapped && cleanup) this.native(cleanup);
        }
    }
}

class InvalidGeometryError extends Error {}
