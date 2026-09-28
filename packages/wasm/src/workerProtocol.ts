// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { BoundingBox, Vector3 } from "../lib/spicy-wasm";

/** Session-scoped, never serialized into a document. Not an IShape. */
export type KernelHandle = string;
export type KernelFailure = {
    code: "cancelled" | "closed" | "kernel" | "invalid" | "unavailable";
    message: string;
};
export type KernelResult<T> = { ok: true; value: T } | { ok: false; error: KernelFailure };

export type WorkerTracking = {
    faceMap: Int32Array;
    edgeMap: Int32Array;
    faceEdgeMap: Int32Array;
    faceAncestors: Int32Array;
    edgeAncestors: Int32Array;
    capFaces: Int32Array;
};

/** Groups are (start, count) pairs in the kernel mesher's local face/edge order. */
export type WorkerMesh = {
    positions: Float32Array;
    normals: Float32Array;
    uv: Float32Array;
    indices: Uint32Array;
    faceGroups: Uint32Array;
    edgePositions: Float32Array;
    edgeGroups: Uint32Array;
    /** Mesher range -> verified findSubShapes index (mesher order can differ / omit faces). */
    faceTopology?: Uint32Array;
    edgeTopology?: Uint32Array;
};

export type ReplicaTopology = { graph: string; faces: string[]; edges: string[] };
export type ShapeReplica = { brep: string; topology: ReplicaTopology };
/** A cached handle is a SINGLE-USE lease: the receiving request consumes it, even if cancelled. */
export type ReplicaInput = ShapeReplica | { handle: KernelHandle };
export type BooleanReplica = ShapeReplica & {
    handle?: KernelHandle;
    tracking: WorkerTracking;
    mesh?: WorkerMesh;
    nativeMs?: number;
};

export type KernelOperations = {
    ready: { args: undefined; result: undefined };
    box: { args: { origin: Vector3; size: Vector3 }; result: KernelHandle };
    importBrep: { args: { brep: string }; result: KernelHandle };
    exportBrep: { args: { handle: KernelHandle }; result: string };
    bounds: { args: { handle: KernelHandle }; result: BoundingBox };
    boolean: {
        args: { operation: "fuse" | "cut" | "common"; left: KernelHandle[]; right: KernelHandle[] };
        result: { handle: KernelHandle; tracking: WorkerTracking };
    };
    mesh: { args: { handle: KernelHandle }; result: WorkerMesh };
    release: { args: { handles: KernelHandle[] }; result: undefined };
    stats: { args: undefined; result: { shapes: number } };
    booleanReplica: {
        args: {
            operation: "fuse" | "cut" | "common";
            left: ReplicaInput[];
            right: ReplicaInput[];
            mesh?: boolean;
            retain?: boolean;
        };
        result: BooleanReplica;
    };
};
export type KernelOperation = keyof KernelOperations;
export type KernelRequest = {
    [K in KernelOperation]: {
        type: "request";
        id: number;
        operation: K;
        args: KernelOperations[K]["args"];
        /** Opt-in capture token, fixed when queued; cancellation does not turn off its accounting. */
        trace?: number;
    };
}[KernelOperation];
export type KernelMessage = KernelRequest | { type: "cancel"; id: number } | { type: "accept"; id: number };
export type KernelResponse =
    | { type: "result"; id: number; result: KernelResult<unknown>; events?: WorkerNativeEvent[] }
    | { type: "fatal"; message: string; code?: "kernel" | "unavailable" };

export type WorkerNativeEvent = {
    stage:
        | "worker.kernel.operation"
        | "worker.kernel.historyConversion"
        | "worker.mesh.kernel"
        | "worker.mesh.buffers"
        | "worker.replica.import"
        | "worker.replica.verify"
        | "worker.replica.export";
    started: number;
    durationMs: number;
    details: { workerId: string; requestId: number; eventId: number; boolean: boolean; operation?: string };
};

/** Only freshly allocated JS buffers are transferred, never Emscripten's heap. */
export function kernelTransfers(value: unknown): ArrayBuffer[] {
    if (!value || typeof value !== "object") return [];
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) return [value.buffer];
    return [...new Set(Object.values(value).flatMap(kernelTransfers))];
}
