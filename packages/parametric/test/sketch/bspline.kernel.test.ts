// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, Plane, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { BSPLINE_EDGE_UNAVAILABLE, initWasm, ShapeFactory } from "@spicy3d/wasm";
import { matchEdgesAnchored } from "../../src/features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../../src/features/edgeRef";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import {
    type BSplinePoint,
    bsplineDomain,
    evaluateBSpline,
    interpolateBSpline,
    sampleBSpline,
} from "../../src/sketch/bsplineGeometry";
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

/**
 * mm²: the enclosed area a solid of the single periodic B-spline edge reports, against the sampled
 * curve. The kernel edge is the TypeScript curve (20 samples agree to 2e-14 mm), yet its extrusion
 * reads 859.5495 mm² × depth where the curve encloses 859.6258 (400-chord polygon 859.6243; the
 * Bezier-span fallback's solid 859.6258): `BRepGProp::VolumeProperties` without a tolerance
 * integrates with a fixed Gauss-point count per face, which on one periodic B-spline side face is
 * 0.009 % short — integration accuracy, not geometry.
 */
const AREA_TOLERANCE = 0.15;

const periodic: SketchData = {
    entities: [{ id: 7, type: "bspline", params: OUTLINE.flat(), parametrization: "chord", periodic: true }],
    constraints: [],
};

type FactoryClass = { bspline?: unknown };
const factoryClass = () => wasm.ShapeFactory as unknown as FactoryClass;
let removedBinding: { had: boolean; binding: unknown } | undefined;

/**
 * Removes the `ShapeFactory.bspline` binding from the loaded module — a kernel built before it —
 * until `restoreBSplineBinding`: the real factory's feature detection then takes the fallback.
 */
function stubBSplineBindingAbsent(): void {
    removedBinding = { had: Object.hasOwn(factoryClass(), "bspline"), binding: factoryClass().bspline };
    delete factoryClass().bspline;
}

function restoreBSplineBinding(): void {
    if (removedBinding?.had) factoryClass().bspline = removedBinding.binding;
    removedBinding = undefined;
}

const openWithLine: SketchData = {
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

describe("bspline edges on a kernel without the B-spline binding (stubbed absent)", () => {
    beforeEach(stubBSplineBindingAbsent);
    afterEach(restoreBSplineBinding);

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
        // the swept edges of the bspline all carry its entity seed — the id the single B-spline
        // edge gets on a kernel with the binding (how refs cross that switch: the suite below)
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const seeded = edges.map((_, i) => body.edgeIdAt(i)).filter((id) => id?.startsWith("sketch:"));
        expect(seeded).toHaveLength(OUTLINE.length);
        expect(new Set(seeded).size).toBe(1);
        expect(seeded[0]).toMatch(/:ent7$/);
    });

    test("an open bspline closed by a line makes one profile of both entities", () => {
        const { sketch, body } = setup(structuredClone(openWithLine), 5);
        expect(sketch.shape.isOk).toBe(true);
        // five fit points, not-a-knot: two spans → two Bezier edges, then the line
        expect(shapeEntityIds(sketch.data)).toEqual([1, 1, 2]);
        const profiles = sketchProfiles(sketch);
        expect(profiles.value.outerEntities).toEqual([[1, 2]]);
        expect(body.shape.isOk).toBe(true);
        const curve = interpolateBSpline(bsplineFit(openWithLine)).value;
        const area = polygonArea(sampleBSpline(curve, 400));
        expect(body.shape.value.volume()).toBeCloseTo(area * 5, 0);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        // two caps, the flat side under the line, two side faces along the bspline's spans
        expect(faces).toHaveLength(5);
    });
});

