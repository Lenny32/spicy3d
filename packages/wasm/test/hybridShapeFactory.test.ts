// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4, Plane, ShapeTypes } from "@spicy3d/core";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import { captureReplica, replicaTopology, sameReplicaTopology } from "../src/replicaTopology";
import type { OccFace, OccShape, OccSolid } from "../src/shape";
import { createBox, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
import "./setup";

test("direct traversal handles retain native identity", () => {
    const box = createBox(new ShapeFactory()) as OccSolid;
    const shells = wasm.Shape.getDirectSubShapes(box.shape);
    const faces = wasm.Shape.getDirectSubShapes(shells[0]);
    const enumerated = wasm.Shape.findSubShapes(box.shape, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
    try {
        expect(faces.map((face) => wasm.Shape.ptr(face))).toEqual(
            enumerated.map((face) => wasm.Shape.ptr(face)),
        );
        expect(faces[0].isSame(faces[0])).toBe(true);
        expect(faces[0].isSame(enumerated[0])).toBe(true);
    } finally {
        [...enumerated, ...faces, ...shells].forEach((shape) => shape.delete());
        box.dispose();
    }
});

test.each([
    "fuse",
    "cut",
    "common",
] as const)("hybrid %s preserves ordered topology/history and uses local pick replicas", async (operation) => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory();
    const a = createBox(factory);
    const b = createBox(factory).transformedMul(Matrix4.fromTranslation(5, 2, 3));
    const task = hybrid.booleanTracked(operation, [a], [b], { mesh: true });
    expect(task).not.toBeUndefined();
    try {
        await task!.ready;
        const reply = unwrapOk(task!.take());
        try {
            const baseline = unwrapOk(
                {
                    fuse: factory.booleanFuseTracked.bind(factory),
                    cut: factory.booleanCutTracked.bind(factory),
                    common: factory.booleanCommonTracked.bind(factory),
                }[operation]([a], [b]),
            );
            try {
                expect(replicaTopology(wasm, (reply.result.shape as OccShape).shape)).toEqual(
                    replicaTopology(wasm, (baseline.shape as OccShape).shape),
                );
                for (const key of [
                    "faceMap",
                    "edgeMap",
                    "faceEdgeMap",
                    "faceAncestors",
                    "edgeAncestors",
                    "capFaces",
                ] as const) {
                    expect(reply.result[key]).toEqual(baseline[key]);
                }
            } finally {
                baseline.shape.dispose();
            }
            const mesher = rs.spyOn(wasm, "Mesher");
            const localFaces = reply.result.shape.findSubShapes(ShapeTypes.face);
            const localEdges = reply.result.shape.findSubShapes(ShapeTypes.edge);
            try {
                const mesh = reply.result.shape.mesh;
                expect(mesh.faces!.index.length).toBeGreaterThan(0);
                for (const range of mesh.faces!.range) {
                    expect(range.shape.parent).toBe(reply.result.shape);
                    expect(range.shape.isSame(localFaces[range.shape.index])).toBe(true);
                    expect(range.shape.mesh.faces!.index.length).toBe(range.count);
                }
                for (const range of mesh.edges!.range) {
                    expect(range.shape.isSame(localEdges[range.shape.index])).toBe(true);
                    expect(range.shape.mesh.edges!.position.length).toBe(range.count * 3);
                }
                expect(mesher).not.toHaveBeenCalled();
            } finally {
                rs.restoreAllMocks();
                localFaces.forEach((s) => s.dispose());
                localEdges.forEach((s) => s.dispose());
            }
        } finally {
            reply.inputs.forEach((shape) => shape.dispose());
            reply.result.shape.dispose();
        }
        expect(await transport.client.request("stats", undefined)).toEqual({
            ok: true,
            value: { shapes: 0 },
        });
    } finally {
        task!.cancel();
        a.dispose();
        b.dispose();
        hybrid.dispose();
    }
});

test("snapshot owns geometry before await, even when a borrowed face is disposed or transformed", async () => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory();
    const a = unwrapOk(factory.rect(Plane.XY, 10, 20));
    const b = unwrapOk(factory.rect(Plane.XY, 20, 10));
    const expected = replicaTopology(wasm, (a as OccFace).shape);
    const task = hybrid.booleanTracked("fuse", [a], [b]);
    expect(task).not.toBeUndefined();
    a.dispose();
    b.dispose();
    try {
        await task!.ready;
        const result = unwrapOk(task!.take());
        try {
            expect(replicaTopology(wasm, (result.inputs[0] as OccShape).shape)).toEqual(expected);
        } finally {
            result.inputs.forEach((shape) => shape.dispose());
            result.result.shape.dispose();
        }
    } finally {
        hybrid.dispose();
    }
});

