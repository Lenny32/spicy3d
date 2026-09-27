// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ShapeType, ShapeTypes, ShapeTypeUtils } from "../src";

describe("ShapeType", () => {
    test("should define shape type values", () => {
        expect(ShapeTypes.shape).toBe(0b0);
        expect(ShapeTypes.compound).toBe(0b1);
        expect(ShapeTypes.compoundSolid).toBe(0b10);
        expect(ShapeTypes.solid).toBe(0b100);
        expect(ShapeTypes.shell).toBe(0b1000);
        expect(ShapeTypes.face).toBe(0b10000);
        expect(ShapeTypes.wire).toBe(0b100000);
        expect(ShapeTypes.edge).toBe(0b1000000);
        expect(ShapeTypes.vertex).toBe(0b10000000);
    });

    test("should identify whole shape types", () => {
        expect(ShapeTypeUtils.isWhole(ShapeTypes.shape)).toBe(true);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.compound)).toBe(true);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.compoundSolid)).toBe(true);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.shell)).toBe(false);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.face)).toBe(false);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.wire)).toBe(false);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.edge)).toBe(false);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.vertex)).toBe(true);
    });

    test("should convert shape type to string", () => {
        expect(ShapeTypeUtils.stringValue(ShapeTypes.shape)).toBe("Shape");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.compound)).toBe("Compound");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.compoundSolid)).toBe("CompoundSolid");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.solid)).toBe("Solid");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.shell)).toBe("Shell");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.face)).toBe("Face");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.wire)).toBe("Wire");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.edge)).toBe("Edge");
        expect(ShapeTypeUtils.stringValue(ShapeTypes.vertex)).toBe("Vertex");
        expect(ShapeTypeUtils.stringValue(999 as ShapeType)).toBe("Unknown");
    });

    test.each<[string, (type: ShapeType) => boolean, [ShapeType, boolean][]]>([
        [
            "compound",
            ShapeTypeUtils.hasCompound,
            [
                [ShapeTypes.compound, true],
                [ShapeTypes.compoundSolid, false],
                [ShapeTypes.shape, false],
                [ShapeTypes.solid, false],
                [ShapeTypes.shell, false],
            ],
        ],
        [
            "compound solid",
            ShapeTypeUtils.hasCompoundSolid,
            [
                [ShapeTypes.compoundSolid, true],
                [ShapeTypes.compound, false],
                [ShapeTypes.shape, false],
                [ShapeTypes.solid, false],
            ],
        ],
        [
            "solid",
            ShapeTypeUtils.hasSolid,
            [
                [ShapeTypes.solid, true],
                [ShapeTypes.compoundSolid, false],
                [ShapeTypes.shape, false],
                [ShapeTypes.compound, false],
                [ShapeTypes.shell, false],
            ],
        ],
        [
            "shell",
            ShapeTypeUtils.hasShell,
            [
                [ShapeTypes.shell, true],
                [ShapeTypes.shape, false],
                [ShapeTypes.compound, false],
                [ShapeTypes.solid, false],
            ],
        ],
        [
            "face",
            ShapeTypeUtils.hasFace,
            [
                [ShapeTypes.face, true],
                [ShapeTypes.shape, false],
                [ShapeTypes.shell, false],
                [ShapeTypes.solid, false],
            ],
        ],
        [
            "wire",
            ShapeTypeUtils.hasWire,
            [
                [ShapeTypes.wire, true],
                [ShapeTypes.shape, false],
                [ShapeTypes.face, false],
                [ShapeTypes.shell, false],
            ],
        ],
        [
            "edge",
            ShapeTypeUtils.hasEdge,
            [
                [ShapeTypes.edge, true],
                [ShapeTypes.shape, false],
                [ShapeTypes.wire, false],
                [ShapeTypes.face, false],
            ],
        ],
        [
            "vertex",
            ShapeTypeUtils.hasVertex,
            [
                [ShapeTypes.vertex, true],
                [ShapeTypes.shape, false],
                [ShapeTypes.edge, false],
                [ShapeTypes.wire, false],
            ],
        ],
    ])("should detect %s in shape type", (_name, hasType, cases) => {
        for (const [type, expected] of cases) {
            expect(hasType(type)).toBe(expected);
        }
    });

    test("should support bitwise operations with combined types", () => {
        const combinedType = (ShapeTypes.compound | ShapeTypes.solid) as ShapeType;
        expect(ShapeTypeUtils.hasCompound(combinedType)).toBe(true);
        expect(ShapeTypeUtils.hasSolid(combinedType)).toBe(true);
        expect(ShapeTypeUtils.hasShell(combinedType)).toBe(false);
        expect(ShapeTypeUtils.hasFace(combinedType)).toBe(false);
        expect(ShapeTypeUtils.isWhole(combinedType)).toBe(false);
    });

    test("should handle CompoundSolid type properties", () => {
        expect(ShapeTypeUtils.hasCompound(ShapeTypes.compoundSolid)).toBe(false);
        expect(ShapeTypeUtils.hasSolid(ShapeTypes.compoundSolid)).toBe(false);
        expect(ShapeTypeUtils.hasCompoundSolid(ShapeTypes.compoundSolid)).toBe(true);
        expect(ShapeTypeUtils.isWhole(ShapeTypes.compoundSolid)).toBe(true);
    });
});
