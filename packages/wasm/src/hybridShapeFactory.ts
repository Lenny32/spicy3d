// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncTrackedBoolean,
    type AsyncTrackedCorner,
    type BoundedShapeRequest,
    type IAsyncShapeFactory,
    type IAsyncShapeOperation,
    type IBoundedShapeFactory,
    type IShape,
    PerformanceTrace,
    Result,
    ShapeTypes,
    type TrackedShape,
    VisualConfig,
    validateFilletCornerSetback,
} from "@spicy3d/core";
import type { TopoDS_Shape } from "../lib/spicy-wasm";
import { validateCornerReplica } from "./cornerTracking";
import { refuseIntersectionJoin, ShapeFactory } from "./factory";
import { prepareLoftSection } from "./loftSections";
import { replicaTopology, sameReplicaTopology } from "./replicaTopology";
import { OccShape, OccSubEdgeShape, OccSubFaceShape } from "./shape";
import type { KernelWorkerClient } from "./workerClient";
import { createKernelWorker } from "./workerFactory";
import { workerProfile } from "./workerProfile";
import type {
    BooleanReplica,
    BoundedReplicaRequest,
    CornerReplica,
    KernelHandle,
    KernelResult,
    ReplicaInput,
    ReplicaTopology,
    ShapeReplica,
    WorkerMesh,
} from "./workerProtocol";

type ResidentReplica = {
    source: OccShape;
    worker: KernelWorkerClient;
    handle: KernelHandle;
    /** Exact local analytic BREP after import. Also catches mutations through native/geometry aliases. */
    version: string;
    topology: ReplicaTopology;
    unsubscribe: () => void;
};

/** Worker booleans with ordinary local OCCT replicas. No asynchronous IShape methods. */
export class HybridShapeFactory implements IAsyncShapeFactory, IBoundedShapeFactory {
    private static readonly MAX_RESIDENT = 2;
    private readonly resident = new Map<OccShape, ResidentReplica>();
    private readonly active = new Set<() => void>();
    private mainTrapped = false;
    private worker?: KernelWorkerClient;
    private removeFailureHandler?: () => void;
    private disabled = false;
    private nativeFailure?: string;
    get failure(): string | undefined {
        return this.nativeFailure;
    }
    get available(): boolean {
        // A failed capability stays installed: unavailable means safe synchronous compatibility,
        // whereas native failure must keep returning an error on every subsequent rebuild.
        return this.nativeFailure !== undefined || !this.disabled;
    }

    constructor(
        private readonly createWorker: () => KernelWorkerClient = createKernelWorker,
        profileEnabled = true,
    ) {
        workerProfile.install(profileEnabled);
    }

