// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { EditableShapeNode, type ISolid, Result, XYZ } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../../builder/src/defaultDataExchange";
import type { TopoDS_Shape } from "../lib/spicy-wasm";
import { createTestConverter, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const converter = createTestConverter();

test.each([
    { linearTolerance: 0 },
    { linearTolerance: -1 },
    { linearTolerance: Number.NaN },
    { angularTolerance: 0 },
    { angularTolerance: 181 },
    { angularTolerance: Number.POSITIVE_INFINITY },
])("direct converter refuses invalid %j before reading shapes", (options) => {
    const result = converter.convertToSTL([], options);
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("Tolerance must be a finite number");
});

function facetDeviation(bytes: Uint8Array, sphere: boolean, expectedRadius = 10): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let maximum = 0;
    for (let i = 0; i < view.getUint32(80, true); i++) {
        const offset = 84 + 50 * i;
        // Skip cylinder caps. Its axis is Z; side facet normals have zero Z.
        if (!sphere && Math.abs(view.getFloat32(offset + 8, true)) > 0.5) continue;
        const centroid = [0, 0, 0];
        for (let v = 0; v < 3; v++) {
            for (let axis = 0; axis < 3; axis++)
                centroid[axis] += view.getFloat32(offset + 12 + 12 * v + 4 * axis, true) / 3;
        }
        const radius = sphere ? Math.hypot(...centroid) : Math.hypot(centroid[0], centroid[1]);
        maximum = Math.max(maximum, expectedRadius - radius);
    }
    return maximum;
}

test.each([
    "sphere",
    "cylinder",
])("tighter tolerances improve %s facets and increase size without altering CAD/display", (kind) => {
    const shape: ISolid = unwrapOk(
        kind === "sphere" ? factory.sphere(XYZ.zero, 10) : factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20),
    );
    try {
        const display = shape.mesh.faces;
        expect(display).not.toBeUndefined();
        if (!display) throw new Error("Missing display mesh");
        const positions = display.position.slice();
        const indices = display.index.slice();
        const volume = shape.volume();
        // The existing BREP writer includes native triangulations, beyond the cached JS mesh.
        const brepWithTriangulation = unwrapOk(converter.convertToBrep(shape));
        const defaultBytes = unwrapOk(converter.convertToSTL([shape]));
        const coarse = unwrapOk(
            converter.convertToSTL([shape], { linearTolerance: 1, angularTolerance: 60 }),
        );
        const fine = unwrapOk(
            converter.convertToSTL([shape], { linearTolerance: 0.02, angularTolerance: 5 }),
        );
        const linearFine = unwrapOk(
            converter.convertToSTL([shape], { linearTolerance: 0.02, angularTolerance: 60 }),
        );
        const angularFine = unwrapOk(
            converter.convertToSTL([shape], { linearTolerance: 1, angularTolerance: 5 }),
        );
        expect(fine.byteLength).toBeGreaterThan(coarse.byteLength);
        expect(linearFine.byteLength).toBeGreaterThan(coarse.byteLength);
        expect(angularFine.byteLength).toBeGreaterThan(coarse.byteLength);
        expect(facetDeviation(coarse, kind === "sphere")).toBeGreaterThan(0.01);
        expect(facetDeviation(linearFine, kind === "sphere")).toBeLessThan(
            facetDeviation(coarse, kind === "sphere"),
        );
        expect(facetDeviation(angularFine, kind === "sphere")).toBeLessThan(
            facetDeviation(coarse, kind === "sphere"),
        );
        expect(facetDeviation(fine, kind === "sphere")).toBeLessThan(
            facetDeviation(coarse, kind === "sphere") / 4,
        );
        expect(shape.volume()).toBeCloseTo(volume, 10);
        expect(unwrapOk(converter.convertToBrep(shape))).toBe(brepWithTriangulation);
        expect(shape.mesh.faces).toBe(display);
        expect(display.position).toEqual(positions);
        expect(display.index).toEqual(indices);
        expect(unwrapOk(converter.convertToSTL([shape]))).toEqual(defaultBytes);
        // Fresh export mesh must also be able to coarsen after a fine export.
        expect(
            unwrapOk(converter.convertToSTL([shape], { linearTolerance: 1, angularTolerance: 60 })),
        ).toEqual(coarse);
    } finally {
        shape.dispose();
    }
});

