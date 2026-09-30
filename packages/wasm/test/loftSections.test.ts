// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IShape, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import type { ShapeFactory } from "../src/factory";
import { groupEdgeChains } from "../src/loftSections";
import type { OccSolid } from "../src/shape";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

let factory: ShapeFactory;

beforeEach(() => {
    factory = createTestFactory();
});

const at = (x: number, y: number, z: number) => new XYZ({ x, y, z });

/** Loose line edges through `points`, one per consecutive pair — like a sketch's entities. */
function lines(points: XYZ[]): IEdge[] {
    const edges: IEdge[] = [];
    for (let i = 0; i + 1 < points.length; i++) edges.push(unwrapOk(factory.line(points[i], points[i + 1])));
    return edges;
}

function square(size: number, z: number, x0 = 0): IEdge[] {
    return lines([at(x0, 0, z), at(x0 + size, 0, z), at(x0 + size, size, z), at(x0, size, z), at(x0, 0, z)]);
}

/** A sketch-like section: a compound of loose edges, in a scrambled order. */
function compoundOf(edges: IEdge[]): IShape {
    const scrambled = [...edges.slice(1), edges[0]].reverse();
    return unwrapOk(factory.combine(scrambled));
}

describe("groupEdgeChains", () => {
    test("groups touching edges regardless of order and keeps separate chains apart", () => {
        const a = square(10, 0);
        const b = square(4, 0, 20);
        const chains = groupEdgeChains([a[2], b[0], a[0], b[3], a[3], b[1], a[1], b[2]]);
        expect(chains.map((chain) => chain.length)).toEqual([4, 4]);
        expect(chains[0].every((edge) => a.includes(edge))).toBe(true);
        expect(chains[1].every((edge) => b.includes(edge))).toBe(true);
    });
});

describe("loft sections", () => {
    test("lofts two compounds of loose edges forming closed chains into a solid", () => {
        const result = factory.loft(
            [compoundOf(square(10, 0)), compoundOf(square(10, 20))],
            true,
            true,
            "c0",
        );
        expect(result.isOk).toBe(true);
        expect(result.value.shapeType).toBe(ShapeTypes.solid);
        expect((result.value as OccSolid).volume()).toBeCloseTo(2000, 3);
    });

    test("lofts two compounds forming OPEN chains into an open skin", () => {
        const bottom = compoundOf(lines([at(0, 0, 0), at(10, 0, 0), at(10, 10, 0)]));
        const top = compoundOf(lines([at(0, 0, 20), at(10, 0, 20), at(10, 10, 20)]));
        const result = factory.loft([bottom, top], false, true, "c0");
        expect(result.isOk).toBe(true);
        const faces = result.value.findSubShapes(ShapeTypes.face);
        expect(faces.length).toBe(2);
        expect(result.value.findSubShapes(ShapeTypes.solid).length).toBe(0);
    });

    test("refuses a compound section with several separate edge chains, naming it", () => {
        const twoLoops = unwrapOk(factory.combine([...square(10, 20), ...square(2, 20, 20)]));
        const result = factory.loft([compoundOf(square(10, 0)), twoLoops], true, false, "c0");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("Section 1 has 2 separate edge chains; pick one with findSubShapes + wire");
    });

    const branching =
        "Section 1 has a branching vertex (three or more edges meet at one point); pick one chain with findSubShapes + wire";

    test("refuses a figure-eight section (two loops sharing a vertex)", () => {
        const eight = [
            ...lines([at(0, 0, 20), at(10, 0, 20), at(5, 5, 20), at(0, 0, 20)]),
            ...lines([at(0, 0, 20), at(-10, 0, 20), at(-5, -5, 20), at(0, 0, 20)]),
        ];
        const result = factory.loft([compoundOf(square(10, 0)), compoundOf(eight)], false, true, "c0");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe(branching);
    });

    test("refuses a T-junction section", () => {
        const tee = [
            ...lines([at(0, 0, 20), at(5, 0, 20), at(10, 0, 20)]),
            ...lines([at(5, 0, 20), at(5, 5, 20)]),
        ];
        const result = factory.loft([compoundOf(square(10, 0)), compoundOf(tee)], false, true, "c0");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe(branching);
    });

    test("refuses a shell section with its index and type", () => {
        const box = unwrapOk(factory.box(Plane.XY, 5, 5, 5));
        const shell = box.findSubShapes(ShapeTypes.shell)[0];
        expect(shell.shapeType).toBe(ShapeTypes.shell);
        const result = factory.loft([compoundOf(square(10, 20)), shell], true, false, "c0");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe(
            "Section 1 is a Shell; a loft section must be a vertex, edge, wire, face or compound of edges",
        );
    });

    test("lofts from a face section's outer wire", () => {
        const face = unwrapOk(factory.rect(Plane.XY, 10, 10));
        const top = compoundOf(square(10, 20));
        const result = factory.loft([face, top], true, true, "c0");
        expect(result.isOk).toBe(true);
        expect((result.value as OccSolid).volume()).toBeCloseTo(2000, 3);
    });

    test("refuses a solid section with its index and type", () => {
        const box = unwrapOk(factory.box(Plane.XY, 5, 5, 5));
        const result = factory.loft([compoundOf(square(10, 20)), box], true, false, "c0");
        expect(result.isOk).toBe(false);
        expect(result.error).toBe(
            "Section 1 is a Solid; a loft section must be a vertex, edge, wire, face or compound of edges",
        );
    });

    test("does not replace the caller's edge sections", () => {
        const e1 = unwrapOk(factory.circle(XYZ.unitZ, XYZ.zero, 5));
        const e2 = unwrapOk(factory.circle(XYZ.unitZ, at(0, 0, 20), 8));
        const sections: IShape[] = [e1, e2];
        expect(factory.loft(sections, true, false, "c0").isOk).toBe(true);
        expect(sections[0]).toBe(e1);
        expect(sections[1]).toBe(e2);
    });
});