    shapeOperation(request: BoundedShapeRequest, signal?: AbortSignal): IAsyncShapeOperation<IShape> {
        if (signal?.aborted) return this.failedShapeOperation("Geometry worker operation cancelled");
        if (this.nativeFailure) return this.failedShapeOperation(this.nativeFailure);
        const prepared: IShape[] = [];
        const capture = (shape: IShape): ShapeReplica => {
            if (!(shape instanceof OccShape)) throw new Error("The OCC kernel only supports OCC geometries");
            const frozen = copyReplica(shape.shape);
            prepared.push(frozen);
            const expected = inspectTopology(shape.shape);
            const topology = replicaTopology(wasm, frozen.shape);
            if (!sameReplicaTopology(expected, topology))
                throw new Error("Input clone topology order changed");
            return { brep: exportBrep(frozen.shape, "input"), topology };
        };
        let args: BoundedReplicaRequest;
        let worker: KernelWorkerClient;
        try {
            switch (request.method) {
                case "booleanFuse":
                case "booleanCut":
                case "booleanCommon":
                    args = { ...request, left: request.left.map(capture), right: request.right.map(capture) };
                    break;
                case "fillet":
                case "chamfer":
                    args = { ...request, shape: capture(request.shape) };
                    break;
                case "makeThickSolidBySimple":
                    args = { ...request, shape: capture(request.shape) };
                    break;
                case "makeThickSolidByJoin": {
                    const refused = refuseIntersectionJoin(request.shape, request.joinType);
                    if (refused) throw new Error(refused);
                    const faces = request.shape.findSubShapes(ShapeTypes.face);
                    prepared.push(...faces);
                    const closingFaces = request.closingFaces.map((selected) => {
                        const index = faces.findIndex((face) => face.isSame(selected));
                        if (index < 0) throw new Error("Opening face is not part of the input shape");
                        return index;
                    });
                    args = { ...request, shape: capture(request.shape), closingFaces };
                    break;
                }
                case "loft": {
                    const factory = new ShapeFactory();
                    const sections = request.sections.map((section, index) => {
                        const result = prepareLoftSection(section, index, (edges) => factory.wire(edges));
                        if (!result.isOk) throw new Error(result.error);
                        if (result.value !== section) prepared.push(result.value);
                        return capture(result.value);
                    });
                    args = { ...request, sections };
                    break;
                }
            }
            if (!this.worker) {
                this.worker = this.createWorker();
                this.removeFailureHandler = this.worker.addNativeFailureHandler((error) =>
                    this.quarantine(error.message),
                );
            }
            worker = this.worker;
        } catch (error) {
            if (!(error instanceof WebAssembly.RuntimeError)) for (const shape of prepared) shape.dispose();
            else this.quarantine("Main geometry runtime failed while capturing a replica");
            return this.failedShapeOperation(
                error instanceof Error ? error.message : "Geometry worker unavailable",
            );
        }
        for (const shape of prepared) shape.dispose();
        let reply: KernelResult<ShapeReplica> | undefined;
        let consumed = false;
        const abort = new AbortController();
        const onAbort = () => {
            abort.abort();
            // Retire synchronously so a following call can create its generation immediately.
            if (worker.isClosed) this.retireWorker(worker);
        };
        const cancel = () => {
            if (consumed) return;
            consumed = true;
            reply = undefined;
            this.active.delete(cancel);
            signal?.removeEventListener("abort", onAbort);
            onAbort();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) abort.abort();
        this.active.add(cancel);
        const ready = worker
            .request("boundedReplica", args, abort.signal, { terminateOnAbort: true })
            .then((result) => {
                signal?.removeEventListener("abort", onAbort);
                if (!consumed) reply = result;
                if (!result.ok && (result.error.code === "timeout" || result.error.code === "cancelled"))
                    this.retireWorker(worker);
            });
        return {
            ready,
            cancel,
            canFallback: false,
            take: () => {
                if (consumed || !reply) return Result.err(this.nativeFailure ?? "Worker result unavailable");
                consumed = true;
                this.active.delete(cancel);
                const answer = reply;
                reply = undefined;
                if (!answer.ok) return Result.err(answer.error.message);
                let shape: OccShape | undefined;
                try {
                    shape = importReplica(answer.value);
                    if (!sameReplicaTopology(answer.value.topology, replicaTopology(wasm, shape.shape))) {
                        shape.dispose();
                        return Result.err("Output BREP topology order changed");
                    }
                    return Result.ok(shape);
                } catch (error) {
                    if (!(error instanceof WebAssembly.RuntimeError)) shape?.dispose();
                    else this.quarantine("Main geometry runtime failed while installing a replica");
                    return Result.err(
                        error instanceof Error ? error.message : "Worker replica installation failed",
                    );
                }
            },
        };
    }

    private failedShapeOperation(message: string): IAsyncShapeOperation<IShape> {
        return {
            ready: Promise.resolve(),
            canFallback: false,
            take: () => Result.err(message),
            cancel: () => {},
        };
    }

