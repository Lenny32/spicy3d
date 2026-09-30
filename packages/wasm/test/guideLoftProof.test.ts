// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDisposable,
    type IEdge,
    type IShape,
    type IWire,
    Matrix4,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { OccShapeConverter } from "../src/converter";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const owned: IDisposable[] = [];
const keep = <T extends IDisposable>(value: T): T => {
    owned.push(value);
    return value;
};
afterEach(() => {
    for (const value of owned.splice(0).reverse()) value.dispose();
});

function section(z: number, right: number): IWire {
    const top = -3 + (6 * (right + 5)) / 10;
    return keep(
        unwrapOk(
            factory.polygon([
                { x: -5, y: -3, z },
                { x: right, y: -3, z },
                { x: right, y: top, z },
                { x: -5, y: top, z },
                { x: -5, y: -3, z },
            ]),
        ),
    );
}

function nativeProof(sections: IWire[], spine: IWire, guide: IWire) {
    return factory.loftGuidedTracked(sections, spine, guide, true);
}

function prove(sections: IWire[], spine: IWire, guide: IWire): IShape {
    const result = nativeProof(sections, spine, guide);
    expect(result.isOk, result.error).toBe(true);
    const shape = keep(result.value.shape);
    const checked = shape.checkSelfIntersection?.();
    expect(checked?.isOk).toBe(true);
    if (!checked) throw new Error("Self-interference check missing");
    expect(checked.value).toBe(true);
    return shape;
}

function helicalFixture(radius = Math.sqrt(34)) {
    const first = section(0, 5);
    const at = (height: number, angle: number) =>
        keep(
            first.transformedMul(
                Matrix4.fromTranslation(0, 0, height).multiply(
                    Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, angle),
                ),
            ) as IWire,
        );
    const second = at(20, Math.PI / 2);
    const axis = keep(unwrapOk(factory.line(XYZ.zero, new XYZ({ x: 0, y: 0, z: 20 }))));
    const spine = keep(unwrapOk(factory.wire([axis])));
    const helix = keep(unwrapOk(factory.helix(XYZ.zero, XYZ.unitZ, XYZ.unitX, radius, 80, 90)));
    const guide = keep(
        helix.transformedMul(Matrix4.fromAxisRad(XYZ.zero, XYZ.unitZ, Math.atan2(3, 5))) as IWire,
    );
    return { first, second, spine, guide, at };
}

test("NoContact controls a complete helical boundary between unchanged sections", () => {
    const { first, second, spine, guide } = helicalFixture();
    expect(first.geometryBoundingBox().min.z).toBeCloseTo(0, 6);
    expect(second.geometryBoundingBox().min.z).toBeCloseTo(20, 6);
    const edges = guide.findSubShapes(ShapeTypes.edge) as IEdge[];
    expect(edges).toHaveLength(1);
    expect(edges[0].startPoint().distanceTo(new XYZ({ x: 5, y: 3, z: 0 }))).toBeLessThan(1e-5);
    expect(edges[0].endPoint().distanceTo(new XYZ({ x: -3, y: 5, z: 20 }))).toBeLessThan(1e-5);
    const guided = prove([first, second], spine, guide);
    expect(guided.checkShape()).toBe(true);
    expect(guided.volume()).toBeGreaterThan(1000);
    const plain = keep(unwrapOk(factory.loft([first, second], true, false, "c2")));
    expect(Math.abs(guided.volume() - plain.volume())).toBeGreaterThan(1);
    // Complete side-boundary coverage is mandatory in nativeProof, not inferred from these samples.
    const distances = Array.from({ length: 33 }, (_, index) => {
        const edge = edges[0];
        const point = keep(
            unwrapOk(
                factory.point(
                    edge.pointAt(
                        edge.firstParameter() + ((edge.lastParameter() - edge.firstParameter()) * index) / 32,
                    ),
                ),
            ),
        );
        return point.extremaDistance(guided);
    });
    expect(Math.max(...distances)).toBeLessThan(1e-5);
});

test("NoContact preserves a genuinely authored intermediate section on the guided sides", () => {
    const { first, second, spine, guide, at } = helicalFixture();
    const middle = at(10, Math.PI / 4);
    const guided = prove([first, middle, second], spine, guide);
    expect(guided.checkShape()).toBe(true);
    expect(guided.volume()).toBeGreaterThan(1000);
});

test("NoContact rejects an interior guide despite section containment", () => {
    const { first, second, spine, guide } = helicalFixture(2);
    const native = nativeProof([first, second], spine, guide);
    expect(native.isOk).toBe(false);
    expect(native.error).toMatch(/boundary.*section|does not lie completely/);
});

test("NoContact rejects an intermediate section incompatible with the boundary guide", () => {
    const { first, second, spine, guide, at } = helicalFixture();
    const wrongMiddle = keep(at(10, Math.PI / 4).transformedMul(Matrix4.fromTranslation(1, 0, 0)) as IWire);
    const native = nativeProof([first, wrongMiddle, second], spine, guide);
    expect(native.isOk).toBe(false);
    expect(native.error).toMatch(/incompatible|boundary.*section|does not lie completely/);
});

