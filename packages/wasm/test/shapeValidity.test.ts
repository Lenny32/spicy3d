// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IFace, type IShell, ShapeTypes, XYZ } from "@spicy3d/core";
import type { TopoDS_Shape } from "../lib/spicy-wasm";
import { OccShape, SELF_INTERSECTION_UNAVAILABLE } from "../src/shape";
import { createBox, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    rs.restoreAllMocks();
    for (const value of owned.reverse()) value.dispose();
    owned = [];
});

/** Five faces of a box: an open shell. */
function openShellFaces(): IShell {
    const box = keep(createBox(factory));
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    return keep(unwrapOk(factory.shell(faces.slice(0, 5))));
}

/** A solid whose shell misses one face of a box: `checkShape()` is false (BRepCheck_NotClosed). */
function openShellSolid(): OccShape {
    const shell = openShellFaces();
    const solid = keep(unwrapOk(factory.solid([shell])));
    expect(solid.shapeType).toBe(ShapeTypes.solid);
    expect(solid.checkShape()).toBe(false);
    return solid as unknown as OccShape;
}

/** A box as the OCCT class, whose optional IShape members are all present. */
function occBox(dx?: number, dy?: number, dz?: number): OccShape {
    return keep(createBox(factory, dx, dy, dz)) as unknown as OccShape;
}

type ShapeClass = { checkSelfIntersection?: (shape: TopoDS_Shape) => boolean };

describe("thick solid results are checked", () => {
    test("a thick solid of a closed box (one face opened) passes", () => {
        const box = keep(createBox(factory));
        const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
        const thick = factory.makeThickSolidByJoin(box, [faces[0]], -1, "arc");
        expect(thick.isOk).toBe(true);
        const shape = keep(unwrapOk(thick));
        expect(shape.checkShape()).toBe(true);
        expect(shape.volume()).toBeGreaterThan(0);
    });

    test("a join thick solid of an open lofted shell without closing faces is refused as not a solid", () => {
        // Three open 4-point polylines (a U) at z = 0 / 10 / 20, lofted into an open skin.
        const sections = [0, 10, 20].map((z) =>
            keep(
                unwrapOk(
                    factory.polygon([
                        { x: 0, y: 0, z },
                        { x: 10, y: 0, z },
                        { x: 10, y: 10, z },
                        { x: 0, y: 10, z },
                    ]),
                ),
            ),
        );
        const skin = keep(unwrapOk(factory.loft(sections, false, false, "c2")));
        expect(skin.findSubShapes(ShapeTypes.solid)).toHaveLength(0);

        const joined = factory.makeThickSolidByJoin(skin, [], 1, "arc");
        expect(joined.isOk).toBe(false);
        expect(joined.error).toMatch(
            /^MakeThickSolidByJoin failed: the result is not a solid \(\w+\); for an open shell use makeThickSolidBySimple$/,
        );

        const simple = factory.makeThickSolidBySimple(skin, 1);
        expect(simple.isOk).toBe(true);
        const solid = keep(unwrapOk(simple));
        expect(solid.findSubShapes(ShapeTypes.solid).length).toBeGreaterThan(0);
        expect(solid.checkShape()).toBe(true);
    });

    test("a thick solid of an open shell passes", () => {
        const thick = factory.makeThickSolidBySimple(openShellFaces(), 1);
        expect(thick.isOk).toBe(true);
        expect(keep(unwrapOk(thick)).checkShape()).toBe(true);
    });

    test.each([
        ["MakeThickSolidBySimple", () => factory.makeThickSolidBySimple(openShellFaces(), 1)],
        [
            "MakeThickSolidByJoin",
            () => {
                const box = keep(createBox(factory));
                const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
                return factory.makeThickSolidByJoin(box, [faces[0]], -1, "arc");
            },
        ],
    ])("%s refuses a result whose checkShape is false", (op, make) => {
        const check = rs.spyOn(OccShape.prototype, "checkShape").mockReturnValue(false);
        const result = make();
        expect(check).toHaveBeenCalled();
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toBe(
            `${op} failed: Thick solid is invalid (checkShape is false)`,
        );
    });
});