    cornerSetbackTracked(
        shape: IShape,
        edges: number[],
        radius: number,
        distances: number[],
        options?: { mesh?: boolean },
    ): IAsyncShapeOperation<AsyncTrackedCorner> {
        const failed = (message: string): IAsyncShapeOperation<AsyncTrackedCorner> => ({
            ready: Promise.resolve(),
            canFallback: false,
            take: () => Result.err(message),
            cancel: () => {},
        });
        const validation = validateFilletCornerSetback(edges, radius, distances);
        if (validation) return failed(validation);
        if (this.nativeFailure) return failed(this.nativeFailure);
        if (this.disabled) return failed("Corner setbacks require the geometry worker; it is unavailable");
        if (!(shape instanceof OccShape)) return failed("The corner worker requires OCC geometry");
        let input: OccShape | undefined;
        let topology: ReplicaTopology;
        let snapshot: ShapeReplica;
        let worker: KernelWorkerClient;
        try {
            input = copyReplica(shape.shape);
            topology = replicaTopology(wasm, input.shape);
            if (!sameReplicaTopology(inspectTopology(shape.shape), topology))
                throw new Error("Input clone topology order changed");
            if (edges.some((index) => index >= topology.edges.length))
                throw new Error("Corner setback edge index is outside the input topology");
            snapshot = { brep: exportBrep(input.shape, "input"), topology };
            if (!this.worker) {
                this.worker = this.createWorker();
                this.removeFailureHandler = this.worker.addNativeFailureHandler((error) =>
                    this.quarantine(error.message),
                );
            }
            worker = this.worker;
        } catch (error) {
            this.mainTrapped = error instanceof WebAssembly.RuntimeError;
            if (this.mainTrapped)
                this.quarantine("Main geometry runtime failed while capturing a corner replica");
            else input?.dispose();
            return failed(error instanceof Error ? error.message : "Corner worker input capture failed");
        }
        let reply: KernelResult<CornerReplica> | undefined;
        let consumed = false;
        const abort = new AbortController();
        const cancel = () => {
            if (consumed) return;
            consumed = true;
            this.active.delete(cancel);
            reply = undefined;
            if (!this.mainTrapped) input?.dispose();
            input = undefined;
            abort.abort();
        };
        this.active.add(cancel);
        const ready = worker
            .request(
                "cornerSetbackReplica",
                {
                    shape: snapshot,
                    edges: [...edges],
                    radius,
                    distances: [...distances],
                    mesh: options?.mesh,
                },
                abort.signal,
                { terminateOnAbort: true },
            )
            .then((answer) => {
                if (!consumed) reply = answer;
                if (!answer.ok && (answer.error.code === "timeout" || answer.error.code === "cancelled"))
                    this.retireWorker(worker);
            });
        return {
            ready,
            canFallback: false,
            cancel,
            take: () => {
                if (consumed || !reply)
                    return Result.err(this.nativeFailure ?? "Corner worker result unavailable");
                consumed = true;
                this.active.delete(cancel);
                const answer = reply;
                reply = undefined;
                let output: OccShape | undefined;
                let accepted = false;
                try {
                    if (!answer.ok) {
                        if (answer.error.code === "unavailable") this.disable();
                        return Result.err(answer.error.message);
                    }
                    const malformed = validateCornerReplica(answer.value, topology);
                    if (malformed) return Result.err(malformed);
                    output = importReplica(answer.value);
                    if (!sameReplicaTopology(answer.value.topology, replicaTopology(wasm, output.shape)))
                        return Result.err("Output corner BREP topology order changed");
                    if (answer.value.mesh) installMesh(output, answer.value.mesh);
                    const tracking = answer.value.tracking;
                    const captured = input;
                    if (!captured) return Result.err("Corner input replica was released");
                    input = undefined;
                    accepted = true;
                    return Result.ok({
                        inputs: [captured],
                        result: {
                            shape: output,
                            faceMap: Array.from(tracking.faceMap),
                            edgeMap: Array.from(tracking.edgeMap),
                            faceEdgeMap: Array.from(tracking.faceEdgeMap),
                            faceAncestors: Array.from(tracking.faceAncestors),
                            edgeAncestors: Array.from(tracking.edgeAncestors),
                            cornerFaces: Array.from(answer.value.cornerFaces),
                            g0Error: answer.value.g0Error,
                            g1Error: answer.value.g1Error,
                            fitDistanceError: answer.value.fitDistanceError,
                            fitAngleError: answer.value.fitAngleError,
                        },
                    });
                } catch (error) {
                    this.mainTrapped = error instanceof WebAssembly.RuntimeError;
                    if (this.mainTrapped)
                        this.quarantine("Main geometry runtime failed while installing a corner replica");
                    return Result.err(
                        error instanceof Error ? error.message : "Corner worker replica installation failed",
                    );
                } finally {
                    if (!accepted && !this.mainTrapped) {
                        output?.dispose();
                        input?.dispose();
                    }
                    input = undefined;
                }
            },
        };
    }

    /** A deadline destroys leases, not local shapes or the main module. */
    private retireWorker(worker: KernelWorkerClient): void {
        if (this.worker !== worker) return;
        this.removeFailureHandler?.();
        this.removeFailureHandler = undefined;
        for (const entry of this.resident.values()) entry.unsubscribe();
        this.resident.clear();
        this.worker = undefined;
        worker.dispose();
    }

