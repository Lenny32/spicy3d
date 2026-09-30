// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import {
    EditableShapeNode,
    type IFace,
    type INodeVisual,
    Matrix4,
    PerformanceTrace,
    Plane,
    Result,
    Serializer,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { allProfiles, resolveProfiles, sketchProfiles } from "../src/features/profileBuilder";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { captureExternalRef } from "../src/sketch/externalRef";
import { ConstraintKind, type SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});

afterEach(() => {
    PerformanceTrace.disable();
    rs.restoreAllMocks();
});
afterAll(() => {
    rs.unstubAllGlobals();
});

function rectangle(width = 10): SketchData {
    return {
        entities: [
            { id: 1, type: "line", params: [0, 0, width, 0] },
            { id: 2, type: "line", params: [width, 0, width, 10] },
            { id: 3, type: "line", params: [width, 10, 0, 10] },
            { id: 4, type: "line", params: [0, 10, 0, 0] },
        ],
        constraints: [],
    };
}

class DisplaySketch extends SketchNode {
    notifyDisplay(): void {
        this.emitPropertyChanged("mesh", this._mesh!);
    }
}

function setup(data = rectangle()) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(sketch);
    return { doc, sketch };
}

function profiles(sketch: SketchNode) {
    const result = sketchProfiles(sketch);
    expect(result.isOk).toBe(true);
    return result.value;
}

function addBody(doc: TestDocument, sketch: SketchNode) {
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 5 }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return body;
}

test("rendering, profile selection and actual extrusion share one construction", () => {
    const { doc, sketch } = setup();
    const wire = rs.spyOn(shapeFactory, "wire");
    const face = rs.spyOn(shapeFactory, "face");
    const mesh = sketch.mesh;
    expect(mesh.faces!.range.length).toBe(1);
    const first = profiles(sketch);
    expect(profiles(sketch)).toBe(first);
    expect(resolveProfiles(sketch).value[0].face).toBe(first.outer[0]);
    expect(mesh.faces!.range[0].shape.isSame(first.outer[0])).toBe(true);
    const body = addBody(doc, sketch);
    expect(body.shape.value.volume()).toBeCloseTo(500, 6);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(face).toHaveBeenCalledTimes(1);
    // The temporary wire has been freed, while the cached face remains usable.
    expect(() => wire.mock.results[0].value.value.isNull()).toThrow();
    expect(first.outer[0].area()).toBeCloseTo(100, 6);
    body.dispose();
    sketch.dispose();
});

test("display toggles refresh pickable faces without evaluating a dependent body", () => {
    const { doc, sketch } = setup();
    const body = addBody(doc, sketch);
    const evaluate = rs.spyOn(body as unknown as { rebuildFromUpstream(): void }, "rebuildFromUpstream");
    const changed = rs.fn((property: string) => property);
    sketch.onPropertyChanged(changed);
    const shape = sketch.shape;
    const bodyShape = body.shape;
    const revision = sketch.geometryRevision;
    const first = profiles(sketch);
    const release = rs.spyOn(first.outer[0], "dispose");

    sketch.setShowProfileFaces(false);
    expect(sketch.mesh.faces?.range ?? []).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    sketch.setShowProfileFaces(true);
    expect(sketch.mesh.faces!.range.length).toBe(1);
    sketch.setShowProfileFaces(true);
    expect(changed.mock.calls.map(([property]) => property)).toEqual(["mesh", "mesh"]);
    expect(sketch.shape).toBe(shape);
    expect(sketch.geometryRevision).toBe(revision);
    expect(body.shape).toBe(bodyShape);
    expect(evaluate).not.toHaveBeenCalled();
    expect(profiles(sketch).outer[0]).not.toBe(first.outer[0]);

    sketch.setDataEmitShapeChanged(rectangle(20));
    expect(changed.mock.calls.map(([property]) => property)).toContain("shape");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(body.shape.value.volume()).toBeCloseTo(1000, 6);
    body.dispose();
    sketch.dispose();
});

