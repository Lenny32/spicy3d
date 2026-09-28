// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, Matrix4, Plane, ShapeTypes, type TrackedShape, XYZ } from "@spicy3d/core";
import type { OccShapeConverter } from "../src/converter";
import type { ShapeFactory } from "../src/factory";
import { createBox, createSphere, createTestConverter, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

// Bounded tool prisms: up to a face (prismUntilTracked) and through all (prismThruAllTracked).
// The Release WASM build aborts the whole module on any OCCT raise, so every failure below
// must come back as a Result error — each error test ends by using the kernel again.
let factory: ShapeFactory;
let converter: OccShapeConverter;

beforeEach(() => {
    factory = createTestFactory();
    converter = createTestConverter();
});

const UP = new XYZ({ x: 0, y: 0, z: 1 });
const DOWN = new XYZ({ x: 0, y: 0, z: -1 });

function faces(shape: IShape): IFace[] {
    return shape.findSubShapes(ShapeTypes.face) as IFace[];
}

/** A dx x dy rect on the plane z = `z`, its corner at (x, y). */
function rectAt(x: number, y: number, z: number, dx: number, dy: number): IFace {
    const plane = new Plane({ origin: new XYZ({ x, y, z }), normal: UP, xvec: XYZ.unitX });
    return unwrapOk(factory.rect(plane, dx, dy)) as IFace;
}

/** The planar face of `shape` whose center lies at height `z` with a vertical normal. */
function horizontalFaceAt(shape: IShape, z: number): IFace {
    const face = faces(shape).find((f) => {
        const box = f.boundingBox();
        return Math.abs(box.min.z - z) < 1e-6 && Math.abs(box.max.z - z) < 1e-6;
    });
    expect(face).toBeDefined();
    return face!;
}

function polygonFace(points: { x: number; y: number; z: number }[]): IFace {
    // A polygon wire is closed by repeating its first point.
    const wire = unwrapOk(factory.polygon([...points, points[0]].map((p) => new XYZ(p))));
    return unwrapOk(factory.face([wire])) as IFace;
}

function expectModuleAlive(): void {
    expect(createBox(factory, 1, 1, 1).volume()).toBeCloseTo(1, 6);
}

/** The history channels a tool must report, aligned with its face/edge enumeration. */
function expectToolChannels(tool: TrackedShape, sideFaces: number): void {
    const faceCount = faces(tool.shape).length;
    expect(tool.faceMap).toHaveLength(faceCount);
    expect(tool.faceEdgeMap).toHaveLength(faceCount);
    expect(tool.edgeMap).toHaveLength(tool.shape.findSubShapes(ShapeTypes.edge).length);
    // The bottom face is the profile face; each side face comes from one profile edge.
    expect(tool.faceMap.filter((x) => x === 0)).toHaveLength(1);
    expect(new Set(tool.faceEdgeMap!.filter((x) => x >= 0)).size).toBe(sideFaces);
    // The cap has no sweep history of its own.
    expect(tool.capFaces!.length).toBeGreaterThan(0);
    for (const index of tool.capFaces!) {
        expect(tool.faceMap[index]).toBe(-1);
        expect(tool.faceEdgeMap![index]).toBe(-1);
    }
}

function capFaceOf(tool: TrackedShape): IFace {
    expect(tool.capFaces).toHaveLength(1);
    return faces(tool.shape)[tool.capFaces![0]];
}

describe("prismUntilTracked", () => {
    test("stops on a parallel planar face", () => {
        const box = createBox(factory, 20, 20, 10);
        const profile = rectAt(5, 5, 30, 10, 10);
        const tool = unwrapOk(factory.prismUntilTracked(profile, DOWN, horizontalFaceAt(box, 10)));
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 20, 6);
        expectToolChannels(tool, 4);
        const cap = capFaceOf(tool).boundingBox();
        expect(cap.min.z).toBeCloseTo(10, 6);
        expect(cap.max.z).toBeCloseTo(10, 6);
    });

    test("applies the offset along the direction", () => {
        const box = createBox(factory, 20, 20, 10);
        const profile = rectAt(5, 5, 30, 10, 10);
        const tool = unwrapOk(factory.prismUntilTracked(profile, DOWN, horizontalFaceAt(box, 10), 2));
        // 2 further down than the face: z = 8.
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 22, 6);
    });

    test("serves both sides of a two-sided extent", () => {
        const box = createBox(factory, 20, 20, 10);
        const profile = rectAt(5, 5, 4, 10, 10);
        const up = unwrapOk(factory.prismUntilTracked(profile, UP, horizontalFaceAt(box, 10)));
        const down = unwrapOk(factory.prismUntilTracked(profile, DOWN, horizontalFaceAt(box, 0)));
        expect(up.shape.volume()).toBeCloseTo(10 * 10 * 6, 6);
        expect(down.shape.volume()).toBeCloseTo(10 * 10 * 4, 6);
    });

    test("cuts from the top face through to the bottom face", () => {
        const box = createBox(factory, 20, 20, 10);
        const profile = rectAt(5, 5, 10, 10, 10);
        const tool = unwrapOk(factory.prismUntilTracked(profile, DOWN, horizontalFaceAt(box, 0)));
        const cut = unwrapOk(factory.booleanCutTracked([box], [tool.shape]));
        expect(cut.shape.volume()).toBeCloseTo(20 * 20 * 10 - 10 * 10 * 10, 6);
        // A through hole: 6 box faces + 4 hole walls, no floor left.
        expect(faces(cut.shape)).toHaveLength(10);
    });

    test("stops on a tilted planar face", () => {
        // z = 20 + 0.2 y over the whole profile.
        const tilted = polygonFace([
            { x: -50, y: -50, z: 10 },
            { x: 50, y: -50, z: 10 },
            { x: 50, y: 50, z: 30 },
            { x: -50, y: 50, z: 30 },
        ]);
        const tool = unwrapOk(factory.prismUntilTracked(rectAt(0, 0, 0, 10, 10), UP, tilted));
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 20 + 0.2 * 10 * 50, 6);
        expectToolChannels(tool, 4);
        const [, normal] = capFaceOf(tool).normal(0, 0);
        expect(Math.abs(normal.z)).toBeLessThan(0.99);
    });

    test("extends a face that covers only part of the profile", () => {
        // The same tilted plane, but the face spans only x in [0, 3] of the profile's [0, 10].
        const narrow = polygonFace([
            { x: 0, y: -50, z: 10 },
            { x: 3, y: -50, z: 10 },
            { x: 3, y: 50, z: 30 },
            { x: 0, y: 50, z: 30 },
        ]);
        const tool = unwrapOk(factory.prismUntilTracked(rectAt(0, 0, 0, 10, 10), UP, narrow));
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 20 + 0.2 * 10 * 50, 6);
        expectToolChannels(tool, 4);
    });

    test("stops on a cylindrical face", () => {
        // Cylinder r = 10 along X; its underside above the profile is z = -sqrt(100 - y^2).
        const cylinder = unwrapOk(factory.cylinder(XYZ.unitX, new XYZ({ x: -20, y: 0, z: 0 }), 10, 40));
        const lateral = faces(cylinder).reduce((a, b) => (a.area() > b.area() ? a : b));
        const tool = unwrapOk(factory.prismUntilTracked(rectAt(-5, -5, -30, 10, 10), UP, lateral));
        const segment = 2 * (2.5 * Math.sqrt(75) + 50 * Math.asin(0.5));
        expect(tool.shape.volume()).toBeCloseTo(10 * (10 * 30 - segment), 2);
        expectToolChannels(tool, 4);
        for (const index of tool.capFaces!) {
            const box = faces(tool.shape)[index].boundingBox();
            expect(box.max.z).toBeLessThanOrEqual(-Math.sqrt(75) + 1e-4);
            expect(box.min.z).toBeGreaterThanOrEqual(-10 - 1e-4);
        }
    });

    test("fails on a face that does not intercept the profile, without aborting", () => {
        const sphere = createSphere(factory, new XYZ({ x: 100, y: 0, z: 50 }), 10);
        const result = factory.prismUntilTracked(rectAt(0, 0, 0, 10, 10), UP, faces(sphere)[0]);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("does not bound");
        expectModuleAlive();
    });

    test("fails on a face behind the profile", () => {
        const box = createBox(factory, 20, 20, 10);
        const result = factory.prismUntilTracked(rectAt(5, 5, 30, 10, 10), UP, horizontalFaceAt(box, 10));
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("not reached");
        expectModuleAlive();
    });

    test("keeps the tool channels stable when the target resizes", () => {
        // #59's scenario: a cut from the top face to the bottom face of a cube whose height
        // changes — the hole walls keep deriving from the same profile edges.
        const wallsByHeight = [10, 25].map((height) => {
            const box = createBox(factory, 20, 20, height);
            const profile = rectAt(5, 5, height, 10, 10);
            const tool = unwrapOk(factory.prismUntilTracked(profile, DOWN, horizontalFaceAt(box, 0)));
            const cut = unwrapOk(factory.booleanCutTracked([box], [tool.shape]));
            expect(cut.shape.volume()).toBeCloseTo((20 * 20 - 10 * 10) * height, 6);
            const boxFaces = faces(box).length;
            const walls = cut.faceMap
                .filter((input) => input >= boxFaces)
                .map((input) => tool.faceEdgeMap![input - boxFaces])
                .sort((a, b) => a - b);
            return { tool, walls };
        });
        const [low, tall] = wallsByHeight;
        expect(low.walls).toEqual([0, 1, 2, 3]);
        expect(tall.walls).toEqual(low.walls);
        expect(tall.tool.faceMap).toEqual(low.tool.faceMap);
        expect(tall.tool.faceEdgeMap).toEqual(low.tool.faceEdgeMap);
        expect(tall.tool.edgeMap).toEqual(low.tool.edgeMap);
        expect(tall.tool.capFaces).toEqual(low.tool.capFaces);
    });

    describe("degenerate inputs return errors, never abort", () => {
        const box = () => createBox(factory, 20, 20, 10);

        test.each([
            ["a zero direction", () => XYZ.zero, "zero"],
            ["a direction in the profile plane", () => XYZ.unitX, "profile plane"],
        ])("%s", (_, direction, message) => {
            const result = factory.prismUntilTracked(
                rectAt(5, 5, 30, 10, 10),
                direction(),
                horizontalFaceAt(box(), 10),
            );
            expect(result.isOk).toBe(false);
            expect(result.error).toContain(message);
            expectModuleAlive();
        });

        test("a target plane parallel to the direction", () => {
            const side = faces(box()).find((f) => {
                const b = f.boundingBox();
                return Math.abs(b.min.x) < 1e-6 && Math.abs(b.max.x) < 1e-6;
            })!;
            const result = factory.prismUntilTracked(rectAt(5, 5, 30, 10, 10), DOWN, side);
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("parallel");
            expectModuleAlive();
        });

        test("a cylinder whose axis is the direction", () => {
            const cylinder = unwrapOk(factory.cylinder(UP, XYZ.zero, 20, 30));
            const lateral = faces(cylinder).reduce((a, b) => (a.area() > b.area() ? a : b));
            const result = factory.prismUntilTracked(rectAt(-5, -5, 30, 10, 10), DOWN, lateral);
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("parallel");
            expectModuleAlive();
        });

        test("a target that is not a face, or an empty shape", () => {
            const empty = box().section(box().transformed(Matrix4.fromTranslation(100, 0, 0)));
            expect(empty.findSubShapes(ShapeTypes.face)).toHaveLength(0);
            for (const target of [box(), empty]) {
                const result = factory.prismUntilTracked(rectAt(5, 5, 30, 10, 10), DOWN, target as IFace);
                expect(result.isOk).toBe(false);
                expect(result.error).toContain("not a face");
            }
            const noProfile = factory.prismUntilTracked(empty, DOWN, horizontalFaceAt(box(), 10));
            expect(noProfile.isOk).toBe(false);
            expect(noProfile.error).toContain("no face");
            expectModuleAlive();
        });

        test("a surface-less target face", () => {
            const brep = [
                "CASCADE Topology V3, (c) Open Cascade",
                "Locations 0",
                "Curve2ds 0",
                "Curves 0",
                "Polygon3D 0",
                "PolygonOnTriangulations 0",
                "Surfaces 0",
                "Triangulations 1",
                "3 1 0 0 0",
                "0 0 0 10 0 0 0 10 0",
                "1 2 3",
                "",
                "TShapes 1",
                "Fa",
                "0  1e-07 0 0",
                "2 1",
                "",
                "1101000",
                "*",
                "",
                "+1 0",
                "",
            ].join("\n");
            const face = unwrapOk(converter.convertFromBrep(brep)) as IFace;
            const result = factory.prismUntilTracked(rectAt(0, 0, -10, 5, 5), UP, face);
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("no surface");
            expectModuleAlive();
        });

        test("a NaN offset", () => {
            const result = factory.prismUntilTracked(
                rectAt(5, 5, 30, 10, 10),
                DOWN,
                horizontalFaceAt(box(), 10),
                Number.NaN,
            );
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("offset");
            expectModuleAlive();
        });
    });
});

