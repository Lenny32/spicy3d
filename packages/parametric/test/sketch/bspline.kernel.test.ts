// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import { type IEdge, type IFace, type IShapeFactory, Plane, ShapeTypes, type XYZLike } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { BSPLINE_EDGE_UNAVAILABLE, initWasm, ShapeFactory } from "@spicy3d/wasm";
import { matchEdgesAnchored } from "../../src/features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../../src/features/edgeRef";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type BSplinePoint, interpolateBSpline, sampleBSpline } from "../../src/sketch/bsplineGeometry";
import { type SketchData, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const OUTLINE: BSplinePoint[] = [
    [0, 0],
    [20, -5],
    [30, 10],
    [15, 25],
    [-5, 15],
];

function polygonArea(points: BSplinePoint[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
}

function setup(data: SketchData, depth = 10, id?: string) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data, id });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth }],
    });
    doc.modelManager.addNode(body);
    return { sketch, body };
}

const periodic: SketchData = {
    entities: [{ id: 7, type: "bspline", params: OUTLINE.flat(), parametrization: "chord", periodic: true }],
    constraints: [],
};

describe("bspline edges on a kernel without the B-spline binding (the committed binary)", () => {
    test("the binding is absent: bspline() answers so, and the capability says so", () => {
        expect(shapeFactory.supportsBSplineEdges).toBe(false);
        const edge = shapeFactory.bspline(
            [
                { x: 0, y: 0, z: 0 },
                { x: 1, y: 1, z: 0 },
            ],
            [0, 1],
            [2, 2],
            1,
            false,
        );
        expect(edge.isOk).toBe(false);
        expect(edge.error).toBe(BSPLINE_EDGE_UNAVAILABLE);
    });

    test("a periodic bspline builds one Bezier edge per span, chained into a closed profile", () => {
        const { sketch } = setup(periodic);
        const shape = sketch.shape;
        expect(shape.isOk).toBe(true);
        const edges = shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges).toHaveLength(OUTLINE.length);
        expect(shapeEntityIds(sketch.data)).toEqual(Array(OUTLINE.length).fill(7));
        // every edge starts where the previous one ends, the last one on the first one's start
        for (let i = 0; i < edges.length; i++) {
            const next = edges[(i + 1) % edges.length];
            expect(edges[i].endPoint().distanceTo(next.startPoint())).toBeLessThan(1e-9);
        }
        const profiles = sketchProfiles(sketch);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer).toHaveLength(1);
        expect(profiles.value.outerEntities).toEqual([[7]]);
    });

    test("a periodic bspline extrudes into a solid of its enclosed area × depth", () => {
        const { body } = setup(periodic, 10);
        expect(body.shape.isOk).toBe(true);
        const curve = interpolateBSpline(OUTLINE, { periodic: true }).value;
        const area = polygonArea(sampleBSpline(curve, 400));
        expect(body.shape.value.volume()).toBeCloseTo(area * 10, 0);
        // the swept edges of the bspline all carry its entity seed — the id a single B-spline
        // edge gets on a kernel with the binding (how refs cross that switch: the suite below)
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const seeded = edges.map((_, i) => body.edgeIdAt(i)).filter((id) => id?.startsWith("sketch:"));
        expect(seeded).toHaveLength(OUTLINE.length);
        expect(new Set(seeded).size).toBe(1);
        expect(seeded[0]).toMatch(/:ent7$/);
    });

    test("an open bspline closed by a line makes one profile of both entities", () => {
        const data: SketchData = {
            entities: [
                {
                    id: 1,
                    type: "bspline",
                    params: [0, 0, 8, 7, 20, 11, 32, 8, 40, 0],
                    parametrization: "chord",
                },
                { id: 2, type: "line", params: [40, 0, 0, 0] },
            ],
            constraints: [],
        };
        const { sketch, body } = setup(data, 5);
        expect(sketch.shape.isOk).toBe(true);
        // five fit points, not-a-knot: two spans → two Bezier edges, then the line
        expect(shapeEntityIds(sketch.data)).toEqual([1, 1, 2]);
        const profiles = sketchProfiles(sketch);
        expect(profiles.value.outerEntities).toEqual([[1, 2]]);
        expect(body.shape.isOk).toBe(true);
        const curve = interpolateBSpline(bsplineFit(data)).value;
        const area = polygonArea(sampleBSpline(curve, 400));
        expect(body.shape.value.volume()).toBeCloseTo(area * 5, 0);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        // two caps, the flat side under the line, two side faces along the bspline's spans
        expect(faces).toHaveLength(5);
    });

    test("points that do not interpolate fail the sketch with the reason", () => {
        const { sketch } = setup({
            entities: [{ id: 1, type: "bspline", params: [0, 0, 0, 0, 5, 5] }],
            constraints: [],
        });
        expect(sketch.shape.isOk).toBe(false);
        expect(sketch.shape.error).toContain("distinct");
    });
});

