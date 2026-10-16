// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type BoundedShapeQuery, DocumentRebuilds, Plane, Result, XYZ } from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { ShapeFactory } from "@spicy3d/wasm";
import "../../wasm/test/setup";
import { SMOOTH_LOFT_SELF_INTERSECTION } from "../src/features/loft";
import { SELF_INTERSECTION_SKIPPED } from "../src/features/selfIntersectionValidation";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";

afterEach(() => {
    rs.unstubAllGlobals();
});

/** A 32-point periodic outline about 87.5 × 111.6 mm, scaled toward (0, `cy`). */
function outline(scale: number, cy: number): [number, number][] {
    return Array.from({ length: 32 }, (_, i) => {
        const t = (2 * Math.PI * i) / 32;
        const x = 43.75 * Math.cos(t) * (1 - 0.12 * Math.sin(t));
        const y = 55.8 + 55.8 * Math.sin(t);
        return [x * scale, cy + (y - cy) * scale];
    });
}

const bspline = (points: [number, number][]): SketchData => ({
    entities: [{ id: 1, type: "bspline", periodic: true, parametrization: "chord", params: points.flat() }],
    constraints: [],
});

/**
 * #176: XY sections at z = 0.4 and 3.1, then a smaller section on the plane through (0, 0, 8),
 * (100, 0, 11), (0, 100, 4.5) — 0.8 mm above the middle one at the far end. The smooth loft
 * overshoots past that cap and folds its side onto itself; `checkShape` still passes.
 */
function setup(ruled: boolean) {
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    document.visual = createMockVisualWithDocument(document);
    document.selection = createMockSelection();
    app.activeView = createMockView({ document });
    const flat = (z: number) =>
        new SketchNode({
            document,
            plane: new Plane({ origin: new XYZ(0, 0, z), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: bspline(outline(1, 0)),
        });
    const origin = new XYZ(0, 0, 8);
    const xvec = new XYZ(100, 0, 3).normalize()!;
    const normal = xvec.cross(new XYZ(0, 100, -3.5)).normalize()!;
    const yvec = normal.cross(xvec);
    const top = new SketchNode({
        document,
        plane: new Plane({ origin, normal, xvec }),
        data: bspline(
            outline(0.7, 0).map(([x, y]) => {
                const local = new XYZ(x, y, 8 + 0.03 * x - 0.035 * y).sub(origin);
                return [local.dot(xvec), local.dot(yvec)];
            }),
        ),
    });
    const sketches = [flat(0.4), flat(3.1), top];
    for (const sketch of sketches) document.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document,
        features: [
            {
                id: "loft",
                type: "loft",
                sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                ruled,
            },
        ],
    });
    document.modelManager.addNode(body);
    return { document, body };
}

/** The real analyzer on the page's kernel, standing in for the bounded worker. */
function stubAnalyzingFactory() {
    const query = rs.fn((request: BoundedShapeQuery) => {
        const answer = request.shape.checkSelfIntersection!();
        return { ready: Promise.resolve(), canFallback: false, cancel: () => {}, take: () => answer };
    });
    rs.stubGlobal(
        "shapeFactory",
        new ShapeFactory(undefined, {
            shapeQuery: query,
            shapeOperation: () => ({
                ready: Promise.resolve(),
                take: () => Result.err("unused"),
                cancel: () => {},
            }),
        }),
    );
    return query;
}

test("the reproduced smooth loft passes checkShape but fails the analyzer, the ruled one passes both", () => {
    rs.stubGlobal("shapeFactory", new ShapeFactory());
    for (const ruled of [false, true]) {
        const { document, body } = setup(ruled);
        try {
            expect(body.shape.isOk).toBe(true);
            expect(body.shape.value.checkShape()).toBe(true);
            expect(body.shape.value.checkSelfIntersection!().value).toBe(ruled);
        } finally {
            document.dispose();
        }
    }
});

test("a rebuild rejects a self-intersecting smooth loft with actionable advice", async () => {
    const query = stubAnalyzingFactory();
    const { document, body } = setup(false);
    try {
        void body.shape;
        await DocumentRebuilds.settled(document);
        expect(query).toHaveBeenCalledTimes(1);
        expect(body.shape.isOk).toBe(false);
        expect(body.featureItems()[0].error).toContain(SMOOTH_LOFT_SELF_INTERSECTION);
        expect(body.featureItems()[0].error).toContain("Set Ruled");
    } finally {
        document.dispose();
    }
});

test("a ruled loft through the same sections is not analyzed and rebuilds cleanly", async () => {
    const query = stubAnalyzingFactory();
    const { document, body } = setup(true);
    try {
        void body.shape;
        await DocumentRebuilds.settled(document);
        expect(query).not.toHaveBeenCalled();
        expect(body.shape.isOk).toBe(true);
        expect(body.featureItems()[0]).toMatchObject({ error: undefined, warning: undefined });
    } finally {
        document.dispose();
    }
});

test("synchronous evaluation of a smooth loft keeps it with a skipped-check warning", () => {
    rs.stubGlobal("shapeFactory", new ShapeFactory());
    const { document, body } = setup(false);
    try {
        expect(body.shape.isOk).toBe(true);
        expect(body.featureItems()[0].warning).toBe(SELF_INTERSECTION_SKIPPED);
    } finally {
        document.dispose();
    }
});
