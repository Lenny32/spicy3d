// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IShape, Line, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { evaluateFeature, featureHandler } from "../../parametric/src/features/feature";
import { ParametricBodyNode } from "../../parametric/src/parametricBodyNode";
import { ShapeFactory } from "../src/factory";
import { HybridShapeFactory } from "../src/hybridShapeFactory";
import { createBox, createSphere, unwrapOk } from "./helpers";
import { NativeWorkerTransport } from "./workerHarness";
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

test("feature refuses synchronous evaluation and prepares a bounded envelope", async () => {
    const document = keep(new TestDocument({ application: createMockApplication() }));
    const host = keep(new ParametricBodyNode({ document, featuresJson: "[]" }));
    const input = keep(createSphere(factory, undefined, 2));
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    rs.stubGlobal("shapeFactory", new ShapeFactory(undefined, hybrid));
    const feature = { id: "wall", type: "thicken" as const, thickness: -3.75, tolerant: true };
    const context = { document, host, input, scope: new Map() };
    expect(evaluateFeature(feature, context).error).toContain("unavailable in synchronous evaluation");
    const prepare = featureHandler("thicken")?.prepareAsync;
    if (!prepare) throw new Error("Missing thicken prepareAsync");
    const pending = prepare(feature, context);
    if (!pending) throw new Error("Missing bounded thicken");
    expect(pending.canFallback).toBe(false);
    await pending.ready;
    const result = keep(unwrapOk(pending.take()));
    expect(result.volume()).toBeCloseTo(input.volume(), 6);
    const binding = wasm.ShapeFactory.makeThickSolidTolerant;
    try {
        wasm.ShapeFactory.makeThickSolidTolerant = undefined as never;
        const unavailable = prepare(feature, context);
        if (!unavailable) throw new Error("Missing bounded thicken");
        await unavailable.ready;
        expect(unavailable.take().error).toContain("not available in this kernel build");
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

function taperedLoft(ellipse: boolean): IShape {
    const wires = [20, 3].map((radius, index) => {
        const center = new XYZ(0, 0, index * 20);
        const edge = keep(
            unwrapOk(
                ellipse
                    ? factory.ellipse(XYZ.unitZ, center, XYZ.unitX, radius, radius * 0.6)
                    : factory.circle(XYZ.unitZ, center, radius),
            ),
        );
        return keep(unwrapOk(factory.wire([edge])));
    });
    return keep(unwrapOk(factory.loft(wires, true, false, "c0")));
}

function topOpening(input: IShape): IShape {
    const faces = input.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    const top = faces.find((face) => {
        const bounds = face.boundingBox();
        return Math.abs(bounds.min.z - 20) < 1e-5 && Math.abs(bounds.max.z - 20) < 1e-5;
    });
    expect(top).not.toBeUndefined();
    return top!;
}

test.each([-2.5, -3.75])("tolerant circular loft preserves the ordinary wall at %s", (thickness) => {
    const input = taperedLoft(false);
    const opening = topOpening(input);
    const ordinaryInput = keep(input.clone());
    const ordinary = keep(
        unwrapOk(factory.makeThickSolidByJoin(ordinaryInput, [topOpening(ordinaryInput)], thickness, "arc")),
    );
    const tolerant = keep(unwrapOk(factory.makeThickSolidTolerant(input, [opening], thickness)));
    expect(tolerant.volume()).toBeCloseTo(ordinary.volume(), 6);
    expect(tolerant.volume()).toBeLessThan(input.volume() * 0.99);
    expect(tolerant.checkShape()).toBe(true);
});

test.each([-2.5, -3.75])("free-form ellipse collapse refuses an unchanged envelope at %s", (thickness) => {
    const input = taperedLoft(true);
    const result = factory.makeThickSolidTolerant(input, [topOpening(input)], thickness);
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("free-form crease envelopes are not supported");
    expect(result.error).toContain("input face index");
    expect(result.error).not.toContain("retry with tolerant mode");
});

test.each([1, 2, 3.5, 5])("all-edge fillet radius %s never yields the unchanged opened box", (radius) => {
    const box = keep(createBox(factory, 30, 30, 20));
    const edges = box.findSubShapes(ShapeTypes.edge);
    owned.push(...edges);
    const input = keep(
        unwrapOk(
            factory.fillet(
                box,
                edges.map((_, index) => index),
                radius,
            ),
        ),
    );
    const result = factory.makeThickSolidTolerant(input, [topOpening(input)], -3.75);
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("offset returned the input unchanged");
    expect(input.checkShape()).toBe(true);
});

test("vertical small fillets produce a real opened prismatic wall", () => {
    const box = keep(createBox(factory, 30, 30, 20));
    const edges = box.findSubShapes(ShapeTypes.edge);
    owned.push(...edges);
    const vertical = edges.flatMap((edge, index) => {
        const bounds = edge.boundingBox();
        return bounds.max.z - bounds.min.z > 19.9 ? [index] : [];
    });
    expect(vertical).toHaveLength(4);
    const input = keep(unwrapOk(factory.fillet(box, vertical, 1)));
    const wall = keep(unwrapOk(factory.makeThickSolidTolerant(input, [topOpening(input)], -3.75)));
    expect(wall.checkShape()).toBe(true);
    expect(wall.volume()).toBeGreaterThan(0);
    expect(wall.volume()).toBeLessThan(input.volume() * 0.99);
});

test("closed all-fillet collapse reports the failed wall boolean", () => {
    const box = keep(createBox(factory, 30, 30, 20));
    const edges = box.findSubShapes(ShapeTypes.edge);
    owned.push(...edges);
    const input = keep(
        unwrapOk(
            factory.fillet(
                box,
                edges.map((_, index) => index),
                1,
            ),
        ),
    );
    const result = factory.makeThickSolidTolerant(input, [], -3.75);
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("Tolerant envelope wall boolean failed");
    expect(result.error).toContain("input face index");
});

test.each([-1, -3.75])("closed box ordinary recovery yields the exact wall at %s", (thickness) => {
    const input = keep(createBox(factory, 30, 30, 20));
    const result = keep(unwrapOk(factory.makeThickSolidTolerant(input, [], thickness)));
    const cavity = (30 + 2 * thickness) ** 2 * (20 + 2 * thickness);
    expect(result.volume()).toBeCloseTo(input.volume() - cavity, 6);
    expect(result.checkShape()).toBe(true);
    expect(result.volume()).toBeLessThan(input.volume() * 0.99);
});

test.each([-1e-5, 1e-5])("large box accepts a small ordinary offset %s", (thickness) => {
    const input = keep(createBox(factory, 1000, 1000, 1000));
    const result = keep(unwrapOk(factory.makeThickSolidByJoin(input, [], thickness, "arc")));
    expect(result.checkShape()).toBe(true);
    expect(Math.abs(result.volume() - input.volume())).toBeGreaterThan(50);
});

test("planar join offset keeps the helpful shell diagnostic", () => {
    const face = keep(unwrapOk(factory.rect(Plane.XY, 10, 10)));
    const result = factory.makeThickSolidByJoin(face, [], 1, "arc");
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("not a solid (Shell)");
    expect(result.error).toContain("makeThickSolidBySimple");
});

test("42-face perforated box preserves the ordinary arc wall", async () => {
    const box = keep(createBox(factory, 70, 70, 10));
    const holes = Array.from({ length: 36 }, (_, index) =>
        keep(
            unwrapOk(
                factory.cylinder(
                    XYZ.unitZ,
                    new XYZ(10 + (index % 6) * 10, 10 + Math.floor(index / 6) * 10, 0),
                    2,
                    10,
                ),
            ),
        ),
    );
    const input = keep(unwrapOk(factory.booleanCut([box], holes)));
    const faces = input.findSubShapes(ShapeTypes.face);
    owned.push(...faces);
    expect(faces).toHaveLength(42);
    const opening = faces.find((face) => {
        const bounds = face.boundingBox();
        return Math.abs(bounds.min.z - 10) < 1e-5 && Math.abs(bounds.max.z - 10) < 1e-5;
    });
    expect(opening).not.toBeUndefined();
    if (!opening) throw new Error("Missing top opening");
    const ordinary = keep(unwrapOk(factory.makeThickSolidByJoin(input, [opening], -0.5, "arc")));
    const tolerant = keep(unwrapOk(factory.makeThickSolidTolerant(input, [opening], -0.5)));
    expect(tolerant.volume()).toBeCloseTo(ordinary.volume(), 6);
    const hybrid = keep(new HybridShapeFactory(() => new NativeWorkerTransport().client));
    const operation = hybrid.shapeOperation({
        method: "makeThickSolidTolerant",
        shape: input,
        closingFaces: [opening],
        thickness: -0.5,
    });
    await operation.ready;
    const bounded = keep(unwrapOk(operation.take()));
    expect(bounded.checkShape()).toBe(true);
    expect(bounded.volume()).toBeCloseTo(ordinary.volume(), 6);
});