describe("bspline edges on the committed binary (its B-spline binding: one edge)", () => {
    test("the binding is present: the capability says so", () => {
        expect(typeof factoryClass().bspline).toBe("function");
        expect(shapeFactory.supportsBSplineEdges).toBe(true);
    });

    test("a periodic bspline is one closed edge: the TypeScript curve, sampled at 20 parameters", () => {
        const { sketch } = setup(periodic);
        expect(sketch.shape.isOk).toBe(true);
        const edges = sketch.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges).toHaveLength(1);
        expect(shapeEntityIds(sketch.data)).toEqual([7]);
        const kernel = edges[0].curve;
        const curve = interpolateBSpline(OUTLINE, { periodic: true }).value;
        const [first, last] = bsplineDomain(curve);
        // the kernel curve keeps the knots it was given: same domain, same parameterisation
        expect(kernel.firstParameter()).toBeCloseTo(first, 12);
        expect(kernel.lastParameter()).toBeCloseTo(last, 12);
        let deviation = 0;
        for (let i = 0; i < 20; i++) {
            const u = first + ((last - first) * (i + 0.37)) / 20;
            const at = kernel.value(u);
            const [x, y] = evaluateBSpline(curve, u, 0)[0];
            deviation = Math.max(deviation, Math.hypot(at.x - x, at.y - y), Math.abs(at.z));
        }
        kernel.dispose();
        expect(deviation).toBeLessThan(1e-6);
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
        expect(Math.abs(body.shape.value.volume() - area * 10)).toBeLessThan(AREA_TOLERANCE * 10);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const seeded = edges.map((_, i) => body.edgeIdAt(i)).filter((id) => id?.startsWith("sketch:"));
        expect(seeded).toHaveLength(1);
        expect(seeded[0]).toMatch(/:ent7$/);
    });

    test("an open bspline closed by a line makes one profile of both entities, one edge each", () => {
        const { sketch, body } = setup(structuredClone(openWithLine), 5);
        expect(sketch.shape.isOk).toBe(true);
        expect(shapeEntityIds(sketch.data)).toEqual([1, 2]);
        const profiles = sketchProfiles(sketch);
        expect(profiles.value.outerEntities).toEqual([[1, 2]]);
        expect(body.shape.isOk).toBe(true);
        const curve = interpolateBSpline(bsplineFit(openWithLine)).value;
        const area = polygonArea(sampleBSpline(curve, 400));
        expect(body.shape.value.volume()).toBeCloseTo(area * 5, 0);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        // two caps, the flat side under the line, one side face along the whole bspline
        expect(faces).toHaveLength(4);
    });
});

test("bspline points that do not interpolate fail the sketch with the reason", () => {
    const { sketch } = setup({
        entities: [{ id: 1, type: "bspline", params: [0, 0, 0, 0, 5, 5] }],
        constraints: [],
    });
    expect(sketch.shape.isOk).toBe(false);
    expect(sketch.shape.error).toContain("distinct");
});

function bsplineFit(data: SketchData): BSplinePoint[] {
    const params = data.entities[0].params;
    return Array.from(
        { length: params.length / 2 },
        (_, i) => [params[2 * i], params[2 * i + 1]] as BSplinePoint,
    );
}

describe("edge refs across the switch between the fallback spans and the single B-spline edge", () => {
    const open = openWithLine;

    afterEach(restoreBSplineBinding);

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
        stubBSplineBindingAbsent();
        const spans = build();
        expect(spans.seeded).toHaveLength(2);
        const ref = refOn(spans, spans.seeded[1]);
        expect(ref.splitPiece).toBe(true);

        restoreBSplineBinding();
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
        const single = build();
        expect(single.seeded).toHaveLength(1);
        const ref = refOn(single, single.seeded[0]);
        stubBSplineBindingAbsent();

        const spans = build();
        expect(spans.seeded).toHaveLength(2);
        const matched = matchEdgesAnchored(spans.shape, [ref], spans.ids);
        // no span keeps the whole curve's length, and none is the clear fingerprint match: the
        // feature reports the lost edge and the user re-picks
        expect(matched.isOk).toBe(false);
        expect(matched.error).toBe("Edge not found after rebuild");
    });
});