    booleanTracked(
        operation: "fuse" | "cut" | "common",
        args: IShape[],
        tools: IShape[],
        options?: { mesh?: boolean },
    ): IAsyncShapeOperation<AsyncTrackedBoolean> | undefined {
        if (this.nativeFailure !== undefined) return this.failedOperation();
        if (this.disabled || ![...args, ...tools].every((shape) => shape instanceof OccShape))
            return undefined;
        let inputs: OccShape[] = [];
        const requestInputs: ReplicaInput[] = [];
        let hits = 0;
        const capture = PerformanceTrace.enabled ? PerformanceTrace.begin("replica.capture") : undefined;
        try {
            if (!this.worker) {
                this.worker = this.createWorker();
                this.removeFailureHandler = this.worker.addNativeFailureHandler((error) =>
                    this.quarantine(error.message),
                );
                if (this.nativeFailure !== undefined) return this.failedOperation();
            }
            for (const shape of [...args, ...tools] as OccShape[]) {
                let cached = this.resident.get(shape);
                // Shape callbacks eagerly invalidate normal mutations. Exact BREP comparison is
                // still required for aliases (curve/surface edits or direct native access).
                if (cached && cached.version !== exportBrep(shape.shape, "version")) {
                    this.evict(cached);
                    cached = undefined;
                }
                const expected = cached?.topology ?? inspectTopology(shape.shape);
                // Keep the detached snapshot used for capture, instead of deleting it and later
                // parsing the same BREP back into yet another main-thread input replica.
                const frozen = copyReplica(shape.shape);
                inputs.push(frozen);
                let topology: ReplicaTopology;
                const verify = PerformanceTrace.enabled
                    ? PerformanceTrace.begin("replica.verify.copy")
                    : undefined;
                try {
                    topology = replicaTopology(wasm, frozen.shape);
                    if (!sameReplicaTopology(expected, topology))
                        throw new Error("Input clone topology order changed");
                } finally {
                    if (verify) PerformanceTrace.end(verify);
                }
                if (cached) {
                    // A lease is transferred, never borrowed. OCCT can mutate operands, so this
                    // particular native version cannot serve another request after consumption.
                    this.resident.delete(shape);
                    cached.unsubscribe();
                    requestInputs.push({ handle: cached.handle });
                    hits++;
                } else {
                    requestInputs.push({ brep: exportBrep(frozen.shape, "input"), topology });
                }
            }
        } catch (error) {
            this.mainTrapped = error instanceof WebAssembly.RuntimeError;
            if (this.mainTrapped) this.quarantine("Main geometry runtime failed while capturing a replica");
            else this.disable();
            if (this.mainTrapped) throw error;
            for (const input of inputs) input.dispose();
            return undefined;
        } finally {
            if (capture)
                PerformanceTrace.end(capture, { residentHits: hits, inputs: args.length + tools.length });
        }
        const worker = this.worker;
        const releaseReply = (result: KernelResult<BooleanReplica> | undefined) => {
            if (result?.ok && result.value.handle)
                void worker.request("release", { handles: [result.value.handle] });
        };
        const abort = new AbortController();
        let reply: KernelResult<BooleanReplica> | undefined;
        let consumed = false;
        let canFallback = false;
        const cancel = () => {
            if (consumed) return;
            consumed = true;
            this.active.delete(cancel);
            releaseReply(reply);
            reply = undefined;
            if (!this.mainTrapped) for (const input of inputs) input.dispose();
            inputs = [];
            abort.abort();
        };
        this.active.add(cancel);
        const span = PerformanceTrace.enabled
            ? PerformanceTrace.begin("worker.rpc", { operation })
            : undefined;
        const ready = worker
            .request(
                "booleanReplica",
                {
                    operation,
                    left: requestInputs.slice(0, args.length),
                    right: requestInputs.slice(args.length),
                    mesh: options?.mesh,
                    retain: !options?.mesh,
                },
                abort.signal,
            )
            .then((result) => {
                if (!consumed) reply = result;
                else releaseReply(result);
                if (!result.ok && result.error.code === "timeout") this.retireWorker(worker); // Acceptance can precede this microtask's cancellation.
                if (span && PerformanceTrace.enabled)
                    PerformanceTrace.end(span, {
                        cancelled: abort.signal.aborted,
                        nativeMs: result.ok ? result.value.nativeMs : undefined,
                    });
            });
        return {
            ready,
            get canFallback() {
                return canFallback;
            },
            cancel,
            take: () => {
                if (consumed || !reply) return Result.err(this.nativeFailure ?? "Worker result unavailable");
                consumed = true;
                this.active.delete(cancel);
                const result = reply;
                reply = undefined;
                if (!result.ok) {
                    canFallback = result.error.code === "unavailable" || result.error.code === "invalid";
                    for (const input of inputs) input.dispose();
                    inputs = [];
                    if (canFallback) this.disable();
                    else if (result.error.code !== "timeout" && result.error.code !== "cancelled")
                        this.quarantine(result.error.message);
                    return Result.err(result.error.message);
                }
                const owned: IShape[] = [];
                let accepted = false;
                let trapped = false;
                let retained = false;
                const install = PerformanceTrace.enabled
                    ? PerformanceTrace.begin("replica.install")
                    : undefined;
                try {
                    const shape = importReplica(result.value);
                    owned.push(shape);
                    let matches: boolean;
                    const verify = PerformanceTrace.enabled
                        ? PerformanceTrace.begin("replica.verify.output")
                        : undefined;
                    try {
                        matches = sameReplicaTopology(
                            result.value.topology,
                            replicaTopology(wasm, shape.shape),
                        );
                    } finally {
                        if (verify) PerformanceTrace.end(verify);
                    }
                    if (!matches) {
                        canFallback = true;
                        this.disable();
                        return Result.err("Output BREP topology order changed");
                    }
                    if (result.value.mesh) installMesh(shape, result.value.mesh);
                    const tracking = result.value.tracking;
                    const tracked: TrackedShape = {
                        shape,
                        faceMap: Array.from(tracking.faceMap),
                        edgeMap: Array.from(tracking.edgeMap),
                        faceEdgeMap: Array.from(tracking.faceEdgeMap),
                        faceAncestors: Array.from(tracking.faceAncestors),
                        edgeAncestors: Array.from(tracking.edgeAncestors),
                        capFaces: Array.from(tracking.capFaces),
                    };
                    if (result.value.handle) {
                        this.retain(shape, result.value, worker);
                        retained = true;
                    }
                    const capturedInputs = inputs;
                    inputs = []; // Ownership goes to the caller; the completed task retains none.
                    accepted = true;
                    return Result.ok({ result: tracked, inputs: capturedInputs });
                } catch (error) {
                    trapped = error instanceof WebAssembly.RuntimeError;
                    this.mainTrapped = trapped;
                    if (trapped) this.quarantine("Main geometry runtime failed while installing a replica");
                    else this.disable();
                    if (trapped) throw error;
                    canFallback = true;
                    return Result.err("Worker replica import failed");
                } finally {
                    if (!retained) releaseReply(result);
                    if (!accepted && !trapped) {
                        for (const shape of owned) shape.dispose();
                        for (const input of inputs) input.dispose();
                    }
                    inputs = [];
                    if (install) PerformanceTrace.end(install);
                }
            },
        };
    }

