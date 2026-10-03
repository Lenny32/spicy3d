// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IDisposable,
    type IFace,
    type IShape,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory } from "@spicy3d/wasm";
import { resolveProfiles } from "../src/features/profileBuilder";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let factory: ShapeFactory;
const owned: IDisposable[] = [];
const keep = <T extends IDisposable>(value: T): T => {
    owned.push(value);
    return value;
};
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});
afterEach(() => {
    for (const value of owned.splice(0).reverse()) value.dispose();
});

/** #143: 18 chord-parameterized fit curves, 6–10 points with incompatible knot layouts. */
function fitPointSections(heightScale = 1) {
    const doc = keep(new TestDocument({ application: createMockApplication() }));
    const sections = Array.from({ length: 18 }, (_, section) => {
        const count = 6 + (section % 5);
        const sketch = new SketchNode({
            document: doc,
            plane: new Plane({
                origin: new XYZ(0, (section - 8.5) * 3, 0),
                normal: XYZ.unitY,
                xvec: XYZ.unitX,
            }),
            data: {
                entities: [
                    {
                        id: section + 1,
                        type: "bspline",
                        parametrization: "chord",
                        params: Array.from({ length: count }, (_, point) => {
                            const t = (point / (count - 1)) ** (0.8 + section / 50);
                            const height =
                                (8 + 2 * Math.sin(section / 5)) * Math.sin(Math.PI * t) +
                                2 * Math.sin(2 * Math.PI * t + section / 10) * Math.sin(Math.PI * t);
                            return [-25 + 50 * t, -height * heightScale];
                        }).flat(),
                    },
                ],
                constraints: [],
            },
        });
        doc.modelManager.addNode(sketch);
        expect(sketch.shape.isOk).toBe(true);
        return sketch;
    });
    return { doc, sections };
}

function fitPointLoft(heightScale = 1): IShape {
    const { sections } = fitPointSections(heightScale);
    const loft = factory.loft(
        sections.map((sketch) => sketch.shape.value),
        false,
        false,
        "c2",
    );
    expect(loft.isOk).toBe(true);
    return keep(loft.value);
}

function annulus(x = 20, y = -20): IFace {
    const doc = keep(new TestDocument({ application: createMockApplication() }));
    const sketch = keep(
        new SketchNode({
            document: doc,
            plane: new Plane({ origin: new XYZ(0, 0, 15), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: {
                entities: [
                    { id: 101, type: "circle", params: [x, y, 3] },
                    { id: 102, type: "circle", params: [x, y, 2] },
                ],
                constraints: [],
            },
        }),
    );
    const profiles = resolveProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value).toHaveLength(1);
    return keep(profiles.value[0].face);
}

function singleFace(shape: IShape): IFace {
    const faces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    faces.forEach(keep);
    expect(faces).toHaveLength(1);
    return faces[0];
}

test.each([
    1, -1, 3.75, -3.75,
])("incompatible fit-point loft sections thicken at %s mm and support a trim", (thickness) => {
    const skin = fitPointLoft(0.5);
    const converter = new OccShapeConverter();
    const before = converter.convertToBrep(skin);
    expect(before.isOk).toBe(true);
    const wall = factory.makeThickSolidBySimple(keep(skin.clone()), thickness);
    expect(wall.isOk, wall.isOk ? "" : wall.error).toBe(true);
    const shape = keep(wall.value);
    expect(shape.shapeType).toBe(ShapeTypes.solid);
    expect(shape.checkShape()).toBe(true);
    expect(Math.abs(shape.volume())).toBeGreaterThan(1000 * Math.abs(thickness));
    expect(typeof shape.checkSelfIntersection).toBe("function");
    const interference = shape.checkSelfIntersection?.();
    expect(interference?.isOk).toBe(true);
    expect(interference?.value).toBe(true);
    const cutter = factory.box(
        new Plane({ origin: new XYZ(0, -50, -50), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        100,
        100,
        100,
    );
    expect(cutter.isOk).toBe(true);
    keep(cutter.value);
    const trimmed = factory.booleanCut([shape], [cutter.value]);
    expect(trimmed.isOk, trimmed.isOk ? "" : trimmed.error).toBe(true);
    keep(trimmed.value);
    expect(trimmed.value.checkShape()).toBe(true);
    expect(Math.abs(trimmed.value.volume())).toBeGreaterThan(Math.abs(shape.volume()) * 0.3);
    expect(Math.abs(trimmed.value.volume())).toBeLessThan(Math.abs(shape.volume()) * 0.7);
    expect(converter.convertToBrep(skin).value).toBe(before.value);
});

test("a recovered thicken feature keeps the skin's tracked face through expression edits and undo", () => {
    const { doc, sections } = fitPointSections(0.5);
    Transaction.execute(doc, "wall thickness", () => {
        doc.variables.setItems([{ id: "wall-size", name: "wall_t", expression: "1", type: "length" }]);
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "skin",
                type: "loft",
                sections: sections.map((sketch) => ({ sketchId: sketch.id })),
                solid: false,
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    const faceIds = () => {
        const faces = body.shape.value.findSubShapes(ShapeTypes.face);
        faces.forEach(keep);
        return faces.map((_, index) => body.faceIdAt(index));
    };
    const skinId = body.faceIdAt(0);
    expect(skinId).toMatch(/.+/);
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "wall", type: "thicken", thickness: "wall_t" },
    ]);
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(faceIds()).toContain(skinId);
    const volume = body.shape.value.volume();
    Transaction.execute(doc, "reverse wall thickness", () => {
        doc.variables.setItems([{ id: "wall-size", name: "wall_t", expression: "-1", type: "length" }]);
    });
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(faceIds()).toContain(skinId);
    expect(body.shape.value.volume()).not.toBeCloseTo(volume, 2);
    doc.history.undo();
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(faceIds()).toContain(skinId);
    expect(body.shape.value.volume()).toBeCloseTo(volume, 4);
});

test.each([
    0.1, 1, 5, 25,
])("an annulus near the end of a free-form loft starts at the selected face with depth %s", (depth) => {
    const skin = fitPointLoft();
    const profile = annulus();
    const result = factory.prismFromTracked(profile, XYZ.unitZ.multiply(-1), singleFace(skin), 0.5, {
        kind: "distance",
        depth,
    });
    expect(result.isOk, result.isOk ? "" : result.error).toBe(true);
    const tool = keep(result.value.shape);
    expect(tool.checkShape()).toBe(true);
    // Public volume() uses fixed quadrature; the full-coverage kernel check uses adaptive integration.
    const expected = Math.PI * 5 * depth;
    expect(Math.abs(Math.abs(tool.volume()) - expected)).toBeLessThan(expected * 2e-6);
    expect(result.value.capFaces?.length).toBeGreaterThan(0);
});

test("a partially uncovered annular starting profile is still refused", () => {
    const skin = fitPointLoft();
    const result = factory.prismFromTracked(annulus(24, -20), XYZ.unitZ.multiply(-1), singleFace(skin), 0.5, {
        kind: "distance",
        depth: 1,
    });
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("do not fully bound the extrusion");
});