test("caches are per instance and runtime only", () => {
    const { doc, sketch } = setup();
    const before = Serializer.serializeObject(sketch);
    const first = profiles(sketch);
    expect(profiles(sketch)).toBe(first);
    expect(Serializer.serializeObject(sketch)).toEqual(before);
    const other = new SketchNode({ document: doc, plane: Plane.XY, data: rectangle() });
    expect(profiles(other).outer[0]).not.toBe(first.outer[0]);
    other.dispose();
    expect(first.outer[0].area()).toBeCloseTo(100, 6);
    sketch.dispose();
});

test("unrelated display notifications retain profiles", () => {
    const { doc, sketch } = setup();
    const display = new DisplaySketch({ document: doc, plane: Plane.XY, data: rectangle() });
    const first = profiles(display);
    display.notifyDisplay();
    expect(profiles(display)).toBe(first);
    display.dispose();
    sketch.dispose();
});

test.each([
    "entities",
    "constraints",
    "plane",
    "shape",
] as const)("%s changes release cached faces before rebuilding profiles", (change) => {
    const { sketch } = setup();
    const first = profiles(sketch);
    const release = rs.spyOn(first.outer[0], "dispose");
    const revision = sketch.geometryRevision;
    switch (change) {
        case "entities":
            sketch.setDataEmitShapeChanged(rectangle(20));
            break;
        case "constraints":
            sketch.setDataEmitShapeChanged({
                ...rectangle(),
                constraints: [
                    { id: 1, kind: ConstraintKind.Horizontal, refs: [{ entityId: 1, pointIndex: 0 }] },
                ],
            });
            break;
        case "plane":
            sketch.plane = Plane.XY.translateTo(new XYZ({ x: 0, y: 0, z: 7 }));
            break;
        case "shape":
            sketch.shape = Result.ok(sketch.shape.value.clone());
            break;
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(sketch.geometryRevision).toBeGreaterThan(revision);
    const next = profiles(sketch);
    expect(next.outer[0]).not.toBe(first.outer[0]);
    expect(next.outer[0].area()).toBeCloseTo(change === "entities" ? 200 : 100, 6);
    expect(next.outer[0].boundingBox().min.z).toBeCloseTo(change === "plane" ? 7 : 0, 6);
    sketch.dispose();
});

test("undo and redo rebuild profiles for the restored geometry", () => {
    const { doc, sketch } = setup();
    const first = profiles(sketch);
    Transaction.execute(doc, "resize", () => sketch.setDataEmitShapeChanged(rectangle(20)));
    expect(profiles(sketch).outer[0].area()).toBeCloseTo(200, 6);
    doc.history.undo();
    expect(profiles(sketch).outer[0]).not.toBe(first.outer[0]);
    expect(profiles(sketch).outer[0].area()).toBeCloseTo(100, 6);
    doc.history.redo();
    expect(profiles(sketch).outer[0].area()).toBeCloseTo(200, 6);
    sketch.dispose();
});

test("a moved profile-role external reference invalidates the cached region", () => {
    const { doc, sketch } = setup({ entities: [], constraints: [] });
    const circle = shapeFactory.circle(Plane.XY.normal, XYZ.zero, 3).value;
    const source = new EditableShapeNode({ document: doc, name: "source", shape: circle });
    doc.modelManager.addNode(source);
    doc.visual.context.getVisual = (node) =>
        ({ worldTransform: () => (node === source ? source.transform : Matrix4.identity()) }) as INodeVisual;
    const ref = captureExternalRef(-100, source.id, Plane.XY, circle, undefined, "profile");
    expect(ref).not.toBeUndefined();
    sketch.setDataEmitShapeChanged({ entities: [], constraints: [], externalRefs: [ref!] });
    const first = profiles(sketch);
    const release = rs.spyOn(first.outer[0], "dispose");
    source.transform = Matrix4.fromTranslation(10, 0, 0);
    expect(release).toHaveBeenCalledTimes(1);
    const next = profiles(sketch);
    expect(next.outer[0]).not.toBe(first.outer[0]);
    expect(next.outer[0].boundingBox().min.x).toBeCloseTo(7, 2);
    expect(sketch.data.externalRefs![0].snapshot[0]).toBeCloseTo(10, 6);
    sketch.dispose();
    source.dispose();
});

test("feature replacement and body disposal cannot evict the sketch's borrowed profiles", () => {
    const { doc, sketch } = setup();
    const body = addBody(doc, sketch);
    body.setFeaturesEmitShapeChanged([
        { id: "extrude", type: "extrude", sketchId: sketch.id, depth: 5 },
        { id: "join", type: "extrude", sketchId: sketch.id, depth: 8, operation: "fuse" },
    ]);
    const intermediate = body.timelineStateAt(1)?.shape;
    expect(intermediate).not.toBeUndefined();
    const evict = rs.spyOn(intermediate!, "dispose");
    const first = profiles(sketch);
    const face = rs.spyOn(shapeFactory, "face");
    body.setFeaturesEmitShapeChanged([
        { id: "extrude", type: "extrude", sketchId: sketch.id, depth: 10 },
        { id: "join", type: "extrude", sketchId: sketch.id, depth: 12, operation: "fuse" },
    ]);
    expect(body.shape.value.volume()).toBeCloseTo(1200, 6);
    expect(evict).toHaveBeenCalledTimes(1);
    body.dispose();
    expect(profiles(sketch)).toBe(first);
    expect(first.outer[0].area()).toBeCloseTo(100, 6);
    expect(face).not.toHaveBeenCalled();
    const release = rs.spyOn(first.outer[0], "dispose");
    sketch.dispose();
    sketch.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    const late = sketchProfiles(sketch);
    expect(late.isOk).toBe(false);
    expect(late.error).toBe("Sketch is disposed");
});

test("disposing the sketch leaves its independently owned extruded output usable", () => {
    const { doc, sketch } = setup();
    const body = addBody(doc, sketch);
    sketch.dispose();
    expect(body.shape.value.volume()).toBeCloseTo(500, 6);
    body.dispose();
});

test("a prematurely released borrowed face is detected and never returned again", () => {
    const { sketch } = setup();
    const first = profiles(sketch);
    first.outer[0].dispose();
    PerformanceTrace.enable();
    const next = profiles(sketch);
    expect(next.outer[0]).not.toBe(first.outer[0]);
    expect(next.outer[0].area()).toBeCloseTo(100, 6);
    expect(profiles(sketch)).toBe(next);
    const records = PerformanceTrace.snapshot().records;
    expect(records.filter((record) => record.stage === "profile.build")).toHaveLength(1);
    expect(
        records.filter((record) => record.stage === "profile.query").map((record) => record.details),
    ).toEqual([
        { nodeId: sketch.id, cacheHit: false },
        { nodeId: sketch.id, cacheHit: true },
    ]);
    sketch.dispose();
});

test("profile tracing records every query and only builds on actual cache misses", () => {
    const { sketch } = setup();
    const serialized = Serializer.serializeObject(sketch);
    const face = rs.spyOn(shapeFactory, "face");
    PerformanceTrace.enable();
    const first = profiles(sketch);
    expect(profiles(sketch)).toBe(first);
    sketch.setShowProfileFaces(false);
    const next = profiles(sketch);
    expect(next.outer[0]).not.toBe(first.outer[0]);
    expect(face).toHaveBeenCalledTimes(2);
    const { records, dropped } = PerformanceTrace.snapshot();
    const profileRecords = records.filter((record) => record.stage.startsWith("profile."));
    expect(profileRecords.map((record) => record.stage)).toEqual([
        "profile.build",
        "profile.query",
        "profile.query",
        "profile.build",
        "profile.query",
    ]);
    expect(profileRecords.map((record) => record.details)).toEqual([
        { nodeId: sketch.id },
        { nodeId: sketch.id, cacheHit: false },
        { nodeId: sketch.id, cacheHit: true },
        { nodeId: sketch.id },
        { nodeId: sketch.id, cacheHit: false },
    ]);
    expect(profileRecords.every((record) => record.durationMs >= 0)).toBe(true);
    expect(dropped).toBe(0);
    expect(Serializer.serializeObject(sketch)).toEqual(serialized);
    sketch.dispose();
});

test("disabled profile tracing avoids clock reads and begin/end calls on both misses and hits", () => {
    const { sketch } = setup();
    PerformanceTrace.disable();
    const begin = rs.spyOn(PerformanceTrace, "begin");
    const end = rs.spyOn(PerformanceTrace, "end");
    const now = rs.spyOn(performance, "now");
    const first = profiles(sketch);
    expect(profiles(sketch)).toBe(first);
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    sketch.dispose();
});

test("a disposed sketch query is traced without recording profile construction", () => {
    const { sketch } = setup();
    sketch.dispose();
    PerformanceTrace.enable();
    const result = sketchProfiles(sketch);
    expect(result.isOk).toBe(false);
    expect(result.error).toBe("Sketch is disposed");
    const { records } = PerformanceTrace.snapshot();
    expect(records.map((record) => record.stage)).toEqual(["profile.query"]);
    expect(records[0].details).toEqual({ nodeId: sketch.id, cacheHit: false });
});

test("kernel-split region faces share the cache and all release on disposal", () => {
    const data = rectangle();
    data.entities.push({ id: 5, type: "line", params: [5, 0, 5, 10] });
    const { sketch } = setup(data);
    const split = rs.spyOn(shapeFactory, "facesFromEdges");
    const first = profiles(sketch);
    expect(first.outer.length).toBe(2);
    for (const face of first.outer) expect(face.area()).toBeCloseTo(50, 6);
    const releases = allProfiles(first).map((face) => rs.spyOn(face, "dispose"));
    expect(profiles(sketch)).toBe(first);
    expect(split).toHaveBeenCalledTimes(1);
    sketch.dispose();
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

test("nested profiles retain holes and inner selection, releasing both faces on invalidation", () => {
    const { sketch } = setup({
        entities: [
            { id: 1, type: "circle", params: [0, 0, 5] },
            { id: 2, type: "circle", params: [0, 0, 2] },
        ],
        constraints: [],
    });
    const first = profiles(sketch);
    expect(first.outer.length).toBe(1);
    expect(first.inner.length).toBe(1);
    expect(first.outer[0].area()).toBeCloseTo(21 * Math.PI, 6);
    expect(first.inner[0].area()).toBeCloseTo(4 * Math.PI, 6);
    expect(sketch.mesh.faces!.range.length).toBe(2);
    expect(profiles(sketch)).toBe(first);
    const releases = allProfiles(first).map((face) => rs.spyOn(face, "dispose"));
    sketch.setShowProfileFaces(false);
    for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
    // Hiding selectable faces must still allow extrusion from the closed geometry.
    expect(resolveProfiles(sketch).value.length).toBe(1);
    expect(profiles(sketch).outer[0].area()).toBeCloseTo(21 * Math.PI, 6);
    sketch.dispose();
});

test.each([
    "error",
    "throw",
] as const)("partial profile construction cleans up after a kernel %s", (failure) => {
    const { sketch } = setup({
        entities: [
            { id: 1, type: "circle", params: [0, 0, 2] },
            { id: 2, type: "circle", params: [10, 0, 2] },
        ],
        constraints: [],
    });
    const buildFace = shapeFactory.face.bind(shapeFactory);
    const faces: IFace[] = [];
    const face = rs.spyOn(shapeFactory, "face").mockImplementation((wires) => {
        if (faces.length === 1) {
            if (failure === "throw") throw new Error("synthetic failure");
            return Result.err("synthetic failure");
        }
        const result = buildFace(wires);
        if (result.isOk) faces.push(result.value);
        return result;
    });
    const wire = rs.spyOn(shapeFactory, "wire");
    PerformanceTrace.enable();
    if (failure === "throw") {
        expect(() => sketchProfiles(sketch)).toThrow("synthetic failure");
    } else {
        const failed = sketchProfiles(sketch);
        expect(failed.isOk).toBe(false);
        expect(failed.error).toBe("synthetic failure");
    }
    expect(faces.length).toBe(1);
    expect(() => faces[0].isNull()).toThrow();
    expect(wire).toHaveBeenCalledTimes(2);
    for (const result of wire.mock.results) expect(() => result.value.value.isNull()).toThrow();
    const records = PerformanceTrace.snapshot().records.filter((record) =>
        record.stage.startsWith("profile."),
    );
    expect(records.map((record) => record.stage)).toEqual(["profile.build", "profile.query"]);
    expect(records.map((record) => record.details)).toEqual([
        { nodeId: sketch.id },
        { nodeId: sketch.id, cacheHit: false },
    ]);
    face.mockRestore();
    expect(profiles(sketch).outer.length).toBe(2);
    sketch.dispose();
});