describe("inspections refuse invalid inputs before calling the kernel", () => {
    test("inspectionCommonVolume with an invalid target", () => {
        const kernel = rs.spyOn(wasm.Shape, "inspectionCommonVolume");
        const invalid = openShellSolid();
        const box = occBox();
        const result = invalid.inspectionCommonVolume(box);
        expect(result.isOk ? "" : result.error).toBe(
            "Intersection volume: the target shape is invalid (checkShape is false)",
        );
        expect(kernel).not.toHaveBeenCalled();
    });

    test("inspectionCommonVolume with an invalid other shape", () => {
        const kernel = rs.spyOn(wasm.Shape, "inspectionCommonVolume");
        const invalid = openShellSolid();
        const box = occBox();
        const result = box.inspectionCommonVolume(invalid);
        expect(result.isOk ? "" : result.error).toBe(
            "Intersection volume: the other shape is invalid (checkShape is false)",
        );
        expect(kernel).not.toHaveBeenCalled();
    });

    test("inspectionMass with an invalid shape", () => {
        const kernel = rs.spyOn(wasm.Shape, "inspectionMass");
        const result = openShellSolid().inspectionMass();
        expect(result.isOk ? "" : result.error).toBe(
            "Volume center: the shape is invalid (checkShape is false)",
        );
        expect(kernel).not.toHaveBeenCalled();
    });

    test("valid inputs still reach the kernel", () => {
        const common = rs.spyOn(wasm.Shape, "inspectionCommonVolume");
        const mass = rs.spyOn(wasm.Shape, "inspectionMass");
        const box = occBox(10, 20, 30);
        const other = occBox(10, 10, 10);
        expect(unwrapOk(box.inspectionCommonVolume(other))).toBeCloseTo(1000, 6);
        expect(unwrapOk(box.inspectionMass()).volume).toBeCloseTo(6000, 6);
        expect(common).toHaveBeenCalledTimes(1);
        expect(mass).toHaveBeenCalledTimes(1);
    });
});

describe("checkSelfIntersection is feature-detected on the kernel build", () => {
    const shapeClass = () => wasm.Shape as unknown as ShapeClass;

    /**
     * Runs `run` with `binding` standing in for the C++ `Shape.checkSelfIntersection` (undefined:
     * a module without it), then puts back whatever the loaded module had.
     */
    function withBinding(binding: ((shape: TopoDS_Shape) => boolean) | undefined, run: () => void) {
        const had = Object.hasOwn(shapeClass(), "checkSelfIntersection");
        const original = shapeClass().checkSelfIntersection;
        if (binding === undefined) delete shapeClass().checkSelfIntersection;
        else shapeClass().checkSelfIntersection = binding;
        try {
            run();
        } finally {
            if (had) shapeClass().checkSelfIntersection = original;
            else delete shapeClass().checkSelfIntersection;
        }
    }

    test("a module without the binding: an error, never a throw", () => {
        const box = occBox();
        withBinding(undefined, () => {
            expect(shapeClass().checkSelfIntersection).toBeUndefined();
            const result = box.checkSelfIntersection();
            expect(result.isOk ? "" : result.error).toBe(SELF_INTERSECTION_UNAVAILABLE);
        });
    });

    test("the committed binary has the binding: a box has no self-intersection", () => {
        expect(typeof shapeClass().checkSelfIntersection).toBe("function");
        expect(unwrapOk(occBox().checkSelfIntersection())).toBe(true);
    });

    test("the committed binary's binding finds a prism of a self-crossing (bow-tie) outline", () => {
        const bowTie = keep(
            unwrapOk(
                factory.polygon([
                    { x: 0, y: 0, z: 0 },
                    { x: 10, y: 10, z: 0 },
                    { x: 10, y: 0, z: 0 },
                    { x: 0, y: 10, z: 0 },
                    { x: 0, y: 0, z: 0 },
                ]),
            ),
        );
        const face = keep(unwrapOk(factory.face([bowTie])));
        const prism = keep(unwrapOk(factory.prism(face, new XYZ(0, 0, 5)))) as unknown as OccShape;
        expect(unwrapOk(prism.checkSelfIntersection())).toBe(false);
    });

    test.each([true, false])("a present binding answers %s", (answer) => {
        const binding = rs.fn((_shape: TopoDS_Shape) => answer);
        const box = occBox();
        withBinding(binding, () => {
            expect(unwrapOk(box.checkSelfIntersection())).toBe(answer);
        });
        expect(binding).toHaveBeenCalledTimes(1);
        expect(binding.mock.calls[0][0]).toBe(box.shape);
    });

    test("a binding that throws becomes an error result", () => {
        const binding = rs.fn((_shape: TopoDS_Shape): boolean => {
            throw new Error("Shape.checkSelfIntersection: BOPAlgo failure");
        });
        const box = occBox();
        withBinding(binding, () => {
            const result = box.checkSelfIntersection();
            expect(result.isOk ? "" : result.error).toBe(
                "CheckSelfIntersection failed: Shape.checkSelfIntersection: BOPAlgo failure",
            );
        });
        expect(binding).toHaveBeenCalledTimes(1);
    });
});