test("topology order mismatch is refused despite identical counts", async () => {
    const transport = new NativeWorkerTransport();
    const shape = createBox(new ShapeFactory()) as OccSolid;
    const topology = replicaTopology(wasm, shape.shape);
    const brep = wasm.Converter.convertToBrep(shape.shape);
    const reordered = { ...topology, faces: [...topology.faces].reverse() };
    expect(reordered.faces).not.toEqual(topology.faces);
    try {
        expect(
            await transport.client.request("booleanReplica", {
                operation: "fuse",
                left: [{ brep, topology: reordered }],
                right: [{ brep, topology }],
            }),
        ).toEqual({ ok: false, error: { code: "invalid", message: "Input BREP topology order changed" } });
        expect(await transport.client.request("stats", undefined)).toEqual({
            ok: true,
            value: { shapes: 0 },
        });
    } finally {
        shape.dispose();
        transport.client.dispose();
    }
});

test.each([false, true])("BREP preserves every subshape in order, transformed=%s", (transformed) => {
    const original = createBox(new ShapeFactory());
    const shape = (
        transformed ? original.transformedMul(Matrix4.fromTranslation(5, 2, 3)) : original
    ) as OccShape;
    const copy = wasm.Converter.convertFromBrep(wasm.Converter.convertToBrep(shape.shape));
    try {
        const snapshot = captureReplica(wasm, shape.shape);
        const roundtrip = wasm.Converter.convertFromBrep(snapshot.brep);
        try {
            const actual = replicaTopology(wasm, roundtrip);
            expect(actual.faces).toEqual(snapshot.topology.faces);
            expect(actual.edges).toEqual(snapshot.topology.edges);
            const expectedGraph = JSON.parse(snapshot.topology.graph);
            const actualGraph = JSON.parse(actual.graph);
            expect(actualGraph[1].length).toBe(expectedGraph[1].length);
            for (let i = 0; i < actualGraph[1].length; i++) {
                expect({ index: i, value: actualGraph[1][i] }).toEqual({
                    index: i,
                    value: expectedGraph[1][i],
                });
            }
        } finally {
            roundtrip.delete();
        }
        for (const type of [wasm.TopAbs_ShapeEnum.TopAbs_FACE, wasm.TopAbs_ShapeEnum.TopAbs_EDGE]) {
            const a = wasm.Shape.findSubShapes(shape.shape, type);
            const b = wasm.Shape.findSubShapes(copy, type);
            try {
                expect(a.length).toBe(b.length);
                for (let i = 0; i < a.length; i++) {
                    expect(wasm.Converter.convertToBrep(a[i]).replace(/(?<=\s)-0(?=\s)/g, "0")).toBe(
                        wasm.Converter.convertToBrep(b[i]).replace(/(?<=\s)-0(?=\s)/g, "0"),
                    );
                }
            } finally {
                a.forEach((s) => s.delete());
                b.forEach((s) => s.delete());
            }
        }
    } finally {
        copy.delete();
        shape.dispose();
        original.dispose();
    }
});

test("cancelled completed snapshots never create local imports", async () => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory();
    const a = createBox(factory);
    const b = createBox(factory);
    const task = hybrid.booleanTracked("fuse", [a], [b]);
    expect(task).not.toBeUndefined();
    try {
        await task!.ready;
        const imported = rs.spyOn(wasm.Converter, "convertFromBrep");
        task!.cancel();
        expect(task!.take().isOk).toBe(false);
        expect(imported).not.toHaveBeenCalled();
    } finally {
        rs.restoreAllMocks();
        a.dispose();
        b.dispose();
        hybrid.dispose();
    }
});

test("worker loading errors allow synchronous fallback without quarantining the provider", async () => {
    const transport = new NativeWorkerTransport();
    // A module loading error happens before the worker can receive queued requests.
    const post = rs.spyOn(transport, "postMessage").mockImplementation((_message) => {});
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory(hybrid);
    const a = createBox(factory);
    const b = createBox(factory);
    try {
        const task = hybrid.booleanTracked("fuse", [a], [b]);
        expect(task).not.toBeUndefined();
        if (!task) throw new Error("Missing worker operation");
        transport.dispatchEvent(new Event("error"));
        await task.ready;
        expect(task.take().isOk).toBe(false);
        expect(task.canFallback).toBe(true);
        expect(hybrid.failure).toBeUndefined();
        expect(hybrid.available).toBe(false);
        expect(hybrid.booleanTracked("fuse", [a], [b])).toBeUndefined();
        const fallback = unwrapOk(factory.booleanFuseTracked([a], [b]));
        try {
            expect(fallback.shape.geometryBoundingBox().max.x).toBeCloseTo(10, 6);
            expect(fallback.shape.volume()).toBeCloseTo(6000, 6);
        } finally {
            fallback.shape.dispose();
        }
    } finally {
        post.mockRestore();
        hybrid.dispose();
        a.dispose();
        b.dispose();
    }
});

