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
import type { ShapeResult, TopoDS_Shape, TopoDS_Wire } from "../lib/spicy-wasm";
import { OccShape } from "../src/shape";
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

function nativeProof(sections: IWire[], spine: IWire, guide: IWire, guideMode = 0): ShapeResult {
    const native = (shape: IShape): TopoDS_Shape => {
        if (!(shape instanceof OccShape)) throw new Error("Expected native proof shape");
        return shape.shape;
    };
    const binding = wasm.ShapeFactory as unknown as {
        loftGuideProof(
            sections: TopoDS_Shape[],
            spine: TopoDS_Wire,
            guide: TopoDS_Wire,
            solid: boolean,
            guideMode: number,
        ): ShapeResult;
    };
    return binding.loftGuideProof(
        sections.map(native),
        native(spine) as TopoDS_Wire,
        native(guide) as TopoDS_Wire,
        true,
        guideMode,
    );
}

function prove(sections: IWire[], spine: IWire, guide: IWire, guideMode = 0): IShape {
    const result = nativeProof(sections, spine, guide, guideMode);
    expect(result.isOk, result.error).toBe(true);
    return keep(OccShape.wrap(result.shape));
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
    const guided = prove([first, middle, second], spine, guide, 0);
    expect(guided.checkShape()).toBe(true);
    expect(guided.volume()).toBeGreaterThan(1000);
});

test("NoContact rejects an interior guide despite section containment", () => {
    const { first, second, spine, guide } = helicalFixture(2);
    const native = nativeProof([first, second], spine, guide, 0);
    try {
        expect(native.isOk).toBe(false);
        expect(native.error).toMatch(/does not lie completely on the loft sides/);
    } finally {
        native.shape.delete();
    }
});

test("NoContact rejects an intermediate section incompatible with the boundary guide", () => {
    const { first, second, spine, guide, at } = helicalFixture();
    const wrongMiddle = keep(at(10, Math.PI / 4).transformedMul(Matrix4.fromTranslation(1, 0, 0)) as IWire);
    const native = nativeProof([first, wrongMiddle, second], spine, guide, 0);
    try {
        expect(native.isOk).toBe(false);
        expect(native.error).toMatch(/incompatible|does not lie completely/);
    } finally {
        native.shape.delete();
    }
});

test("NoContact resolves an oppositely oriented boundary guide without dropping full coverage", () => {
    const { first, second, spine, guide } = helicalFixture();
    const reversed = keep(guide.clone() as IWire);
    reversed.reserve();
    const native = nativeProof([first, second], spine, reversed, 0);
    try {
        expect(native.isOk, native.error).toBe(true);
        const guided = OccShape.wrap(native.shape);
        expect(guided.checkShape()).toBe(true);
        expect(guided.volume()).toBeGreaterThan(1000);
    } finally {
        native.shape.delete();
    }
});