test("NoContact resolves oppositely oriented paths without dropping full coverage", () => {
    const { first, second, spine, guide } = helicalFixture();
    const reversed = keep(guide.clone() as IWire);
    const reversedSpine = keep(spine.clone() as IWire);
    reversed.reserve();
    reversedSpine.reserve();
    const guided = prove([first, second], reversedSpine, reversed);
    expect(guided.checkShape()).toBe(true);
    expect(guided.volume()).toBeGreaterThan(1000);
});

test.each([true, false])("guided request accepted=%s preserves unprimed input BREP", (accepted) => {
    const { first, second, spine, guide } = helicalFixture(accepted ? Math.sqrt(34) : 2);
    const inputs = [first, second, spine, guide];
    const converter = new OccShapeConverter();
    const before = inputs.map((input) => unwrapOk(converter.convertToBrep(input)));
    const result = nativeProof([first, second], spine, guide);
    expect(result.isOk, result.error).toBe(accepted);
    if (result.isOk) keep(result.value.shape);
    expect(inputs.map((input) => unwrapOk(converter.convertToBrep(input)))).toEqual(before);
});

test.each([true, false])("guided request accepted=%s preserves existing display meshes", (accepted) => {
    const { first, second, spine, guide } = helicalFixture(accepted ? Math.sqrt(34) : 2);
    const inputs = [first, second, spine, guide];
    const meshes = inputs.map((input) => input.mesh);
    const snapshot = () =>
        inputs.map((input) => ({
            edgePosition: input.mesh.edges?.position.slice(),
            facePosition: input.mesh.faces?.position.slice(),
            faceNormal: input.mesh.faces?.normal.slice(),
            faceIndex: input.mesh.faces?.index.slice(),
        }));
    const snapshots = snapshot();
    const result = nativeProof([first, second], spine, guide);
    expect(result.isOk, result.error).toBe(accepted);
    if (result.isOk) keep(result.value.shape);
    expect(snapshot()).toEqual(snapshots);
    for (const [index, input] of inputs.entries()) expect(input.mesh).toBe(meshes[index]);
});

test("guided tracking maps actual original section topology and separate semantic caps", () => {
    const { first, second, spine, guide } = helicalFixture();
    const result = nativeProof([first, second], spine, guide);
    expect(result.isOk, result.error).toBe(true);
    const tracked = result.value;
    keep(tracked.shape);
    expect(tracked.faceMap).toHaveLength(tracked.shape.findSubShapes(ShapeTypes.face).length);
    expect(tracked.edgeMap).toHaveLength(tracked.shape.findSubShapes(ShapeTypes.edge).length);
    expect(tracked.pipeHistory?.startFaces).toHaveLength(1);
    expect(tracked.capFaces).toHaveLength(1);
    expect(tracked.pipeHistory?.startFaces).not.toEqual(tracked.capFaces);
    expect(tracked.pipeHistory?.faceEdges.length).toBeGreaterThanOrEqual(8);
    expect(tracked.pipeHistory?.edgeVertices.length).toBeGreaterThanOrEqual(8);
    expect(
        tracked.pipeHistory?.faceEdges
            .filter((_, index) => index % 2 === 1)
            .every((input) => input >= 0 && input < 10),
    ).toBe(true);
});

test.each([
    "overshoot",
    "closed",
    "multiple-plane-crossings",
])("guided loft rejects a %s main spine", (kind) => {
    const { first, second, guide } = helicalFixture();
    const points =
        kind === "overshoot"
            ? [
                  { x: 0, y: 0, z: -1 },
                  { x: 0, y: 0, z: 21 },
              ]
            : kind === "closed"
              ? [
                    { x: 0, y: 0, z: 0 },
                    { x: 0, y: 0, z: 20 },
                    { x: 1, y: 0, z: 10 },
                    { x: 0, y: 0, z: 0 },
                ]
              : [
                    { x: 0, y: 0, z: 0 },
                    { x: 0, y: 0, z: 10 },
                    { x: 1, y: 0, z: -1 },
                    { x: 1, y: 0, z: 20 },
                ];
    const spine = keep(unwrapOk(factory.polygon(points)));
    const result = nativeProof([first, second], spine, guide);
    expect(result.isOk).toBe(false);
    expect(result.error).toMatch(/open|exactly once|monotonic/);
});

test("guided loft rejects a nonplanar closed section", () => {
    const { second, spine, guide } = helicalFixture();
    const warped = keep(
        unwrapOk(
            factory.polygon([
                { x: -5, y: -3, z: 0 },
                { x: 5, y: -3, z: 0 },
                { x: 5, y: 3, z: 1 },
                { x: -5, y: 3, z: 0 },
                { x: -5, y: -3, z: 0 },
            ]),
        ),
    );
    const result = nativeProof([warped, second], spine, guide);
    expect(result.isOk).toBe(false);
    expect(result.error).toMatch(/planar/);
});