test.each([
    "error",
    "messageerror",
])("worker %s after initialization keeps native quarantine", async (type) => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory(hybrid);
    const a = createBox(factory);
    const b = createBox(factory);
    try {
        // The transport announces initialization before processing the first native request.
        const task = hybrid.booleanTracked("fuse", [a], [b]);
        expect(task).not.toBeUndefined();
        if (!task) throw new Error("Missing worker operation");
        transport.dispatchEvent(new Event(type));
        await task.ready;
        expect(task.take().isOk).toBe(false);
        expect(task.canFallback).toBe(false);
        expect(hybrid.failure).toBe("Geometry worker connection failed");
        const synchronous = factory.booleanFuseTracked([a], [b]);
        expect(synchronous.isOk).toBe(false);
        expect(synchronous.error).toBe(hybrid.failure);
        const requests = transport.requests.length;
        const next = hybrid.booleanTracked("fuse", [a], [b]);
        expect(next).not.toBeUndefined();
        if (!next) throw new Error("Missing quarantined operation");
        await next.ready;
        expect(next.take().error).toBe(hybrid.failure);
        expect(next.canFallback).toBe(false);
        expect(transport.requests).toHaveLength(requests);
    } finally {
        hybrid.dispose();
        a.dispose();
        b.dispose();
    }
});

test("rollback replica meshing retains render buffers and local picking but releases native tessellation", async () => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const factory = new ShapeFactory();
    const a = createBox(factory);
    const b = createBox(factory);
    const task = hybrid.booleanTracked("fuse", [a], [b]);
    expect(task).not.toBeUndefined();
    try {
        await task!.ready;
        const result = unwrapOk(task!.take());
        const shape = result.result.shape as OccShape;
        try {
            const topology = replicaTopology(wasm, shape.shape);
            const clean = rs.spyOn(wasm.Shape, "clean");
            const mesh = shape.mesh;
            expect(mesh.faces!.index.length).toBe(36);
            expect(shape.mesh).toBe(mesh);
            expect(clean).toHaveBeenCalledTimes(1);
            const brep = wasm.Converter.convertToBrep(shape.shape);
            expect(brep).toContain("Triangulations 0");
            expect(brep).toContain("PolygonOnTriangulations 0");
            expect(sameReplicaTopology(topology, replicaTopology(wasm, shape.shape))).toBe(true);
            const faces = shape.findSubShapes(ShapeTypes.face);
            try {
                for (const range of mesh.faces!.range)
                    expect(range.shape.isSame(faces[range.shape.index])).toBe(true);
            } finally {
                for (const face of faces) face.dispose();
            }
        } finally {
            for (const input of result.inputs) input.dispose();
            shape.dispose();
        }
    } finally {
        rs.restoreAllMocks();
        a.dispose();
        b.dispose();
        hybrid.dispose();
    }
});

test("self-intersection details travel through the bounded replica worker", async () => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const box = createBox(new ShapeFactory());
    try {
        const task = hybrid.selfIntersectionDetails(box);
        await task.ready;
        expect(unwrapOk(task.take())).toBe("");
        const request = transport.requests.find(
            (entry) => entry.type === "request" && entry.operation === "checkSelfIntersectionReplica",
        );
        expect(request).toMatchObject({ args: { details: true } });
    } finally {
        hybrid.dispose();
        box.dispose();
    }
});

test("bounded thicken rejects topologically valid output that intersects itself", async () => {
    const transport = new NativeWorkerTransport();
    const hybrid = new HybridShapeFactory(() => transport.client);
    const box = createBox(new ShapeFactory());
    const details = rs
        .spyOn(wasm.Shape, "selfIntersectionDetails")
        .mockReturnValue(
            "Shape intersects itself; output face indices (zero-based): 1 3; approximate faulty region center xyz (mm): (2, 4, 6)",
        );
    try {
        const task = hybrid.shapeOperation({
            method: "makeThickSolidByJoin",
            shape: box,
            closingFaces: [],
            thickness: -1,
            joinType: "arc",
            mode: "skin",
            intersection: false,
        });
        await task.ready;
        const result = task.take();
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("Thicken result: Shape intersects itself");
        expect(result.error).toContain("1 3");
        expect(result.error).toContain("(2, 4, 6)");
        expect(details).toHaveBeenCalledTimes(1);
    } finally {
        details.mockRestore();
        hybrid.dispose();
        box.dispose();
    }
});
