// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IShape, Line, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { evaluateFeature } from "../../parametric/src/features/feature";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { ShapeFactory } from "../src/factory";
import { createBox, createSphere, unwrapOk } from "./helpers";
import "./setup";
import "../../parametric/src/features/thicken";

const factory = new ShapeFactory();
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    for (const value of owned.reverse()) value.dispose();
    owned = [];
    rs.unstubAllGlobals();
});
function ring(): IShape {
    const circle = keep(unwrapOk(factory.circle(XYZ.unitY, new XYZ(10, 0, 0), 2)));
    const wire = keep(unwrapOk(factory.wire([circle])));
    const face = keep(unwrapOk(factory.face([wire])));
    return keep(unwrapOk(factory.revolve(face, new Line({ point: XYZ.zero, direction: XYZ.unitZ }), 360)));
}

test.each([
    "sphere",
    "ring torus",
])("%s cavity collapse yields the exact filled material envelope", (kind) => {
    const input = kind === "sphere" ? keep(createSphere(factory, undefined, 2)) : ring();
    const normal = factory.makeThickSolidByJoin(input, [], -3.75, "arc");
    expect(normal.isOk).toBe(false);
    expect(normal.error).toContain("possible offset collapse");
    expect(normal.error).toContain("retry with tolerant mode");
    const output = keep(unwrapOk(factory.makeThickSolidTolerant(input, [], -3.75)));
    expect(output.checkShape()).toBe(true);
    const check = output.checkSelfIntersection;
    if (!check) throw new Error("Missing self-intersection binding");
    expect(unwrapOk(check.call(output))).toBe(true);
    expect(output.volume()).toBeCloseTo(input.volume(), 6);
    const solids = output.findSubShapes(ShapeTypes.solid);
    owned.push(...solids);
    expect(solids).toHaveLength(1);
    expect(input.checkShape()).toBe(true);
});

test.each([-1, 1])("sphere envelope retains a finite wall below collapse (thickness %s)", (thickness) => {
    const input = keep(createSphere(factory, undefined, 2));
    const result = keep(unwrapOk(factory.makeThickSolidTolerant(input, [], thickness)));
    expect(result.checkShape()).toBe(true);
    const expected = (4 / 3) * Math.PI * Math.abs(8 - (2 + thickness) ** 3);
    expect(result.volume()).toBeCloseTo(expected, 6);
});

test("trimmed intersection mode shells a planar solid with the selected opening", () => {
    const box = keep(createBox(factory, 20, 20, 10));
    const faces = box.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const result = keep(unwrapOk(factory.makeThickSolidTolerant(box, [faces[0]], -1)));
    expect(result.checkShape()).toBe(true);
    expect(result.volume()).toBeGreaterThan(0);
    expect(result.volume()).toBeLessThan(box.volume());
    const outputFaces = result.findSubShapes(ShapeTypes.face);
    owned.push(...outputFaces);
    expect(outputFaces.some((face) => face.isSame(faces[0]))).toBe(false);
});

test("open skins and excessive unrecognized collapse remain errors", () => {
    const face = keep(unwrapOk(factory.rect(Plane.XY, 10, 10)));
    expect(factory.makeThickSolidTolerant(face, [], 1).error).toContain("open skins are unsupported");
    const box = keep(createBox(factory, 10, 10, 10));
    const result = factory.makeThickSolidTolerant(box, [], -100);
    expect(result.isOk).toBe(false);
    expect(box.volume()).toBeCloseTo(1000, 6);
});

test("feature uses envelope as material directly and older bindings refuse the opt-in", () => {
    const document = keep(new TestDocument({ application: createMockApplication() }));
    const host = keep(new ParametricBodyNode({ document, featuresJson: "[]" }));
    const input = keep(createSphere(factory, undefined, 2));
    rs.stubGlobal("shapeFactory", factory);
    const feature = { id: "wall", type: "thicken" as const, thickness: -3.75, tolerant: true };
    const result = keep(unwrapOk(evaluateFeature(feature, { document, host, input, scope: new Map() })));
    expect(result.volume()).toBeCloseTo(input.volume(), 6);
    const binding = wasm.ShapeFactory.makeThickSolidTolerant;
    try {
        wasm.ShapeFactory.makeThickSolidTolerant = undefined as never;
        expect(evaluateFeature(feature, { document, host, input, scope: new Map() }).error).toContain(
            "not available in this kernel build",
        );
        const ordinary = evaluateFeature(
            { ...feature, tolerant: undefined, thickness: -1 },
            { document, host, input, scope: new Map() },
        );
        const wall = keep(unwrapOk(ordinary));
        expect(wall.checkShape()).toBe(true);
        expect(wall.volume()).toBeLessThan(input.volume());
    } finally {
        wasm.ShapeFactory.makeThickSolidTolerant = binding;
    }
});