    private retain(source: OccShape, result: BooleanReplica, worker: KernelWorkerClient): void {
        if (!result.handle) return;
        const entry: ResidentReplica = {
            source,
            worker,
            handle: result.handle,
            topology: result.topology,
            version: exportBrep(source.shape, "retain"),
            unsubscribe: () => {},
        };
        this.resident.set(source, entry);
        entry.unsubscribe = source.addReplicaInvalidation(() => this.evict(entry));
        while (this.resident.size > HybridShapeFactory.MAX_RESIDENT) {
            const oldest = this.resident.values().next().value;
            if (oldest) this.evict(oldest);
        }
    }

    private evict(entry: ResidentReplica): void {
        if (this.resident.get(entry.source) !== entry) return;
        this.resident.delete(entry.source);
        entry.unsubscribe();
        void entry.worker.request("release", { handles: [entry.handle] });
    }

    private disable(): void {
        this.disabled = true;
        this.dispose();
    }

    private quarantine(message: string): void {
        this.nativeFailure ??= message || "Geometry worker native operation failed";
        this.dispose();
    }

    private failedOperation(): IAsyncShapeOperation<AsyncTrackedBoolean> {
        return {
            ready: Promise.resolve(),
            canFallback: false,
            take: () => Result.err(this.nativeFailure ?? "Geometry worker failed"),
            cancel: () => {},
        };
    }

    dispose(): void {
        this.removeFailureHandler?.();
        this.removeFailureHandler = undefined;
        for (const cancel of [...this.active]) cancel();
        for (const entry of this.resident.values()) entry.unsubscribe();
        this.resident.clear();
        // Termination releases the entire worker heap, including cached and in-flight leases.
        this.worker?.dispose();
        this.worker = undefined;
    }
}

