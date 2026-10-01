// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IEdge, Precision, XYZ } from "@spicy3d/core";
import { OccShape } from "@spicy3d/wasm/src/shape";
import { createTestFactory, unwrapOk } from "@spicy3d/wasm/test/helpers";
import "@spicy3d/wasm/test/setup";
import { needsKernelSplit } from "../src/features/profileGeometry";

afterEach(() => {
    rs.restoreAllMocks();
});

function line(x1: number, y1: number, x2: number, y2: number): IEdge {
    return unwrapOk(createTestFactory().line(new XYZ(x1, y1, 0), new XYZ(x2, y2, 0)));
}

test("shared endpoint intersection roundoff stays a vertex contact, while a nearby crossing splits", () => {
    const offset = Precision.Distance * 2;
    const first = line(-10, 0, 0, 0);
    const adjacent = line(0, 0, 0, 10);
    const crossing = line(-offset, -5, -offset, 5);
    try {
        rs.spyOn(first, "intersect").mockReturnValue([{ parameter: 1, point: new XYZ(offset, 0, 0) }]);
        expect(needsKernelSplit([first, adjacent])).toBe(false);
        rs.restoreAllMocks();
        expect(needsKernelSplit([first, crossing])).toBe(true);
    } finally {
        first.dispose();
        adjacent.dispose();
        crossing.dispose();
    }
});

test("an 81-edge loop queries bounds once per edge and never requests a render mesh", () => {
    const vertices = Array.from({ length: 81 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / 81;
        return new XYZ(100 * Math.cos(angle), 100 * Math.sin(angle), 0);
    });
    const factory = createTestFactory();
    const edges = vertices.map((p, i) => unwrapOk(factory.line(p, vertices[(i + 1) % vertices.length])));
    const bounds = edges.map((edge) => rs.spyOn(edge, "geometryBoundingBox"));
    const mesh = rs.spyOn(OccShape.prototype, "mesh", "get");
    const renderBounds = rs.spyOn(OccShape.prototype, "boundingBox");
    try {
        expect(needsKernelSplit(edges)).toBe(false);
        for (const query of bounds) expect(query).toHaveBeenCalledTimes(1);
        expect(mesh).not.toHaveBeenCalled();
        expect(renderBounds).not.toHaveBeenCalled();
        for (const edge of edges) expect(Reflect.get(edge, "_mesh")).toBeUndefined();
    } finally {
        for (const edge of edges) edge.dispose();
    }
});

test.each([
    { name: "disjoint", ends: [20, 0, 30, 0], split: false },
    { name: "shared vertex", ends: [10, 0, 10, 10], split: false },
    { name: "crossing", ends: [5, -5, 5, 5], split: true },
    { name: "T-junction", ends: [5, 0, 5, 5], split: true },
    { name: "collinear overlap", ends: [5, 0, 15, 0], split: true },
])("$name preserves the split decision without meshing", ({ ends, split }) => {
    const edges = [line(0, 0, 10, 0), line(ends[0], ends[1], ends[2], ends[3])];
    const mesh = rs.spyOn(OccShape.prototype, "mesh", "get");
    try {
        expect(needsKernelSplit(edges)).toBe(split);
        expect(mesh).not.toHaveBeenCalled();
        for (const edge of edges) expect(Reflect.get(edge, "_mesh")).toBeUndefined();
    } finally {
        for (const edge of edges) edge.dispose();
    }
});

test("crossing curved edges are detected without meshing", () => {
    const factory = createTestFactory();
    const edges = [
        unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 10)),
        unwrapOk(factory.circle(XYZ.unitZ, new XYZ(10, 0, 0), 10)),
    ];
    const mesh = rs.spyOn(OccShape.prototype, "mesh", "get");
    try {
        expect(needsKernelSplit(edges)).toBe(true);
        expect(mesh).not.toHaveBeenCalled();
        for (const edge of edges) expect(Reflect.get(edge, "_mesh")).toBeUndefined();
    } finally {
        for (const edge of edges) edge.dispose();
    }
});