function bsplineFit(data: SketchData): BSplinePoint[] {
    const params = data.entities[0].params;
    return Array.from(
        { length: params.length / 2 },
        (_, i) => [params[2 * i], params[2 * i + 1]] as BSplinePoint,
    );
}

/**
 * A kernel with a stand-in B-spline binding: an open clamped B-spline built as the one Bezier edge
 * over its poles — the same end points and end tangents, one edge, which is all edge identity needs.
 */
function withSingleEdgeBinding(): void {
    const real = shapeFactory;
    const stand = Object.create(real) as IShapeFactory;
    Object.defineProperties(stand, {
        supportsBSplineEdges: { value: true },
        bspline: { value: (poles: XYZLike[]) => real.bezier(poles) },
    });
    rs.stubGlobal("shapeFactory", stand);
}

describe("edge refs across the switch between the fallback spans and the single B-spline edge", () => {
    const open: SketchData = {
        entities: [
            { id: 1, type: "bspline", params: [0, 0, 8, 7, 20, 11, 32, 8, 40, 0], parametrization: "chord" },
            { id: 2, type: "line", params: [40, 0, 0, 0] },
        ],
        constraints: [],
    };

    afterEach(() => {
        rs.unstubAllGlobals();
    });

    /**
     * The extruded body's edges, their ids, and the indexes of the edges seeded by entity 1 — a
     * fresh build each time (the document reopened), always of the same sketch.
     */
    function build() {
        const { body } = setup(structuredClone(open), 5, "bspline-sketch");
        expect(body.shape.isOk).toBe(true);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const ids = edges.map((_, i) => body.edgeIdAt(i) ?? "");
        const seeded = ids.flatMap((id, i) => (/:ent1$/.test(id) ? [i] : []));
        return { shape: body.shape.value, edges, ids, seeded };
    }

    function refOn(built: ReturnType<typeof build>, index: number): EdgeRef {
        return captureEdgeRef(built.edges[index], built.ids[index], built.seeded.length > 1);
    }

    test("k spans → 1 edge: a ref picked on one span resolves on the single edge through the entity id", () => {
        const spans = build();
        expect(spans.seeded).toHaveLength(2);
        const ref = refOn(spans, spans.seeded[1]);
        expect(ref.splitPiece).toBe(true);

        withSingleEdgeBinding();
        const single = build();
        expect(single.seeded).toHaveLength(1);
        const [index] = single.seeded;
        // the span's length is not the curve's: the length invariant alone would demote the id
        expect(ref.kind).toBe("other");
        expect(Math.abs(single.edges[index].length() - (ref as { length: number }).length)).toBeGreaterThan(
            1,
        );

        const matched = matchEdgesAnchored(single.shape, [ref], single.ids);
        expect(matched.isOk).toBe(true);
        expect(matched.value.indexes).toEqual([index]);
        expect(matched.value.anchors[0]).toBe(ref);
    });

    test("1 edge → k spans: the whole-curve ref is ambiguous among the spans; fingerprint matching finds none", () => {
        withSingleEdgeBinding();
        const single = build();
        expect(single.seeded).toHaveLength(1);
        const ref = refOn(single, single.seeded[0]);
        rs.unstubAllGlobals();

        const spans = build();
        expect(spans.seeded).toHaveLength(2);
        const matched = matchEdgesAnchored(spans.shape, [ref], spans.ids);
        // no span keeps the whole curve's length, and none is the clear fingerprint match: the
        // feature reports the lost edge and the user re-picks
        expect(matched.isOk).toBe(false);
        expect(matched.error).toBe("Edge not found after rebuild");
    });
});