function importReplica(snapshot: ShapeReplica): OccShape {
    const span = PerformanceTrace.enabled ? PerformanceTrace.begin("replica.import") : undefined;
    try {
        return ownReplica(wasm.Converter.convertFromBrep(snapshot.brep));
    } finally {
        if (span) PerformanceTrace.end(span);
    }
}

function copyReplica(shape: TopoDS_Shape): OccShape {
    const span = PerformanceTrace.enabled ? PerformanceTrace.begin("replica.copy") : undefined;
    try {
        return ownReplica(wasm.Shape.clone(shape), true);
    } finally {
        if (span) PerformanceTrace.end(span);
    }
}

function exportBrep(shape: TopoDS_Shape, phase: "input" | "version" | "retain"): string {
    const span = PerformanceTrace.enabled ? PerformanceTrace.begin(`replica.export.${phase}`) : undefined;
    try {
        return wasm.Converter.convertToBrep(shape);
    } finally {
        if (span) PerformanceTrace.end(span);
    }
}

function inspectTopology(shape: TopoDS_Shape): ReplicaTopology {
    const span = PerformanceTrace.enabled ? PerformanceTrace.begin("replica.verify.source") : undefined;
    try {
        return replicaTopology(wasm, shape);
    } finally {
        if (span) PerformanceTrace.end(span);
    }
}

function ownReplica(raw: TopoDS_Shape, clean = false): OccShape {
    let retained = false;
    let trapped = false;
    try {
        if (raw.isNull()) throw new Error("Invalid replica");
        if (clean) wasm.Shape.clean(raw);
        const shape = OccShape.wrap(raw) as OccShape;
        retained = shape.shape === raw;
        shape.useTransientTriangulation();
        return shape;
    } catch (error) {
        trapped = error instanceof WebAssembly.RuntimeError;
        throw error;
    } finally {
        if (!retained && !trapped) raw.delete();
    }
}

function installMesh(shape: OccShape, mesh: WorkerMesh): void {
    const faces = wasm.Shape.findSubShapes(shape.shape, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
    const edges = wasm.Shape.findSubShapes(shape.shape, wasm.TopAbs_ShapeEnum.TopAbs_EDGE);
    const owned: IShape[] = [];
    let accepted = false;
    try {
        if (
            !mesh.faceTopology ||
            !mesh.edgeTopology ||
            mesh.faceTopology.length * 2 !== mesh.faceGroups.length ||
            mesh.edgeTopology.length * 2 !== mesh.edgeGroups.length
        )
            throw new Error("Invalid mesh topology");
        const faceRanges = Array.from(mesh.faceTopology, (index, meshIndex) => {
            if (!faces[index]) throw new Error("Invalid mesh face index");
            const sub = new OccSubFaceShape({
                parent: shape,
                shape: wasm.TopoDS.face(faces[index]),
                index,
                meshIndex,
                id: `${shape.id}_f${index.toString().padStart(4, "0")}`,
            });
            owned.push(sub);
            return {
                shape: sub,
                start: mesh.faceGroups[2 * meshIndex],
                count: mesh.faceGroups[2 * meshIndex + 1],
            };
        });
        const edgeRanges = Array.from(mesh.edgeTopology, (index, meshIndex) => {
            if (!edges[index]) throw new Error("Invalid mesh edge index");
            const sub = new OccSubEdgeShape({
                parent: shape,
                shape: wasm.TopoDS.edge(edges[index]),
                index,
                meshIndex,
                id: `${shape.id}_e${index.toString().padStart(4, "0")}`,
            });
            owned.push(sub);
            return {
                shape: sub,
                start: mesh.edgeGroups[2 * meshIndex],
                count: mesh.edgeGroups[2 * meshIndex + 1],
            };
        });
        shape.installMesh({
            faces: {
                position: mesh.positions,
                normal: mesh.normals,
                uv: mesh.uv,
                index: mesh.indices,
                color: VisualConfig.defaultFaceColor,
                groups: [],
                range: faceRanges,
            },
            edges: {
                position: mesh.edgePositions,
                color: VisualConfig.defaultEdgeColor,
                lineType: "solid",
                range: edgeRanges,
            },
            vertexs: undefined,
            dispose: () => {
                for (const sub of owned) sub.dispose();
            },
        });
        accepted = true;
    } finally {
        for (const face of faces) face.delete();
        for (const edge of edges) edge.delete();
        if (!accepted) for (const sub of owned) sub.dispose();
    }
}