describe("prismThruAllTracked", () => {
    test("cuts through a cube", () => {
        const box = createBox(factory, 20, 20, 20);
        const tool = unwrapOk(factory.prismThruAllTracked(rectAt(5, 5, 20, 10, 10), DOWN, [box]));
        expectToolChannels(tool, 4);
        // It goes past the bottom face.
        expect(tool.shape.boundingBox().min.z).toBeLessThan(0);
        const cut = unwrapOk(factory.booleanCutTracked([box], [tool.shape]));
        expect(cut.shape.volume()).toBeCloseTo(20 * 20 * 20 - 10 * 10 * 20, 6);
        expect(faces(cut.shape)).toHaveLength(10);
    });

    test("ends flush with the far side for a join", () => {
        const box = createBox(factory, 20, 20, 20);
        const tool = unwrapOk(factory.prismThruAllTracked(rectAt(5, 5, 30, 10, 10), DOWN, [box], true));
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 30, 6);
        const cap = capFaceOf(tool).boundingBox();
        expect(cap.min.z).toBeCloseTo(0, 6);
        expect(cap.max.z).toBeCloseTo(0, 6);
        const joined = unwrapOk(factory.booleanFuseTracked([box], [tool.shape]));
        expect(joined.shape.volume()).toBeCloseTo(20 * 20 * 20 + 10 * 10 * 10, 6);
    });

    test("ends a slanted profile on a flat plane", () => {
        const box = createBox(factory, 20, 20, 20);
        const slanted = polygonFace([
            { x: 5, y: 5, z: 30 },
            { x: 15, y: 5, z: 30 },
            { x: 15, y: 15, z: 35 },
            { x: 5, y: 15, z: 35 },
        ]);
        const tool = unwrapOk(factory.prismThruAllTracked(slanted, DOWN, [box], true));
        expectToolChannels(tool, 4);
        const cap = capFaceOf(tool).boundingBox();
        expect(cap.min.z).toBeCloseTo(0, 6);
        expect(cap.max.z).toBeCloseTo(0, 6);
        // Mean height 32.5 over a 10 x 10 footprint.
        expect(tool.shape.volume()).toBeCloseTo(10 * 10 * 32.5, 6);
    });

    test("goes through several bodies", () => {
        const upper = createBox(factory, 20, 20, 10);
        const lower = createBox(factory, 20, 20, 10).transformed(Matrix4.fromTranslation(0, 0, -30));
        const tool = unwrapOk(
            factory.prismThruAllTracked(rectAt(5, 5, 10, 10, 10), DOWN, [upper, lower], true),
        );
        expect(tool.shape.boundingBox().min.z).toBeCloseTo(-30, 6);
    });

    test.each([
        ["nothing ahead of the profile", () => [createBox(factory, 20, 20, 10)], UP, "nothing"],
        ["no bounds", () => [], DOWN, "nothing"],
        ["a zero direction", () => [createBox(factory, 20, 20, 10)], XYZ.zero, "zero"],
        [
            "a direction in the profile plane",
            () => [createBox(factory, 20, 20, 10)],
            XYZ.unitY,
            "profile plane",
        ],
    ])("fails on %s without aborting", (_, bounds, direction, message) => {
        const result = factory.prismThruAllTracked(rectAt(5, 5, 30, 10, 10), direction, bounds());
        expect(result.isOk).toBe(false);
        expect(result.error.toLowerCase()).toContain(message);
        expectModuleAlive();
    });
});
