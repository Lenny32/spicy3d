// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { EditableShapeNode, type IndexedMesh, type IShape, Plane, Result, XYZ } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../../builder/src/defaultDataExchange";
import { weldMeshes } from "../src/indexedMesh";
import { createTestConverter, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const converter = createTestConverter();

/** Each undirected edge must be shared by exactly two triangles, once in each direction. */
function openOrInconsistentEdges(mesh: IndexedMesh): number {
    const directed = new Map<string, number>();
    const { triangles } = mesh;
    for (let t = 0; t < triangles.length; t += 3) {
        for (let k = 0; k < 3; k++) {
            const key = `${triangles[t + k]},${triangles[t + ((k + 1) % 3)]}`;
            directed.set(key, (directed.get(key) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const [key, count] of directed) {
        const [a, b] = key.split(",");
        if (count !== 1 || directed.get(`${b},${a}`) !== 1) bad++;
    }
    return bad;
}

/** Signed volume (divergence theorem): positive when the triangles wind counter-clockwise outside. */
function signedVolume({ vertices: v, triangles }: IndexedMesh): number {
    let volume = 0;
    for (let t = 0; t < triangles.length; t += 3) {
        const [a, b, c] = [triangles[t] * 3, triangles[t + 1] * 3, triangles[t + 2] * 3];
        volume +=
            v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
            v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
            v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
    }
    return volume / 6;
}

function collapsedTriangles({ triangles }: IndexedMesh): number {
    let count = 0;
    for (let t = 0; t < triangles.length; t += 3) {
        const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
        if (a === b || b === c || a === c) count++;
    }
    return count;
}

describe("weldMeshes", () => {
    test("merges the vertices two faces share and keeps each triangle's winding", () => {
        const mesh = weldMeshes([
            { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], index: [0, 1, 2] },
            { position: [1, 0, 0, 1, 1, 0, 0, 1, 0], index: [0, 1, 2] },
        ]);

        expect(Array.from(mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        expect(Array.from(mesh.triangles)).toEqual([0, 1, 2, 1, 3, 2]);
    });

    test("merges points within the tolerance and keeps distinct ones apart", () => {
        const mesh = weldMeshes([
            { position: [0, 0, 0, 10, 0, 0, 0, 10, 0], index: [0, 1, 2] },
            { position: [10 + 1e-9, 0, 0, 10, 10, 0, 0, 10 - 1e-9, 0], index: [0, 1, 2] },
            { position: [10, 0.01, 0, 20, 0, 0, 20, 10, 0], index: [0, 1, 2] },
        ]);

        expect(mesh.vertices.length / 3).toBe(7);
        expect(Array.from(mesh.triangles.slice(3, 6))).toEqual([1, 3, 2]);
    });

    test("drops triangles collapsed by welding and the vertices only they used", () => {
        const mesh = weldMeshes([
            {
                position: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 5, 5, 5],
                index: [0, 1, 2, 0, 3, 4],
            },
        ]);

        expect(Array.from(mesh.triangles)).toEqual([0, 1, 2]);
        expect(mesh.vertices.length).toBe(9);
    });

    test("returns an empty mesh for no faces", () => {
        const mesh = weldMeshes([]);

        expect(mesh.vertices.length).toBe(0);
        expect(mesh.triangles.length).toBe(0);
    });
});

describe("convertToIndexedMesh", () => {
    const solids: { name: string; make: () => IShape; volume: number; tolerance: number }[] = [
        {
            name: "box",
            make: () => unwrapOk(factory.box(Plane.XY, 20, 30, 40)),
            volume: 24000,
            tolerance: 1e-6,
        },
        {
            name: "cylinder",
            make: () => unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20)),
            volume: Math.PI * 100 * 20,
            tolerance: 0.02,
        },
        {
            name: "sphere",
            make: () => unwrapOk(factory.sphere(XYZ.zero, 10)),
            volume: (4 / 3) * Math.PI * 1000,
            tolerance: 0.03,
        },
    ];

    test.each(solids)("meshes a $name closed, consistently wound and outward", ({
        make,
        volume,
        tolerance,
    }) => {
        const shape = make();
        try {
            const mesh = unwrapOk(converter.convertToIndexedMesh(shape));

            expect(mesh.triangles.length).toBeGreaterThan(0);
            expect(openOrInconsistentEdges(mesh)).toBe(0);
            expect(collapsedTriangles(mesh)).toBe(0);
            // Outward normals give a positive volume close to the BREP one (facets cut chords).
            const meshVolume = signedVolume(mesh);
            expect(meshVolume).toBeGreaterThan(0);
            expect(Math.abs(meshVolume - volume) / volume).toBeLessThan(tolerance);
            expect(Math.abs(meshVolume - shape.volume()) / volume).toBeLessThan(tolerance);
        } finally {
            shape.dispose();
        }
    });

    test("custom tolerances change the triangle count and stay closed", () => {
        const shape = unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20));
        try {
            const coarse = unwrapOk(
                converter.convertToIndexedMesh(shape, { linearTolerance: 1, angularTolerance: 60 }),
            );
            const fine = unwrapOk(
                converter.convertToIndexedMesh(shape, { linearTolerance: 0.01, angularTolerance: 5 }),
            );

            expect(fine.triangles.length).toBeGreaterThan(coarse.triangles.length);
            expect(openOrInconsistentEdges(coarse)).toBe(0);
            expect(openOrInconsistentEdges(fine)).toBe(0);
        } finally {
            shape.dispose();
        }
    });

    test("refuses invalid tolerances", () => {
        const shape = unwrapOk(factory.box(Plane.XY, 1, 1, 1));
        try {
            const result = converter.convertToIndexedMesh(shape, { angularTolerance: 0 });

            expect(result.isOk).toBe(false);
            expect(result.error).toContain("angularTolerance");
        } finally {
            shape.dispose();
        }
    });
});

describe("3MF export through the kernel", () => {
    async function exportedVertices(node: EditableShapeNode, lengthUnit: "mm" | "cm" | "in") {
        const data = await new DefaultDataExchange().export(".3mf", [node], { lengthUnit });
        expect(data).toHaveLength(1);
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(data![0] as Uint8Array);
        const xml = await zip.file("3D/3dmodel.model")!.async("string");
        const model = new DOMParser().parseFromString(xml, "application/xml");
        const xs = Array.from(model.getElementsByTagName("vertex")).map((vertex) =>
            Number(vertex.getAttribute("x")),
        );
        return { unit: model.documentElement.getAttribute("unit"), size: Math.max(...xs) - Math.min(...xs) };
    }

    test.each([
        { lengthUnit: "mm", unit: "millimeter", size: 20 },
        { lengthUnit: "cm", unit: "centimeter", size: 2 },
        { lengthUnit: "in", unit: "inch", size: 20 / 25.4 },
    ] as const)("a 20 mm cube is 20 mm in $lengthUnit: unit $unit, size $size", async ({
        lengthUnit,
        unit,
        size,
    }) => {
        const document = createMockDocument();
        const shape = unwrapOk(factory.box(Plane.XY, 20, 20, 20));
        const node = new EditableShapeNode({ document, name: "cube", shape: Result.ok(shape) });
        try {
            rs.stubGlobal("shapeConverter", converter);
            const exported = await exportedVertices(node, lengthUnit);

            expect(exported.unit).toBe(unit);
            expect(exported.size).toBeCloseTo(size, 6);
        } finally {
            rs.unstubAllGlobals();
            node.dispose();
        }
    });
});
