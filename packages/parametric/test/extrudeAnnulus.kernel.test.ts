// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, type IShape, type ISolid, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { resolveProfiles } from "../src/features/profileBuilder";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let factory: ShapeFactory;
const owned: IShape[] = [];
const keep = <T extends IShape>(shape: T): T => {
    owned.push(shape);
    return shape;
};
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    factory = new ShapeFactory();
    Object.defineProperty(globalThis, "shapeFactory", { value: factory, writable: true, configurable: true });
});
afterEach(() => {
    for (const shape of owned.splice(0).reverse()) shape.dispose();
});

function annulus() {
    const doc = new TestDocument({ application: createMockApplication() });
    const sketch = new SketchNode({
        document: doc,
        plane: new Plane({ origin: new XYZ(0, 0, 15), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: {
            entities: [
                { id: 1, type: "circle", params: [0, 0, 3] },
                { id: 2, type: "circle", params: [0, 0, 2] },
            ],
            constraints: [],
        },
    });
    const profiles = resolveProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value).toHaveLength(1);
    return profiles.value[0].face;
}

function freeform(height = 6) {
    const sections = [-10, 0, 10].map((y) => {
        const edge = factory.bspline(
            [
                { x: -10, y, z: 0 },
                { x: 0, y, z: y === 0 ? height : height / 2 },
                { x: 10, y, z: 0 },
            ],
            [0, 1],
            [3, 3],
            2,
            false,
        );
        expect(edge.isOk).toBe(true);
        const wire = factory.wire([keep(edge.value)]);
        expect(wire.isOk).toBe(true);
        return keep(wire.value);
    });
    const loft = factory.loft(sections, false, false, "c2");
    expect(loft.isOk).toBe(true);
    const shape = keep(loft.value);
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    expect(faces).toHaveLength(1);
    faces.forEach(keep);
    return { shape, face: faces[0] };
}

test("next fully covers an annulus on a free-form face and preserves its hole", () => {
    const profile = annulus();
    const target = freeform();
    const result = factory.prismNextTracked(profile, XYZ.unitZ.multiply(-1), [target.shape], 0);
    expect(result.isOk, result.isOk ? "" : result.error).toBe(true);
    const tool = keep(result.value.shape);
    expect(tool.checkShape()).toBe(true);
    expect(Math.abs(tool.volume())).toBeGreaterThan(profile.area() * 8);
    expect(result.value.capFaces?.length).toBeGreaterThan(0);
    const solids = tool.findSubShapes(ShapeTypes.solid) as ISolid[];
    solids.forEach(keep);
    expect(solids).toHaveLength(1);
    expect(solids[0].containsPoint({ x: 0, y: 0, z: 10 }, false, 1e-6)).toBe(false);
    expect(solids[0].containsPoint({ x: 2.5, y: 0, z: 10 }, false, 1e-6)).toBe(true);
});

test.each([0.1, 1, 5, 25])("distance %s from a free-form face gives an exact annular volume", (depth) => {
    const profile = annulus();
    const target = freeform(30);
    const result = factory.prismFromTracked(profile, XYZ.unitZ.multiply(-1), target.face, 0.5, {
        kind: "distance",
        depth,
    });
    expect(result.isOk, result.isOk ? "" : result.error).toBe(true);
    const tool = keep(result.value.shape);
    expect(tool.checkShape()).toBe(true);
    expect(Math.abs(tool.volume())).toBeCloseTo(Math.PI * (9 - 4) * depth, 4);
});
