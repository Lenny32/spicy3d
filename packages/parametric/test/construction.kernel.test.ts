// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type ConstructionDefinition,
    type ConstructionRef,
    captureConstructionRef,
    EditableShapeNode,
    evaluateConstruction,
    GroupNode,
    type IConstructionResolver,
    type IFace,
    Matrix4,
    Plane,
    type ResolvedConstructionSource,
    Result,
    resolveConstructionRef,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    factory = new ShapeFactory();
});

describe("strict construction reference resolution", () => {
    test("an untracked sphere center follows source edits through its unique analytic face", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        const shape = factory.sphere(xyz(1, 2, 3), 5).unchecked()!;
        const node = new EditableShapeNode({ document: doc, name: "Sphere", shape: Result.ok(shape) });
        doc.modelManager.addNode(node);
        const face = shape.findSubShapes(ShapeTypes.face)[0];
        const captured = captureConstructionRef(doc, node, face);
        expect(captured.isOk).toBe(true);
        node.shape = factory.sphere(xyz(7, 8, 9), 12);
        const result = evaluateConstruction(
            { kind: "point-center", source: captured.unchecked()! },
            { resolve: (ref) => resolveConstructionRef(doc, ref) },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected sphere center");
        expect(geometry.point.distanceTo(xyz(7, 8, 9))).toBeLessThan(1e-7);
    });

    test("an untracked box corner follows dimension edits instead of frozen coordinates", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        const shape = factory.box(Plane.XY, 10, 20, 30).unchecked()!;
        const node = new EditableShapeNode({ document: doc, name: "Box", shape: Result.ok(shape) });
        doc.modelManager.addNode(node);
        const vertex = shape
            .findSubShapes(ShapeTypes.vertex)
            .find(
                (item) =>
                    (item as import("@spicy3d/core").IVertex).point().distanceTo(xyz(10, 20, 30)) < 1e-6,
            );
        expect(vertex).not.toBeUndefined();
        const captured = captureConstructionRef(doc, node, vertex!);
        expect(captured.isOk).toBe(true);
        node.shape = factory.box(Plane.XY, 15, 25, 35);
        const result = evaluateConstruction(
            { kind: "point-vertex", vertex: captured.unchecked()! },
            { resolve: (ref) => resolveConstructionRef(doc, ref) },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected box corner");
        expect(geometry.point.distanceTo(xyz(15, 25, 35))).toBeLessThan(1e-6);
    });

    function boxSource() {
        const doc = new TestDocument({ application: createMockApplication() });
        const shape = factory.box(Plane.XY, 10, 20, 30).unchecked()!;
        const node = new EditableShapeNode({ document: doc, name: "Source", shape: Result.ok(shape) });
        doc.modelManager.addNode(node);
        const face = shape.findSubShapes(ShapeTypes.face)[0] as IFace;
        const captured = captureConstructionRef(doc, node, face);
        expect(captured.isOk).toBe(true);
        const ref = captured.unchecked()!;
        expect(ref.kind).toBe("shape");
        if (ref.kind !== "shape") throw new Error("Expected captured shape reference");
        return { doc, node, face, ref };
    }

    test("untracked sources reject changed topology instead of silently adopting the same index", () => {
        const { doc, node, ref } = boxSource();
        expect(resolveConstructionRef(doc, ref).isOk).toBe(true);
        node.shape = factory.box(Plane.XY.translateTo(xyz(100)), 10, 20, 30);
        const result = resolveConstructionRef(doc, ref);
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/changed|missing|select/i);
    });

    test.each([{ indexes: [] }, { indexes: [0, 1] }])("tracked topology with matches $indexes is invalid", ({
        indexes,
    }) => {
        const { doc, node, ref } = boxSource();
        Object.assign(node, { faceIndexesOfId: () => indexes });
        const result = resolveConstructionRef(doc, { ...ref, trackedId: "stable-face" });
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/missing|ambiguous/i);
    });

    test("unavailable body timeline positions return actionable errors", () => {
        const { doc, ref } = boxSource();
        const result = resolveConstructionRef(doc, { ...ref, featureIndex: 999 });
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/timeline|position|feature|unavailable/i);
    });

    test("shape references include parent group placement", () => {
        const { doc, node, face, ref } = boxSource();
        const group = new GroupNode({ document: doc, name: "Placed group" });
        doc.modelManager.addNode(group);
        node.parent!.move(node, group);
        group.transform = Matrix4.fromTranslation(100, 200, 300);
        node.transform = Matrix4.fromTranslation(1, 2, 3);
        const resolved = resolveConstructionRef(doc, ref);
        expect(resolved.isOk).toBe(true);
        const source = resolved.unchecked()!;
        expect(source.kind).toBe("face");
        if (source.kind !== "face") throw new Error("Expected transformed face");
        const local = face.normal(0, 0)[0];
        const world = source.face.normal(0, 0)[0];
        expect(world.distanceTo(local.add(xyz(101, 202, 303)))).toBeLessThan(1e-6);
    });
});

