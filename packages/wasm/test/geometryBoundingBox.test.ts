// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Matrix4, XYZ } from "@spicy3d/core";
import { type OccEdge, OccShape, type OccSolid, OccSubFaceShape } from "../src/shape";
import { createBox, createSphere, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

afterEach(() => {
    rs.restoreAllMocks();
});

test("geometry bounds use the existing non-triangulated kernel path once, without a mesh", () => {
    const box = createBox(createTestFactory(), 10, 20, 30) as OccSolid;
    const mesh = rs.spyOn(OccShape.prototype, "mesh", "get");
    const bounds = rs.spyOn(wasm.Shape, "boundingBox");
    try {
        const first = box.geometryBoundingBox();
        expect(first.min.x).toBeCloseTo(0, 6);
        expect(first.max.x).toBeCloseTo(10, 6);
        expect(first.max.y).toBeCloseTo(20, 6);
        expect(first.max.z).toBeCloseTo(30, 6);
        expect(box.geometryBoundingBox()).toBe(first);
        expect(bounds).toHaveBeenCalledExactlyOnceWith(box.shape, false);
        expect(mesh).not.toHaveBeenCalled();
        expect(Reflect.get(box, "_mesh")).toBeUndefined();
    } finally {
        box.dispose();
    }
});

test("geometry and ordinary shape bounds cache exact geometry without meshing", () => {
    const sphere = createSphere(createTestFactory(), XYZ.zero, 10) as OccSolid;
    try {
        const geometry = sphere.geometryBoundingBox();
        const bounds = sphere.boundingBox();
        expect(bounds).toEqual(geometry);
        expect(bounds).not.toBe(geometry);
        expect(sphere.boundingBox()).toBe(bounds);
        expect(sphere.geometryBoundingBox()).toBe(geometry);
        expect(Reflect.get(sphere, "_mesh")).toBeUndefined();
        expect(geometry.min.x).toBeCloseTo(-10, 6);
        expect(geometry.max.x).toBeCloseTo(10, 6);
    } finally {
        sphere.dispose();
    }
});

test("sub-face geometry bounds do not access the parent render mesh", () => {
    const box = createBox(createTestFactory()) as OccSolid;
    const rawFaces = wasm.Shape.findSubShapes(box.shape, wasm.TopAbs_ShapeEnum.TopAbs_FACE);
    const face = new OccSubFaceShape({
        shape: wasm.TopoDS.face(rawFaces[0]),
        parent: box,
        index: 0,
    });
    const mesh = rs.spyOn(OccShape.prototype, "mesh", "get");
    const subMesh = rs.spyOn(OccSubFaceShape.prototype, "mesh", "get");
    try {
        const bounds = face.geometryBoundingBox();
        expect(bounds).toEqual(wasm.Shape.boundingBox(face.shape, false));
        expect(bounds.max.z - bounds.min.z).toBeCloseTo(30, 6);
        expect(mesh).not.toHaveBeenCalled();
        expect(subMesh).not.toHaveBeenCalled();
        expect(Reflect.get(face, "_mesh")).toBeUndefined();
        expect(Reflect.get(box, "_mesh")).toBeUndefined();
    } finally {
        face.dispose();
        for (const raw of rawFaces) raw.delete();
        box.dispose();
    }
});

test("replacing the location invalidates geometry bounds instead of compounding transforms", () => {
    const box = createBox(createTestFactory()) as OccSolid;
    try {
        const original = box.geometryBoundingBox();
        box.matrix = Matrix4.fromTranslation(100, 0, 0);
        const translated = box.geometryBoundingBox();
        expect(translated).not.toBe(original);
        expect(translated.min.x).toBeCloseTo(100, 6);
        box.matrix = Matrix4.fromTranslation(5, 0, 0);
        expect(box.geometryBoundingBox().min.x).toBeCloseTo(5, 6);
        expect(box.geometryBoundingBox().max.x).toBeCloseTo(15, 6);
        expect(Reflect.get(box, "_mesh")).toBeUndefined();
    } finally {
        box.dispose();
    }
});

test("changing shape tolerance invalidates cached bounds without padding exact geometry", () => {
    const box = createBox(createTestFactory()) as OccSolid;
    const query = rs.spyOn(wasm.Shape, "boundingBox");
    try {
        const original = box.geometryBoundingBox();
        box.setTolerance(0.1);
        const bounds = box.geometryBoundingBox();
        expect(bounds).not.toBe(original);
        expect(bounds.min.x).toBeCloseTo(0, 6);
        expect(bounds.max.x).toBeCloseTo(10, 6);
        expect(query).toHaveBeenCalledTimes(2);
        expect(Reflect.get(box, "_mesh")).toBeUndefined();
    } finally {
        box.dispose();
    }
});

test("updating an edge's geometry invalidates geometry bounds", () => {
    const factory = createTestFactory();
    const edge = unwrapOk(factory.line(XYZ.zero, XYZ.unitX)) as OccEdge;
    const replacement = unwrapOk(factory.line(new XYZ(5, 0, 0), new XYZ(15, 0, 0))) as OccEdge;
    try {
        const original = edge.geometryBoundingBox();
        edge.update(replacement.curve);
        const bounds = edge.geometryBoundingBox();
        expect(bounds).not.toBe(original);
        expect(bounds.min.x).toBeCloseTo(5, 6);
        expect(bounds.max.x).toBeCloseTo(15, 6);
        expect(Reflect.get(edge, "_mesh")).toBeUndefined();
    } finally {
        edge.dispose();
        replacement.dispose();
    }
});
