// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, type IWire, XYZ, type XYZLike } from "@spicy3d/core";
import type { OccShape } from "../src/shape";
import { createTestConverter, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

// #177: BRepGProp's fixed-order volume integration was several percent off on faces built
// from periodic B-spline outlines (a planar cap trimmed by one, a loft through them), and the
// adaptive VolumeProperties(Eps) was wrong on the cap while reporting a tiny error. The measured
// values (measuredVolume, measuredArea, inspectionMass) integrate span by span (Gauss-Kronrod)
// and agree with a fine tessellation; volume()/area() stay the fast fixed-order integration.

const factory = createTestFactory();
const converter = createTestConverter();
let owned: IShape[] = [];
afterEach(() => {
    for (const shape of owned.reverse()) shape.dispose();
    owned = [];
});

function own<T extends IShape>(shape: T): T {
    owned.push(shape);
    return shape;
}

/** A closed, wavy outline: one periodic cubic B-spline with `count` uniform spans. */
function outline(count: number, z: number, scale: number): IWire {
    const poles: XYZLike[] = [];
    for (let i = 0; i < count; i++) {
        const t = (2 * Math.PI * i) / count;
        const radius = scale * (1 + 0.1 * Math.sin(5 * t) + 0.05 * Math.cos(13 * t));
        poles.push({ x: 60 * radius * Math.cos(t), y: 30 * radius * Math.sin(t), z });
    }
    const knots = Array.from({ length: count + 1 }, (_, i) => i);
    const edge = own(unwrapOk(factory.bspline(poles, knots, Array(count + 1).fill(1), 3, true)));
    return own(unwrapOk(factory.wire([edge])));
}

/** Signed volume of a binary STL (divergence theorem over its facets). */
function stlVolume(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let volume = 0;
    for (let i = 0; i < view.getUint32(80, true); i++) {
        const vertex = (v: number) =>
            [0, 1, 2].map((axis) => view.getFloat32(84 + 50 * i + 12 + 12 * v + 4 * axis, true));
        const [a, b, c] = [vertex(0), vertex(1), vertex(2)];
        volume +=
            (a[0] * (b[1] * c[2] - b[2] * c[1]) -
                a[1] * (b[0] * c[2] - b[2] * c[0]) +
                a[2] * (b[0] * c[1] - b[1] * c[0])) /
            6;
    }
    return volume;
}

function fineMeshVolume(shape: IShape): number {
    return stlVolume(
        unwrapOk(converter.convertToSTL([shape], { linearTolerance: 0.01, angularTolerance: 2 })),
    );
}

function expectRelative(actual: number, expected: number, tolerance: number) {
    expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

describe("volume of periodic B-spline geometry", () => {
    test.each([24, 64])("a prism of a %i-span outline is its cap area times the depth", (count) => {
        const cap = own(unwrapOk(factory.face([outline(count, 0, 1)]))) as IFace;
        const prism = own(unwrapOk(factory.prism(cap, new XYZ(0, 0, 10))));
        const area = cap.measuredArea!();
        expectRelative(prism.measuredVolume!(), area * 10, 1e-6);
        // The cap's area itself, checked against the tessellation of the prism.
        expectRelative(fineMeshVolume(prism), area * 10, 2e-4);
    });

    test.each([
        { count: 24, ruled: true },
        { count: 64, ruled: true },
        { count: 24, ruled: false },
    ])("a three-station loft through $count-span outlines matches its fine tessellation (ruled: $ruled)", ({
        count,
        ruled,
    }) => {
        const sections = [outline(count, 0, 1), outline(count, 8, 0.9), outline(count, 15, 0.6)];
        const loft = own(unwrapOk(factory.loft(sections, true, ruled, "c0")));
        expect(loft.checkShape()).toBe(true);
        const mesh = fineMeshVolume(loft);
        // The fixed-order integration was 8-15% too high here.
        expectRelative(loft.measuredVolume!(), mesh, 3e-4);
        const mass = unwrapOk((loft as OccShape).inspectionMass());
        expect(mass.volume).toBeCloseTo(loft.measuredVolume!(), 6);
        expect(mass.relativeError).toBeGreaterThanOrEqual(0);
        expect(mass.relativeError).toBeLessThan(1e-6);
    });
});

describe("measured values on kernels without the bindings", () => {
    type Bindings = { measuredArea?: unknown; measuredVolume?: unknown };

    /** Runs `run` with `name` removed from `owner`, then puts it back. */
    function withoutBinding(owner: Bindings, name: keyof Bindings, run: () => void) {
        const original = owner[name];
        expect(original).toBeTypeOf("function");
        delete owner[name];
        try {
            run();
        } finally {
            owner[name] = original;
        }
    }

    test("measuredArea falls back to area()", () => {
        const cap = own(unwrapOk(factory.face([outline(24, 0, 1)]))) as IFace;
        withoutBinding(wasm.Face as unknown as Bindings, "measuredArea", () => {
            expect(cap.measuredArea!()).toBe(cap.area());
        });
    });

    test("measuredVolume falls back to volume()", () => {
        const cap = own(unwrapOk(factory.face([outline(24, 0, 1)]))) as IFace;
        const prism = own(unwrapOk(factory.prism(cap, new XYZ(0, 0, 10))));
        withoutBinding(wasm.Shape as unknown as Bindings, "measuredVolume", () => {
            expect(prism.measuredVolume!()).toBe(prism.volume());
        });
    });
});