test("old kernel keeps default export but refuses requested tolerances explicitly", () => {
    const shape = unwrapOk(factory.sphere(XYZ.zero, 10));
    const original = wasm;
    try {
        const expected = unwrapOk(converter.convertToSTL([shape]));
        rs.stubGlobal("wasm", { ...original, Mesher: {} });
        expect(unwrapOk(converter.convertToSTL([shape]))).toEqual(expected);
        const result = converter.convertToSTL([shape], { linearTolerance: 0.1 });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("not available in this kernel build");
    } finally {
        rs.unstubAllGlobals();
        shape.dispose();
    }
});

test("actual STL export converts coordinates and tolerance together without changing physical fidelity", async () => {
    const shape = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
    const document = createMockDocument();
    const node = new EditableShapeNode({ document, name: "cylinder", shape: Result.ok(shape) });
    try {
        rs.stubGlobal("shapeConverter", converter);
        const exchange = new DefaultDataExchange();
        const mm = await exchange.export(".stl binary", [node], {
            lengthUnit: "mm",
            stl: { linearTolerance: 0.1, angularTolerance: 30 },
        });
        const cm = await exchange.export(".stl binary", [node], {
            lengthUnit: "cm",
            stl: { linearTolerance: 0.1, angularTolerance: 30 },
        });
        expect(mm).not.toBeUndefined();
        expect(cm).not.toBeUndefined();
        if (!mm || !cm) throw new Error("STL export missing");
        const mmBytes = new Uint8Array(await new Blob(mm).arrayBuffer());
        const cmBytes = new Uint8Array(await new Blob(cm).arrayBuffer());
        const mmView = new DataView(mmBytes.buffer);
        const cmView = new DataView(cmBytes.buffer);
        const triangles = mmView.getUint32(80, true);
        expect(triangles).toBeGreaterThan(0);
        expect(cmView.getUint32(80, true)).toBe(triangles);
        // OCCT can order facets differently after scaling; compare physical geometry, not buffer order.
        expect(facetDeviation(cmBytes, false, 1) * 10).toBeCloseTo(facetDeviation(mmBytes, false), 5);
        let maxRadius = 0;
        let maxHeight = 0;
        for (let triangle = 0; triangle < triangles; triangle++) {
            for (let vertex = 0; vertex < 3; vertex++) {
                const offset = 84 + 50 * triangle + 12 + 12 * vertex;
                maxRadius = Math.max(
                    maxRadius,
                    Math.hypot(cmView.getFloat32(offset, true), cmView.getFloat32(offset + 4, true)),
                );
                maxHeight = Math.max(maxHeight, cmView.getFloat32(offset + 8, true));
            }
        }
        expect(maxRadius * 10).toBeCloseTo(10, 5);
        expect(maxHeight * 10).toBeCloseTo(20, 5);
        expect(shape.volume()).toBeCloseTo(Math.PI * 10 ** 2 * 20, 6);
    } finally {
        rs.unstubAllGlobals();
        node.dispose();
    }
});

test.each([
    { options: { linearTolerance: 0.3 }, expected: [0.3, 0.2, false] },
    { options: { angularTolerance: 30 }, expected: [0.005, Math.PI / 6, true] },
])("a single requested tolerance retains the other legacy default: %j", ({ options, expected }) => {
    const shape = unwrapOk(factory.sphere(XYZ.zero, 10));
    const meshForExport = rs.fn(
        (_shape: TopoDS_Shape, _linear: number, _angular: number, _relative: boolean) => ({
            position: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            index: [0, 1, 2],
        }),
    );
    try {
        rs.stubGlobal("wasm", { ...wasm, Mesher: { meshForExport } });
        const bytes = unwrapOk(converter.convertToSTL([shape], options));
        expect(bytes.byteLength).toBe(134);
        expect(meshForExport).toHaveBeenCalledTimes(1);
        const call = meshForExport.mock.calls[0];
        expect(call[1]).toBeCloseTo(expected[0] as number, 12);
        expect(call[2]).toBeCloseTo(expected[1] as number, 12);
        expect(call[3]).toBe(expected[2]);
    } finally {
        rs.unstubAllGlobals();
        shape.dispose();
    }
});
