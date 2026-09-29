// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IFace, type IShell, ShapeTypes } from "@spicy3d/core";
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

    function withBinding(binding: (shape: TopoDS_Shape) => boolean, run: () => void) {
        shapeClass().checkSelfIntersection = binding;
        try {
            run();
        } finally {
            delete shapeClass().checkSelfIntersection;
        }
    }

    test("the committed binary has no binding: an error, never a throw", () => {
        expect(shapeClass().checkSelfIntersection).toBeUndefined();
        const box = occBox();
        const result = box.checkSelfIntersection();
        expect(result.isOk ? "" : result.error).toBe(SELF_INTERSECTION_UNAVAILABLE);
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