const xyz = (x = 0, y = 0, z = 0) => new XYZ({ x, y, z });
const sourceRef: ConstructionRef = { kind: "shape", nodeId: "source", shapeType: "face", index: 0 };
const point = (value: XYZ): ConstructionRef => ({ kind: "fixed", geometry: { kind: "point", point: value } });

function evaluate(definition: ConstructionDefinition, source: ResolvedConstructionSource) {
    const resolver: IConstructionResolver = {
        resolve: (ref) => Result.ok(ref.kind === "fixed" ? ref.geometry : source),
    };
    return evaluateConstruction(definition, resolver);
}

function cylinderFace(): IFace {
    const solid = factory.cylinder(XYZ.unitZ, XYZ.zero, 5, 10);
    expect(solid.isOk).toBe(true);
    const faces = solid.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
    const face = faces.find((candidate) => !candidate.surface().isPlanar());
    expect(face).not.toBeUndefined();
    return face!;
}

describe("construction geometry with the real kernel", () => {
    test("circle-line intersection lies on both original curves within modeling tolerance", () => {
        const z = 0;
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 5).unchecked()!;
        const line = factory.line(xyz(-10, 3, z), xyz(10, 3, z)).unchecked()!;
        const first: ConstructionRef = { kind: "shape", nodeId: "circle", shapeType: "edge", index: 0 };
        const second: ConstructionRef = { kind: "shape", nodeId: "line", shapeType: "edge", index: 0 };
        const resolver: IConstructionResolver = {
            resolve(ref) {
                const edge = ref.kind === "shape" && ref.nodeId === "circle" ? circle : line;
                return Result.ok({
                    kind: "edge",
                    start: edge.startPoint(),
                    end: edge.endPoint(),
                    curve: edge.curve,
                });
            },
        };
        const result = evaluateConstruction(
            { kind: "point-two-edges", first, second, solution: 0 },
            resolver,
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected intersection");
        expect(Math.abs(geometry.point.x)).toBeCloseTo(4, 7);
        expect(geometry.point.y).toBeCloseTo(3, 7);
        expect(geometry.point.length()).toBeCloseTo(5, 7);
    });

    test("nearby skew curves are not reported as intersecting", () => {
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 5).unchecked()!;
        const line = factory.line(xyz(-10, 3, 0.0005), xyz(10, 3, 0.0005)).unchecked()!;
        const first: ConstructionRef = { kind: "shape", nodeId: "circle", shapeType: "edge", index: 0 };
        const second: ConstructionRef = { kind: "shape", nodeId: "line", shapeType: "edge", index: 0 };
        const resolver: IConstructionResolver = {
            resolve(ref) {
                const edge = ref.kind === "shape" && ref.nodeId === "circle" ? circle : line;
                return Result.ok({
                    kind: "edge",
                    start: edge.startPoint(),
                    end: edge.endPoint(),
                    curve: edge.curve,
                });
            },
        };
        expect(
            evaluateConstruction({ kind: "point-two-edges", first, second, solution: 0 }, resolver).isOk,
        ).toBe(false);
    });

    test("arbitrary arc-length positions meet modeling tolerance", () => {
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 10).unchecked()!;
        const distance = 17.234567;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "distance", value: distance } },
            { kind: "curve", curve: circle.curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected path point");
        const expected = xyz(10 * Math.cos(distance / 10), 10 * Math.sin(distance / 10));
        expect(geometry.point.distanceTo(expected)).toBeLessThan(1e-6);
    });

    test("To Object at a circle center has no unique closest projection", () => {
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 10).unchecked()!;
        const result = evaluate(
            {
                kind: "point-along-path",
                path: sourceRef,
                position: { kind: "to-point", point: point(XYZ.zero) },
            },
            { kind: "curve", curve: circle.curve },
        );
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/ambiguous|multiple|unique|infinitely/i);
    });

    test("circle and line intersections require and preserve an explicit solution", () => {
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 5).unchecked()!;
        const line = factory.line(xyz(-10), xyz(10)).unchecked()!;
        const first: ConstructionRef = { kind: "shape", nodeId: "circle", shapeType: "edge", index: 0 };
        const second: ConstructionRef = { kind: "shape", nodeId: "line", shapeType: "edge", index: 0 };
        const resolver: IConstructionResolver = {
            resolve(ref) {
                const edge = ref.kind === "shape" && ref.nodeId === "circle" ? circle : line;
                return Result.ok({
                    kind: "edge",
                    start: edge.startPoint(),
                    end: edge.endPoint(),
                    curve: edge.curve,
                });
            },
        };
        const ambiguous = evaluateConstruction({ kind: "point-two-edges", first, second }, resolver);
        expect(ambiguous.isOk).toBe(false);
        const points = [0, 1]
            .map((solution) => {
                const result = evaluateConstruction(
                    { kind: "point-two-edges", first, second, solution },
                    resolver,
                );
                expect(result.isOk).toBe(true);
                const geometry = result.unchecked()!;
                expect(geometry.kind).toBe("point");
                if (geometry.kind !== "point") throw new Error("Expected intersection point");
                expect(geometry.point.y).toBeCloseTo(0);
                expect(geometry.point.z).toBeCloseTo(0);
                return geometry.point.x;
            })
            .sort((a, b) => a - b);
        expect(points[0]).toBeCloseTo(-5);
        expect(points[1]).toBeCloseTo(5);
    });

    test("disconnected path segments cannot masquerade as one connected chain", () => {
        const first = factory.line(XYZ.zero, xyz(10)).unchecked()!;
        const second = factory.line(xyz(20), xyz(30)).unchecked()!;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "distance", value: 15 } },
            { kind: "path", segments: [{ curve: first.curve }, { curve: second.curve }] },
        );
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/connect|gap|path/i);
    });

    test("a connected chain measures the sum of its segment lengths", () => {
        const first = factory.line(XYZ.zero, xyz(10)).unchecked()!;
        const second = factory.line(xyz(10), xyz(10, 20)).unchecked()!;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "distance", value: 15 } },
            { kind: "path", segments: [{ curve: first.curve }, { curve: second.curve }] },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected chain point");
        expect(geometry.point.distanceTo(xyz(10, 5))).toBeLessThan(1e-6);
    });

    test("a path plane at a sharp corner requires an explicit tangent branch", () => {
        const first = factory.line(XYZ.zero, xyz(10)).unchecked()!;
        const second = factory.line(xyz(10), xyz(10, 20)).unchecked()!;
        const result = evaluate(
            { kind: "plane-along-path", path: sourceRef, position: { kind: "distance", value: 10 } },
            { kind: "path", segments: [{ curve: first.curve }, { curve: second.curve }] },
        );
        expect(result.isOk).toBe(false);
        expect(String(result.error)).toMatch(/corner|branch|tangent/i);
    });

    test("cylinder tangent uses the selected contact instead of fixed surface parameters", () => {
        const face = cylinderFace();
        const result = evaluate(
            { kind: "plane-tangent", face: sourceRef, contact: point(xyz(0, 5, 3)) },
            { kind: "face", face },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("plane");
        if (geometry.kind !== "plane") throw new Error("Expected tangent plane");
        expect(geometry.plane.origin.distanceTo(xyz(0, 5, 3))).toBeLessThan(1e-7);
        expect(geometry.plane.normal.dot(XYZ.unitY)).toBeCloseTo(1, 6);
    });

    test("off-face contact is rejected before evaluating a normal", () => {
        const result = evaluate(
            { kind: "plane-tangent", face: sourceRef, contact: point(xyz(0, 5, 30)) },
            { kind: "face", face: cylinderFace() },
        );
        expect(result.isOk).toBe(false);
        expect(String(result.error).length).toBeGreaterThan(0);
    });

    test("translated cylinder symmetry axis stays in world coordinates", () => {
        const face = cylinderFace().transformedMul(Matrix4.fromTranslation(7, 11, 13)) as IFace;
        const result = evaluate({ kind: "axis-analytic", face: sourceRef }, { kind: "face", face });
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("axis");
        if (geometry.kind !== "axis") throw new Error("Expected symmetry axis");
        expect(geometry.origin.x).toBeCloseTo(7);
        expect(geometry.origin.y).toBeCloseTo(11);
        expect(Math.abs(geometry.direction.dot(XYZ.unitZ))).toBeCloseTo(1);
    });

    test("cone apex contact returns an error without aborting the kernel", () => {
        const solid = factory.cone(XYZ.unitZ, XYZ.zero, 5, 0, 10);
        expect(solid.isOk).toBe(true);
        const face = (solid.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (candidate) => !candidate.surface().isPlanar(),
        );
        expect(face).not.toBeUndefined();
        const result = evaluate(
            { kind: "plane-tangent", face: sourceRef, contact: point(xyz(0, 0, 10)) },
            { kind: "face", face: face! },
        );
        expect(result.isOk).toBe(false);
        // A subsequent independent operation demonstrates the WASM module survived.
        expect(factory.line(XYZ.zero, XYZ.unitX).isOk).toBe(true);
    });

    test("sphere center follows its analytic location", () => {
        const sphere = factory.sphere(xyz(3, 7, 11), 5);
        expect(sphere.isOk).toBe(true);
        const face = sphere.unchecked()!.findSubShapes(ShapeTypes.face)[0] as IFace;
        const result = evaluate({ kind: "point-center", source: sourceRef }, { kind: "face", face });
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected center point");
        expect(geometry.point.distanceTo(xyz(3, 7, 11))).toBeLessThan(1e-7);
    });

    test("curved paths use geometric arc length and normals follow the tangent", () => {
        const circle = factory.circle(XYZ.unitZ, XYZ.zero, 10);
        expect(circle.isOk).toBe(true);
        const curve = circle.unchecked()!.curve;
        const result = evaluate(
            { kind: "plane-along-path", path: sourceRef, position: { kind: "distance", value: 5 * Math.PI } },
            { kind: "curve", curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("plane");
        if (geometry.kind !== "plane") throw new Error("Expected path plane");
        expect(geometry.plane.origin.distanceTo(xyz(0, 10, 0))).toBeLessThan(1e-4);
        expect(geometry.plane.normal.dot(XYZ.unitNX)).toBeCloseTo(1, 5);
    });

    test("nonuniform bezier parameters do not masquerade as geometric distances", () => {
        const edge = factory.bezier([xyz(0), xyz(0.1), xyz(10)]);
        expect(edge.isOk).toBe(true);
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "distance", value: 2 } },
            { kind: "curve", curve: edge.unchecked()!.curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected path point");
        expect(geometry.point.x).toBeCloseTo(2, 5);
    });

    test("closed normalized endpoint returns the source seam", () => {
        const circle = factory.circle(XYZ.unitZ, xyz(2, 3, 4), 10).unchecked()!;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "normalized", value: 1 } },
            { kind: "curve", curve: circle.curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected seam point");
        expect(geometry.point.distanceTo(circle.startPoint())).toBeLessThan(1e-7);
    });

    test("curved extensions are explicitly rejected", () => {
        const arc = factory.arc(XYZ.unitZ, XYZ.zero, xyz(5), 90).unchecked()!;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "normalized", value: 1.5 } },
            { kind: "curve", curve: arc.curve },
        );
        expect(result.isOk).toBe(false);
        expect(String(result.error).length).toBeGreaterThan(0);
    });

    test("a nonlinear edge cannot silently become a straight construction axis", () => {
        const arc = factory.arc(XYZ.unitZ, XYZ.zero, xyz(5), 90).unchecked()!;
        const result = evaluate(
            { kind: "axis-edge", edge: sourceRef },
            { kind: "edge", start: arc.startPoint(), end: arc.endPoint(), curve: arc.curve },
        );
        expect(result.isOk).toBe(false);
    });

    test("a trimmed circle still exposes its analytic center", () => {
        const arc = factory.arc(XYZ.unitZ, xyz(2, 3), xyz(7, 3), 90).unchecked()!;
        const result = evaluate(
            { kind: "point-center", source: sourceRef },
            { kind: "curve", curve: arc.curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected center");
        expect(geometry.point.distanceTo(xyz(2, 3))).toBeLessThan(1e-7);
    });

    test("a trimmed straight edge can extend beyond its finite end", () => {
        const edge = factory.line(xyz(1, 2, 3), xyz(11, 2, 3)).unchecked()!;
        const result = evaluate(
            { kind: "point-along-path", path: sourceRef, position: { kind: "distance", value: 30 } },
            { kind: "curve", curve: edge.curve },
        );
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected extension point");
        expect(geometry.point.distanceTo(xyz(31, 2, 3))).toBeLessThan(1e-7);
    });

    test("reversing a path preserves a To Object projected position", () => {
        const edge = factory.line(XYZ.zero, xyz(10)).unchecked()!;
        const definition: ConstructionDefinition = {
            kind: "point-along-path",
            path: sourceRef,
            position: { kind: "to-point", point: point(xyz(2, 1)) },
        };
        const result = evaluate(definition, {
            kind: "path",
            segments: [{ curve: edge.curve }],
            reversed: true,
        });
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected projection point");
        expect(geometry.point.distanceTo(xyz(2))).toBeLessThan(1e-7);
    });

    test("a sphere does not have a unique cylinder/cone/torus symmetry axis", () => {
        const sphere = factory.sphere(XYZ.zero, 5).unchecked()!;
        const face = sphere.findSubShapes(ShapeTypes.face)[0] as IFace;
        const result = evaluate({ kind: "axis-analytic", face: sourceRef }, { kind: "face", face });
        expect(result.isOk).toBe(false);
    });

    test("a cylinder does not have a unique sphere/torus center", () => {
        const result = evaluate(
            { kind: "point-center", source: sourceRef },
            { kind: "face", face: cylinderFace() },
        );
        expect(result.isOk).toBe(false);
    });
});
