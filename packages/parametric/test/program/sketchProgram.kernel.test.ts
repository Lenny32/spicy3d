// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The sketch and construction halves of the program engine: every tool of the sketch
 * editor and every Construct tool, driven headlessly. Each test asserts the solved data
 * the node stores — what the editor would have committed for the same picks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document } from "@spicy3d/app";
import {
    ConstructionNode,
    DOCUMENT_FORMAT_VERSION,
    DocumentMigrations,
    decodeDocumentFile,
    encodeDocumentFile,
    type IEdge,
    type IFace,
    Plane,
    ShapeTypes,
    Transaction,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { HeadlessDocumentEvaluator } from "../../../app/src/mergeEvaluator";
import type { RevolveFeatureData } from "../../src/features/feature";
import type { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram } from "../../src/program/parametricProgram";
import { type SketchInfo, type SketchReport, SketchSession } from "../../src/program/sketchProgram";
import { bsplinePointAt, interpolateBSpline } from "../../src/sketch/bsplineGeometry";
import { captureExternalRef } from "../../src/sketch/externalRef";
import {
    axisLineRefs,
    ConstraintKind,
    SKETCH_X_AXIS_ID,
    type SketchEntityData,
} from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

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

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function run(doc: TestDocument, ops: ParametricOp[]): ReturnType<typeof runParametricProgram> {
    let result: ReturnType<typeof runParametricProgram> | undefined;
    Transaction.execute(doc, "test program", () => {
        result = runParametricProgram(doc, ops);
    });
    return result!;
}

function runExpectingFailure(doc: TestDocument, ops: ParametricOp[]): string {
    let message = "";
    try {
        Transaction.execute(doc, "test program", () => {
            runParametricProgram(doc, ops);
        });
    } catch (err) {
        message = (err as Error).message;
    }
    expect(message).toMatch(/failed/);
    return message;
}

const sketchOf = (doc: TestDocument, result: ReturnType<typeof run>, id: string): SketchNode => {
    const entry = result.created.find((created) => created.id === id);
    expect(entry).toBeDefined();
    return doc.modelManager.findNodes((n) => n.id === entry!.nodeId)[0] as SketchNode;
};

const nodeById = (doc: TestDocument, id: string) => doc.modelManager.findNodes((n) => n.id === id)[0];
const report = (result: ReturnType<typeof run>, key: string) => result.results[key] as SketchReport;
const entity = (sketch: SketchNode, id: number) => sketch.data.entities.find((e) => e.id === id)!;
const length = (e: SketchEntityData) => Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1]);
/** The resolved geometry a construct or constructionInfo op reports. */
const geometryOf = (result: ReturnType<typeof run>, key: string) =>
    (result.results[key] as { geometry: { origin: number[]; point: number[] } }).geometry;
const kinds = (sketch: SketchNode) => sketch.data.constraints.map((c) => ConstraintKind[c.kind]);

const square = (size: number): ParametricOp => ({
    op: "sketch",
    id: "s1",
    actions: [
        {
            action: "rectangle",
            corners: [
                [0, 0],
                [size, size],
            ],
            name: "r",
        },
    ],
});

describe("sketch entities", () => {
    test("every entity type is created, ids follow the list and construction survives", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 10, 0], construction: true },
                    { type: "circle", params: [30, 0, 4] },
                    { type: "arc", params: [0, 20, 5, 20, 0, 25] },
                    { type: "point", params: [7, 7] },
                    { type: "ellipse", params: [50, 0, 60, 0, 50, 5] },
                    {
                        type: "spline",
                        points: [
                            [0, 40],
                            [10, 45],
                            [20, 40],
                        ],
                    },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        expect(sketch.data.entities.map((e) => [e.id, e.type])).toEqual([
            [1, "line"],
            [2, "circle"],
            [3, "arc"],
            [4, "point"],
            [5, "ellipse"],
            [6, "spline"],
        ]);
        expect(entity(sketch, 1).construction).toBe(true);
        expect(entity(sketch, 2).construction).toBeUndefined();
        // the spline stores its endpoints first, then the interior interpolation point
        expect(entity(sketch, 6).params).toEqual([0, 40, 20, 40, 10, 45]);
        // arcs and ellipses carry their structural equations, as when drawn in the editor
        expect(kinds(sketch)).toEqual(["PointOnArc", "Perpendicular"]);
        expect(report(result, "s1").entities.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("a bspline is one entity through every point; periodic closes it without a repeated point", () => {
        const doc = newDoc();
        const outline: [number, number][] = [
            [0, 0],
            [20, -5],
            [30, 10],
            [15, 25],
            [-5, 15],
        ];
        const curve = interpolateBSpline(outline, { periodic: true }).value;
        const onCurve = bsplinePointAt(curve, (curve.parameters[1] + curve.parameters[2]) / 2);
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    // the way the agent of the issue wrote it: first point repeated as the last
                    { type: "bspline", points: [...outline, outline[0]], periodic: true, name: "outline" },
                    { type: "bspline", params: [40, 0, 50, 5, 60, 0], parametrization: "centripetal" },
                    { type: "point", params: onCurve },
                    { type: "line", params: [60, 0, 70, 10] },
                ],
                constraints: [
                    {
                        kind: "Coincident",
                        points: [
                            { entity: 4, point: 0 },
                            { entity: 2, point: 2 },
                        ],
                    },
                    { kind: "Tangent", entities: [4, 2] },
                    { kind: "PointOn", points: [{ entity: 3, point: 0 }], entities: ["outline"] },
                ],
            },
            { op: "extrude", id: "e1", sketch: "s1", depth: 10 },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const outlineEntity = entity(sketch, 1);
        expect(outlineEntity).toMatchObject({
            id: 1,
            type: "bspline",
            parametrization: "chord",
            periodic: true,
        });
        // five fit points (the repetition dropped), where they were given
        expect(outlineEntity.params).toHaveLength(10);
        outlineEntity.params.forEach((value, i) => expect(value).toBeCloseTo(outline.flat()[i], 6));
        expect(entity(sketch, 2).parametrization).toBe("centripetal");
        expect(kinds(sketch)).toEqual(["P2PCoincident", "TangentLineBSpline", "PointOnBSpline"]);
        // the tangent names the bspline end the line starts on
        expect(sketch.data.constraints[1].refs[2]).toEqual({ entityId: 2, pointIndex: 2 });
        expect(report(result, "s1").names["outline"]).toBe(1);
        const body = nodeById(doc, result.created.find((c) => c.id === "e1")!.nodeId) as ParametricBodyNode;
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(5000);
    });

    test.each([
        [
            {
                type: "bspline",
                points: [
                    [0, 0],
                    [5, 5],
                    [0, 0],
                ],
            },
            "periodic: true",
        ],
        [
            {
                type: "bspline",
                points: [
                    [0, 0],
                    [5, 5],
                ],
                periodic: true,
            },
            "at least three",
        ],
        [
            {
                type: "bspline",
                points: [
                    [0, 0],
                    [5, 5],
                ],
                parametrization: "arc",
            },
            'unknown parametrization "arc"',
        ],
        [
            {
                type: "spline",
                points: [
                    [0, 0],
                    [5, 5],
                    [0, 0],
                ],
            },
            "use a periodic bspline",
        ],
    ])("a bad curve %j names the fix", (spec, message) => {
        const failure = runExpectingFailure(newDoc(), [
            { op: "sketch", id: "s1", entities: [spec as never] },
        ]);
        expect(failure).toContain(message);
    });

    test("a constrained arc keeps its end on its circle", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "arc", params: [0, 0, 10, 0, 0, 10] }],
                constraints: [{ kind: "Radius", entities: [1], datum: 20 }],
            },
        ]);
        const [cx, cy, sx, sy, ex, ey] = entity(sketchOf(doc, result, "s1"), 1).params;
        expect(Math.hypot(sx - cx, sy - cy)).toBeCloseTo(20, 6);
        expect(Math.hypot(ex - cx, ey - cy)).toBeCloseTo(20, 6);
    });

    test("a bad entity names its params", () => {
        const message = runExpectingFailure(newDoc(), [
            { op: "sketch", id: "s1", entities: [{ type: "ellipse", params: [0, 0, 1] }] },
        ]);
        expect(message).toContain("a ellipse needs 6 finite params");
    });
});

describe("constraints", () => {
    test("constraints written by entities derive their refs; angles are degrees", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 10, 1], name: "a" },
                    { type: "circle", params: [5, 8, 3], name: "c" },
                ],
                constraints: [
                    {
                        kind: "Coincident",
                        points: [
                            { entity: "a", point: 0 },
                            { entity: "origin", point: 0 },
                        ],
                    },
                    { kind: "Angle", entities: ["xAxis", "a"], datum: 30 },
                    { kind: "Distance", entities: ["a"], datum: 20 },
                    { kind: "Tangent", entities: ["a", "c"] },
                    { kind: "Radius", entities: ["c"], datum: 4, name: "r" },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const [x1, y1, x2, y2] = entity(sketch, 1).params;
        expect([x1, y1]).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6)]);
        expect((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI).toBeCloseTo(30, 4);
        expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(20, 4);
        expect(kinds(sketch)).toEqual([
            "P2PCoincident",
            "Angle",
            "P2PDistance",
            "TangentLineCircle",
            "Radius",
        ]);
        expect(report(result, "s1").constraintNames).toEqual({ r: 5 });
    });

    test("an unsatisfiable sketch fails with the conflicting constraints and leaves nothing behind", () => {
        const doc = newDoc();
        const message = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "line", params: [0, 0, 10, 0] }],
                constraints: [
                    { kind: "Distance", entities: [1], datum: 10 },
                    { kind: "Distance", entities: [1], datum: 20 },
                ],
            },
        ]);
        expect(message).toContain("does not solve");
        expect(doc.modelManager.findNodes(() => true)).toEqual([]);
    });

    test("an unknown kind names the valid ones", () => {
        const message = runExpectingFailure(newDoc(), [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "line", params: [0, 0, 1, 0] }],
                constraints: [{ kind: "Nope", refs: [] }],
            },
        ]);
        expect(message).toContain("unknown constraint kind");
        expect(message).toContain("EqualAngle");
    });
});

describe("sketch actions", () => {
    test("rectangle and polygon build their constrained loops", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                actions: [
                    {
                        action: "rectangle",
                        corners: [
                            [0, 0],
                            [40, 20],
                        ],
                        name: "r",
                    },
                    { action: "polygon", center: [100, 0], rim: [110, 0], sides: 6, name: "hex" },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const names = report(result, "s1").names;
        expect(Object.keys(names)).toEqual(
            expect.arrayContaining(["r.top", "r.left", "hex.circle", "hex.5"]),
        );
        expect(entity(sketch, names["hex.circle"]).construction).toBe(true);
        expect(kinds(sketch).filter((k) => k === "Horizontal")).toHaveLength(2);
        expect(kinds(sketch).filter((k) => k === "EqualLength")).toHaveLength(5);
        // a closed 40 x 20 loop plus the hexagon: the sketch extrudes into two solids
        run(doc, [{ op: "extrude", id: "b1", sketch: "s1", depth: 5 }]);
    });

    test("setDatum drives a named dimension in a later op of the same call", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "line", params: [0, 0, 10, 0] }],
                constraints: [{ kind: "Distance", entities: [1], datum: 10, name: "len" }],
            },
            {
                op: "editSketch",
                sketch: "s1",
                actions: [{ action: "setDatum", constraint: "len", value: 25 }],
            },
        ]);
        expect(length(entity(sketchOf(doc, result, "s1"), 1))).toBeCloseTo(25, 5);
    });

    test("trim removes the picked piece between intersections", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 30, 0] },
                    { type: "line", params: [10, -5, 10, 5] },
                    { type: "line", params: [20, -5, 20, 5] },
                ],
                actions: [{ action: "trim", entity: 1, at: [15, 0] }],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const horizontal = sketch.data.entities.filter((e) => e.params[1] === 0 && e.params[3] === 0);
        expect(horizontal.map((e) => e.params)).toEqual([
            [0, 0, 10, 0],
            [20, 0, 30, 0],
        ]);
        expect(sketch.data.entities.some((e) => e.id === 1)).toBe(false);
    });

    test("split, extend and offset edit lines like the editor tools", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 10, 0] },
                    { type: "line", params: [30, -5, 30, 5] },
                    { type: "line", params: [0, 20, 10, 20] },
                ],
                actions: [
                    { action: "extend", entity: 1, to: 2 },
                    { action: "offset", entity: 3, distance: 5, name: "copy" },
                    { action: "split", entity: 3, at: [4, 20] },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const params = sketch.data.entities.map((e) => e.params.map((x) => Math.round(x * 1e6) / 1e6));
        expect(params).toContainEqual([0, 0, 30, 0]);
        // + is left of the line direction: the copy lands above
        expect(params).toContainEqual([0, 25, 10, 25]);
        expect(params).toContainEqual([0, 20, 4, 20]);
        expect(params).toContainEqual([4, 20, 10, 20]);
        expect(report(result, "s1").names["copy"]).toBeGreaterThan(3);
    });

    test("paste and expression offset a periodic 64-point footprint into a loft section", () => {
        const doc = newDoc();
        doc.variables.setItems([
            { id: "flare", name: "flare", expression: "0.7", type: "unitless" },
            { id: "height", name: "skirt_h", expression: "3", type: "length" },
        ]);
        const points: [number, number][] = Array.from({ length: 64 }, (_, i) => {
            const angle = (2 * Math.PI * i) / 64;
            return [30 * Math.cos(angle), 50 * Math.sin(angle)];
        });
        const result = run(doc, [
            { op: "sketch", id: "s_fp", entities: [{ type: "bspline", points, periodic: true }] },
            {
                op: "construct",
                id: "pl_top",
                definition: { kind: "plane-offset", source: "XY", distance: "skirt_h" },
            },
            {
                op: "sketch",
                id: "s_top",
                plane: { construction: "pl_top" },
                actions: [
                    { action: "paste", from: "s_fp", entities: [1] },
                    { action: "offset", entity: 1, distance: "flare*skirt_h", name: "outline" },
                    { action: "remove", entities: [1] },
                ],
            },
            { op: "loft", id: "skirt", sections: ["s_fp", "s_top"] },
        ]);
        const top = sketchOf(doc, result, "s_top");
        expect(top.data.entities).toHaveLength(1);
        const outline = top.data.entities[0];
        expect(outline.type).toBe("bspline");
        expect(outline.periodic).toBe(true);
        expect(outline.id).toBe(report(result, "s_top").names["outline"]);
        expect(outline.params[0]).toBeCloseTo(32.1, 3);
        const body = nodeById(
            doc,
            result.created.find((c) => c.id === "skirt")!.nodeId,
        ) as ParametricBodyNode;
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined]);
        const shape = body.shape.unchecked()!;
        expect(shape.shapeType).toBe(ShapeTypes.solid);
        expect(shape.checkShape()).toBe(true);
        const bounds = shape.boundingBox();
        expect(bounds.max.z - bounds.min.z).toBeCloseTo(3, 3);
    });

    test("offset expression errors name the action and roll back the sketch", () => {
        const doc = newDoc();
        const error = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    {
                        type: "bspline",
                        points: [
                            [0, 0],
                            [10, 0],
                        ],
                    },
                ],
                actions: [{ action: "offset", entity: 1, distance: "missing" }],
            },
        ]);
        expect(error).toContain('sketch action 1 ("offset") failed');
        expect(error).toContain("missing");
        expect(doc.modelManager.findNodes((node) => node instanceof SketchNode)).toEqual([]);
    });

    test.each([undefined, null, ""])("offset without a usable distance (%s) names the field", (distance) => {
        const doc = newDoc();
        const error = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "line", params: [0, 0, 10, 0] }],
                actions: [{ action: "offset", entity: 1, distance } as never],
            },
        ]);
        expect(error).toContain('"distance" must be a finite number or a length expression');
    });

    test("move, rotate and mirror transform entities; mirror copies stay symmetric", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [{ type: "line", params: [1, 1, 5, 1] }],
                actions: [
                    { action: "move", entities: [1], delta: [1, 2] },
                    { action: "rotate", entities: [1], center: [2, 3], angle: 90 },
                    { action: "mirror", entities: [1], axis: "yAxis" },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        const rounded = sketch.data.entities.map((e) => e.params.map((x) => Math.round(x * 1e6) / 1e6));
        // moved to (2,3)-(6,3), rotated about (2,3) to (2,3)-(2,7), mirrored across the Y axis
        expect(rounded).toEqual([
            [2, 3, 2, 7],
            [-2, 3, -2, 7],
        ]);
        expect(kinds(sketch)).toEqual(["Symmetric", "Symmetric"]);
    });

    test("paste copies entities and their internal constraints from another sketch", () => {
        const doc = newDoc();
        const result = run(doc, [
            square(10),
            { op: "sketch", id: "s2", plane: "YZ", entities: [{ type: "point", params: [0, 0] }] },
            {
                op: "editSketch",
                sketch: "s2",
                actions: [{ action: "paste", from: "s1", entities: [1, 2, 3, 4], delta: [50, 0] }],
            },
        ]);
        const target = sketchOf(doc, result, "s2");
        expect(target.data.entities).toHaveLength(5);
        expect(kinds(target).filter((k) => k === "P2PCoincident")).toHaveLength(4);
        expect(Math.min(...target.data.entities.slice(1).map((e) => e.params[0]))).toBeCloseTo(50, 6);
    });

    test("remove drops the entity with its constraints; structural constraints are protected", () => {
        const doc = newDoc();
        const result = run(doc, [
            square(10),
            { op: "editSketch", sketch: "s1", actions: [{ action: "remove", entities: ["r.top"] }] },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        expect(sketch.data.entities).toHaveLength(3);
        expect(sketch.data.constraints.every((c) => c.refs.every((r) => r.entityId !== 1))).toBe(true);

        const message = runExpectingFailure(doc, [
            { op: "sketch", id: "s2", entities: [{ type: "arc", params: [0, 0, 1, 0, 0, 1] }] },
            { op: "editSketch", sketch: "s2", actions: [{ action: "remove", constraints: [1] }] },
        ]);
        expect(message).toContain("structural");
    });

    test("setConstruction and movePoint", () => {
        const doc = newDoc();
        const result = run(doc, [
            square(10),
            {
                op: "editSketch",
                sketch: "s1",
                actions: [
                    { action: "setConstruction", entities: ["r.left"] },
                    { action: "movePoint", entity: "r.top", point: 1, to: [20, 15] },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        expect(entity(sketch, 4).construction).toBe(true);
        // the corner drags the coincident right edge along; H/V keep the rectangle square-cornered
        const [, , x2, y2] = entity(sketch, 1).params;
        expect([x2, y2].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([20, 15]);
        expect(entity(sketch, 2).params[0]).toBeCloseTo(20, 6);
    });

    test("autoConstrain infers coincidences and H/V; autoDimension removes the size freedoms", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 10, 0] },
                    { type: "line", params: [10, 0, 10, 10] },
                ],
                actions: [{ action: "autoConstrain" }],
            },
        ]);
        const sketch = sketchOf(doc, result, "s1");
        expect(kinds(sketch)).toEqual(expect.arrayContaining(["P2PCoincident", "Horizontal", "Vertical"]));
        const before = report(result, "s1").dofs;

        const second = run(doc, [
            { op: "editSketch", id: "e", sketch: sketch.id, actions: [{ action: "autoDimension" }] },
        ]);
        expect(report(second, "e").appliedDimensions!.length).toBeGreaterThan(0);
        expect(report(second, "e").dofs).toBeLessThan(before);
    });
});

describe("sketchInfo", () => {
    test("reports the effective clockwise expression and preserves it on setDatum", () => {
        const doc = newDoc();
        doc.variables.setItems([{ id: "tilt", name: "tilt", expression: "30", type: "angle" }]);
        const start = { entityId: 1, pointIndex: 0 },
            end = { entityId: 1, pointIndex: 1 };
        const node = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "line", params: [0, 0, 5 * Math.sqrt(3), -5] }],
                constraints: [
                    { id: 2, kind: ConstraintKind.Fix, refs: [start], datums: [0, 0] },
                    { id: 3, kind: ConstraintKind.P2PDistance, refs: [start, end], datum: 10 },
                    {
                        id: 4,
                        kind: ConstraintKind.Angle,
                        refs: [...axisLineRefs(SKETCH_X_AXIS_ID), start, end],
                        datum: "tilt",
                        angleSide: -1,
                    },
                ],
            },
        });
        doc.modelManager.addNode(node);
        const read = () =>
            run(doc, [{ op: "sketchInfo", id: "info", sketch: node.id }]).results["info"] as SketchInfo;
        expect(read().constraints.find((c) => c.id === 4)).toMatchObject({
            datum: "tilt",
            angleSide: -1,
            effectiveDatum: expect.closeTo(-30, 6),
        });
        run(doc, [
            {
                op: "editSketch",
                sketch: node.id,
                actions: [{ action: "setDatum", constraint: 4, value: "tilt" }],
            },
        ]);
        expect(read().constraints.find((c) => c.id === 4)).toMatchObject({
            datum: "tilt",
            angleSide: -1,
            effectiveDatum: expect.closeTo(-30, 6),
        });
        expect(node.data.entities[0].params[3]).toBeCloseTo(-5, 6);
        run(doc, [
            {
                op: "editSketch",
                sketch: node.id,
                actions: [{ action: "setDatum", constraint: 4, value: "tilt + 15" }],
            },
        ]);
        expect(read().constraints.find((c) => c.id === 4)).toMatchObject({
            datum: "tilt + 15",
            angleSide: 1,
            effectiveDatum: expect.closeTo(45, 6),
        });
        doc.history.undo();
        expect(read().constraints.find((c) => c.id === 4)).toMatchObject({
            datum: "tilt",
            angleSide: -1,
            effectiveDatum: expect.closeTo(-30, 6),
        });
        doc.history.redo();
        expect(read().constraints.find((c) => c.id === 4)).toMatchObject({
            datum: "tilt + 15",
            angleSide: 1,
            effectiveDatum: expect.closeTo(45, 6),
        });
    });

    test.each([
        { initial: 20, value: -40, expected: -40 },
        { initial: "pcb_angle", value: "pcb_angle + 45", expected: 14.5 },
    ])("reports signed datums and orientation after setDatum ($value)", ({ initial, value, expected }) => {
        const doc = newDoc();
        doc.variables.setItems([{ id: "pcb", name: "pcb_angle", expression: "-30.5", type: "angle" }]);
        const result = run(doc, [
            {
                op: "sketch",
                id: "t1",
                plane: "XY",
                entities: [{ type: "line", params: [100, 0, 110, 0] }],
                constraints: [
                    { kind: "Fix", points: [{ entity: 1, point: 0 }], datums: [100, 0] },
                    { kind: "Distance", entities: [1], datum: 10 },
                    { kind: "Angle", entities: ["xAxis", 1], datum: initial },
                ],
            },
            { op: "editSketch", sketch: "t1", actions: [{ action: "setDatum", constraint: 3, value }] },
            { op: "sketchInfo", id: "info", sketch: "t1" },
        ]);
        const info = result.results["info"] as SketchInfo;
        expect(info.solve).toMatch(/^Ok/);
        const angle = info.constraints.find((c) => c.kind === "Angle")!;
        expect(angle.datum).toEqual(typeof value === "number" ? expect.closeTo(value, 6) : value);
        const [x1, y1, x2, y2] = info.entities[0].params;
        expect((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI).toBeCloseTo(expected, 6);
        expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(10, 6);
    });

    test("reads a sketch back in display units", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "sketch",
                id: "s1",
                entities: [
                    { type: "line", params: [0, 0, 10, 5] },
                    { type: "arc", params: [0, 0, 5, 0, 0, 5] },
                ],
                constraints: [{ kind: "Angle", entities: ["xAxis", 1], datum: 45 }],
            },
            { op: "sketchInfo", id: "info", sketch: "s1" },
        ]);
        const info = result.results["info"] as SketchInfo;
        expect(info.entities.map((e) => e.points.length)).toEqual([2, 3]);
        const angle = info.constraints.find((c) => c.kind === "Angle")!;
        expect(angle.datum).toBeCloseTo(45, 6);
        expect(info.constraints.find((c) => c.kind === "PointOnArc")!.structural).toBe(true);
        expect(info.solve).toMatch(/^Ok/);
        expect(info.planeSource).toBe("fixed");
    });
});

describe("external references", () => {
    function plateWithTopSketch(doc: TestDocument) {
        const plate = run(doc, [square(40), { op: "extrude", id: "b1", sketch: "s1", depth: 10 }]);
        const body = nodeById(doc, plate.created.find((c) => c.id === "b1")!.nodeId) as ParametricBodyNode;
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        return { body, top };
    }

    test("a face sketch brings the face boundary in as reference externals", () => {
        const doc = newDoc();
        const { body, top } = plateWithTopSketch(doc);
        const result = run(doc, [{ op: "sketch", id: "s2", plane: { nodeId: body.id, faceIndex: top } }]);
        const refs = sketchOf(doc, result, "s2").data.externalRefs!;
        expect(refs).toHaveLength(4);
        expect(refs.every((ref) => ref.role === "reference" && ref.entityId <= -100)).toBe(true);
    });

    test("projected edges constrain the sketch and switch roles", () => {
        const doc = newDoc();
        const { body } = plateWithTopSketch(doc);
        const edges = body.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[];
        const bottom = edges.findIndex(
            (edge) => Math.abs(edge.startPoint().z) < 1e-6 && Math.abs(edge.endPoint().z) < 1e-6,
        );
        const result = run(doc, [
            {
                op: "sketch",
                id: "s2",
                entities: [{ type: "point", params: [3, 3] }],
                actions: [
                    { action: "projectEdges", nodeId: body.id, edgeIndexes: [bottom], names: ["edge"] },
                    {
                        action: "add",
                        constraints: [
                            { kind: "PointOn", points: [{ entity: 1, point: 0 }], entities: ["edge"] },
                        ],
                    },
                    { action: "setExternalRole", entities: ["edge"], role: "profile" },
                ],
            },
        ]);
        const sketch = sketchOf(doc, result, "s2");
        const [ref] = sketch.data.externalRefs!;
        expect(ref.nodeId).toBe(body.id);
        expect(ref.role).toBe("profile");
        expect(ref.pinned).toBe(true);
        expect(kinds(sketch)).toEqual(["PointOnLine"]);
        expect(sketch.data.refPositions).toEqual({ [body.id]: body.features.length });
    });

    test("an edge off the sketch plane is refused", () => {
        const doc = newDoc();
        const { body } = plateWithTopSketch(doc);
        const edges = body.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[];
        const vertical = edges.findIndex((edge) => Math.abs(edge.startPoint().z - edge.endPoint().z) > 1);
        const message = runExpectingFailure(doc, [
            {
                op: "sketch",
                id: "s2",
                actions: [{ action: "projectEdges", nodeId: body.id, edgeIndexes: [vertical] }],
            },
        ]);
        expect(message).toContain("does not lie in the sketch plane");
    });
});

describe("construction geometry", () => {
    test("a sketch on an offset plane follows the plane when it is edited", () => {
        const doc = newDoc();
        const result = run(doc, [
            { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 25 } },
            {
                op: "sketch",
                id: "s1",
                plane: { construction: "p1" },
                entities: [{ type: "circle", params: [0, 0, 5] }],
            },
        ]);
        const plane = result.created.find((c) => c.id === "p1")!;
        expect(nodeById(doc, plane.nodeId)).toBeInstanceOf(ConstructionNode);
        expect(geometryOf(result, "p1").origin).toEqual([0, 0, 25]);
        const sketch = sketchOf(doc, result, "s1");
        expect(sketch.plane.origin.z).toBeCloseTo(25, 6);
        expect(sketch.constructionPlaneRef).toEqual({ kind: "datum", nodeId: plane.nodeId });

        run(doc, [
            {
                op: "editConstruction",
                node: plane.nodeId,
                definition: { kind: "plane-offset", source: "XY", distance: 40 },
            },
        ]);
        const box = sketch.shape.unchecked()!.boundingBox();
        expect(box.min.z).toBeCloseTo(40, 1);
    });

    test("a revolve around a construction axis stores the associative reference", () => {
        const doc = newDoc();
        const result = run(doc, [
            {
                op: "construct",
                id: "a1",
                definition: {
                    kind: "axis-two-points",
                    first: { point: [0, 0, 0] },
                    second: { point: [0, 1, 0] },
                },
            },
            { op: "sketch", id: "s1", entities: [{ type: "circle", params: [20, 0, 5] }] },
            { op: "revolve", id: "b1", sketch: "s1", axis: { construction: "a1" } },
        ]);
        const body = nodeById(doc, result.created.find((c) => c.id === "b1")!.nodeId) as ParametricBodyNode;
        const feature = body.features[0] as RevolveFeatureData;
        expect(feature.constructionAxisRef?.kind).toBe("datum");
        expect(feature.axis.direction).toEqual({ x: 0, y: 1, z: 0 });
        expect(body.featureItems().every((item) => item.error === undefined)).toBe(true);
        const box = body.shape.unchecked()!.boundingBox();
        expect(box.max.x).toBeCloseTo(25, 1);
        expect(box.min.x).toBeCloseTo(-25, 1);
    });

    test("a revolve around a sketch's construction line tracks the edge", () => {
        const doc = newDoc();
        const result = run(doc, [
            { op: "sketch", id: "axis", entities: [{ type: "line", params: [0, -10, 0, 10] }] },
            { op: "sketch", id: "s1", entities: [{ type: "circle", params: [20, 0, 5] }] },
            { op: "revolve", id: "b1", sketch: "s1", axis: { nodeId: "axis", edgeIndex: 0 } },
        ]);
        const body = nodeById(doc, result.created.find((c) => c.id === "b1")!.nodeId) as ParametricBodyNode;
        const feature = body.features[0] as RevolveFeatureData;
        expect(feature.axisSource?.nodeId).toBe(sketchOf(doc, result, "axis").id);
        expect(body.featureItems().every((item) => item.error === undefined)).toBe(true);
    });

    test("construction refs to shapes, snaps and datums are captured", () => {
        const doc = newDoc();
        const plate = run(doc, [square(40), { op: "extrude", id: "b1", sketch: "s1", depth: 10 }]);
        const body = nodeById(doc, plate.created.find((c) => c.id === "b1")!.nodeId) as ParametricBodyNode;
        const faces = body.shape.unchecked()!.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.findIndex((face) => face.normal(0, 0)[1].z > 1 - 1e-6);
        const result = run(doc, [
            {
                op: "construct",
                id: "p",
                definition: { kind: "plane-offset", source: { nodeId: body.id, face: top }, distance: 5 },
            },
            {
                op: "construct",
                id: "m",
                definition: { kind: "plane-midplane", first: "XY", second: { datum: "p" } },
            },
            {
                op: "construct",
                id: "q",
                definition: { kind: "point-three-planes", first: { datum: "m" }, second: "YZ", third: "ZX" },
            },
            { op: "constructionInfo", id: "info", node: "q" },
        ]);
        expect(geometryOf(result, "p").origin[2]).toBeCloseTo(15, 6);
        expect(geometryOf(result, "info").point.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 0, 7.5]);
    });

    test("plane distances take expressions of variables and follow them", () => {
        const doc = newDoc();
        doc.variables.setItems([{ id: "v1", name: "sec_x_1", expression: "12", type: "length" }]);
        const result = run(doc, [
            {
                op: "construct",
                id: "p1",
                definition: { kind: "plane-offset", source: "YZ", distance: "sec_x_1" },
            },
            {
                op: "sketch",
                id: "s1",
                plane: { construction: "p1" },
                entities: [{ type: "circle", params: [0, 0, 5] }],
            },
        ]);
        expect(geometryOf(result, "p1").origin).toEqual([12, 0, 0]);
        const plane = nodeById(doc, result.created.find((c) => c.id === "p1")!.nodeId) as ConstructionNode;
        expect(plane.definition).toMatchObject({ distance: "sec_x_1" });
        const sketch = sketchOf(doc, result, "s1");

        doc.variables.setItems([{ id: "v1", name: "sec_x_1", expression: "30", type: "length" }]);

        const geometry = plane.geometry.unchecked()!;
        expect(geometry.kind === "plane" && geometry.plane.origin.x).toBeCloseTo(30, 6);
        expect(sketch.shape.unchecked()!.boundingBox().min.x).toBeCloseTo(30, 1);

        const edited = run(doc, [
            {
                op: "editConstruction",
                node: plane.id,
                definition: { kind: "plane-offset", source: "YZ", distance: "sec_x_1 * 2 + 1 cm" },
            },
        ]);
        expect(geometryOf(edited, plane.id).origin).toEqual([70, 0, 0]);
    });

    test.each([
        [
            "construct",
            { kind: "plane-offset", source: "YZ", distance: "sec_x_2" },
            '"distance" must be a length or an expression of length variables, got "sec_x_2"',
        ],
        [
            "construct",
            { kind: "plane-offset", source: "YZ", distance: "tilt" },
            '"distance" must be a length or an expression of length variables, got "tilt" (Dimension mismatch',
        ],
        [
            "construct",
            {
                kind: "plane-angle",
                axis: { axis: { direction: [1, 0, 0] } },
                baseline: "XY",
                angle: "sec_x_1",
            },
            '"angle" must be an angle or an expression of angle variables, got "sec_x_1"',
        ],
        [
            "construct",
            {
                kind: "plane-three-points",
                first: { point: [0, 0, 0] },
                second: { point: [1, 0, 0] },
                third: { point: [0, 1, 0] },
                offset: "",
            },
            '"offset" must be a length or an expression of length variables, got ""',
        ],
        [
            "construct",
            {
                kind: "point-along-path",
                path: { axis: { direction: [1, 0, 0] } },
                position: { kind: "distance", value: "nope" },
            },
            '"position.value" must be a length or an expression of length variables, got "nope"',
        ],
        [
            "editConstruction",
            { kind: "plane-offset", source: "YZ", distance: "sec_x_2" },
            '"distance" must be a length or an expression of length variables, got "sec_x_2"',
        ],
    ])("%s with a bad parameter fails up front: %j", (op, definition, message) => {
        const doc = newDoc();
        doc.variables.setItems([
            { id: "v1", name: "sec_x_1", expression: "12", type: "length" },
            { id: "v2", name: "tilt", expression: "30", type: "angle" },
        ]);
        const base = run(doc, [
            { op: "construct", id: "p0", definition: { kind: "plane-offset", source: "XY", distance: 1 } },
        ]);
        const nodes = doc.modelManager.findNodes(() => true).length;
        const failure =
            op === "construct"
                ? runExpectingFailure(doc, [{ op: "construct", id: "p", definition }])
                : runExpectingFailure(doc, [
                      { op: "editConstruction", node: base.created[0].nodeId, definition },
                  ]);
        expect(failure).toContain(message);
        expect(failure).not.toContain("NaN in XYZ");
        expect(doc.modelManager.findNodes(() => true)).toHaveLength(nodes);
    });

    test("an invalid definition fails the program", () => {
        const doc = newDoc();
        const message = runExpectingFailure(doc, [
            { op: "construct", id: "p", definition: { kind: "plane-midplane", first: "XY", second: "XY" } },
        ]);
        expect(message).toContain("does not evaluate");
        expect(doc.modelManager.findNodes(() => true)).toEqual([]);
    });
});

test("control NURBS authoring and later settings edit preserve pole and entity identity", () => {
    const doc = newDoc();
    const created = run(doc, [
        {
            op: "sketch",
            id: "control",
            entities: [
                {
                    type: "bspline",
                    name: "arc",
                    poles: [
                        [1, 0],
                        [1, 1],
                        [0, 1],
                    ],
                    degree: 2,
                    knots: [0, 1],
                    multiplicities: [3, 3],
                    weights: [1, Math.SQRT1_2, 1],
                },
            ],
        },
    ]);
    const sketch = sketchOf(doc, created, "control");
    const original = sketch.data.entities[0];
    expect(original.params).toEqual([1, 0, 1, 1, 0, 1]);
    expect(original.parametrization).toBeUndefined();
    const next = JSON.parse(
        JSON.stringify([
            {
                op: "editSketch",
                sketch: sketch.id,
                actions: [
                    {
                        action: "setBSpline",
                        entity: original.id,
                        weights: [1, 1, 1],
                    },
                    { action: "movePoint", entity: original.id, point: 1, to: [2, 2] },
                ],
            },
        ]),
    ) as ParametricOp[];
    run(doc, next);
    expect(sketch.data.entities[0]).toMatchObject({
        id: original.id,
        params: [1, 0, 2, 2, 0, 1],
        control: { weights: [1, 1, 1] },
    });
    doc.history.undo();
    expect(sketch.data.entities[0]).toEqual(original);
    doc.history.redo();
    expect(sketch.data.entities[0].control?.weights).toEqual([1, 1, 1]);
    const previous = sketch.data;
    expect(
        runExpectingFailure(doc, [
            {
                op: "editSketch",
                sketch: sketch.id,
                actions: [
                    {
                        action: "setBSpline",
                        entity: original.id,
                        weights: [0, 1, 1],
                    },
                ],
            },
        ]),
    ).toMatch(/positive finite/);
    expect(sketch.data).toEqual(previous);
});

test("last-point refs close an associative B-spline offset and follow distance changes", () => {
    const doc = newDoc();
    const points: [number, number][] = Array.from({ length: 10 }, (_, i) => [i * 3, Math.sin(i / 3) * 2]);
    const result = run(doc, [
        {
            op: "sketch",
            id: "wall",
            entities: [{ type: "bspline", points, name: "outer" }],
            constraints: [{ kind: "Block", entities: ["outer"] }],
            actions: [
                { action: "offset", entity: "outer", distance: 1, associative: true, name: "inner" },
                {
                    action: "add",
                    entities: [
                        { type: "line", params: [0, 0, 0, 1], name: "startCap" },
                        { type: "line", params: [27, 0, 27, 1], name: "endCap" },
                    ],
                    constraints: [
                        {
                            kind: "Coincident",
                            points: [
                                { entity: "outer", point: 0 },
                                { entity: "startCap", point: 0 },
                            ],
                        },
                        {
                            kind: "Coincident",
                            points: [
                                { entity: "inner", point: 0 },
                                { entity: "startCap", point: -1 },
                            ],
                        },
                        {
                            kind: "Coincident",
                            refs: [
                                { entity: "outer", point: -1 },
                                { entity: "endCap", point: 0 },
                            ],
                        },
                        {
                            kind: "Coincident",
                            refs: [
                                { entity: "inner", point: -1 },
                                { entity: "endCap", point: -1 },
                            ],
                        },
                    ],
                },
            ],
        },
        { op: "extrude", id: "solid", sketch: "wall", depth: 2 },
    ]);
    const sketch = sketchOf(doc, result, "wall");
    const { outer, inner, endCap } = report(result, "wall").names;
    const target = entity(sketch, inner);
    expect(target.params.length / 2).toBeGreaterThan(points.length);
    const endJoin = sketch.data.constraints.find(
        (c) =>
            c.kind === ConstraintKind.P2PCoincident &&
            c.refs[0].entityId === inner &&
            c.refs[1].entityId === endCap,
    );
    expect(endJoin?.refs).toEqual([
        { entityId: inner, pointIndex: target.params.length / 2 - 1 },
        { entityId: endCap, pointIndex: 1 },
    ]);
    expect(sketch.data.constraints.every((c) => c.refs.every((r) => r.pointIndex >= 0))).toBe(true);
    const body = nodeById(doc, result.created.find((c) => c.id === "solid")!.nodeId) as ParametricBodyNode;
    const initialVolume = body.shape.value.volume();
    expect(initialVolume).toBeGreaterThan(0);
    const link = sketch.data.constraints.find((c) => c.kind === ConstraintKind.Offset)!;
    run(doc, [
        {
            op: "editSketch",
            sketch: sketch.id,
            actions: [{ action: "setDatum", constraint: link.id, value: 2 }],
        },
    ]);
    expect(body.shape.value.volume()).toBeGreaterThan(initialVolume);
    expect(entity(sketch, outer).params).toEqual(points.flat());
    expect(entity(sketch, endCap).params.slice(2)).toEqual(entity(sketch, inner).params.slice(-2));
});

test.each([-2, 0.5, 10])("invalid B-spline point index %s rolls back the edit", (point) => {
    const doc = newDoc();
    const result = run(doc, [
        {
            op: "sketch",
            id: "s",
            entities: [
                {
                    type: "bspline",
                    points: [
                        [0, 0],
                        [5, 2],
                        [10, 0],
                    ],
                },
            ],
        },
    ]);
    const sketch = sketchOf(doc, result, "s");
    const original = sketch.dataJson;
    const id = sketch.data.entities[0].id;
    const message = runExpectingFailure(doc, [
        {
            op: "editSketch",
            sketch: sketch.id,
            actions: [{ action: "movePoint", entity: id, point, to: [10, 5] }],
        },
    ]);
    expect(message).toContain(`point ${point} does not exist on bspline ${id}`);
    expect(sketch.dataJson).toBe(original);
});

test("movePoint resolves -1 to the last B-spline point", () => {
    const doc = newDoc();
    const result = run(doc, [
        {
            op: "sketch",
            id: "s",
            entities: [
                {
                    type: "bspline",
                    points: [
                        [0, 0],
                        [5, 2],
                        [10, 0],
                    ],
                    name: "curve",
                },
            ],
            actions: [{ action: "movePoint", entity: "curve", point: -1, to: [12, 3] }],
        },
    ]);
    expect(sketchOf(doc, result, "s").data.entities[0].params).toEqual([0, 0, 5, 2, 12, 3]);
});

test("associative offset loft follows edits and retains geometry with warnings live and after reopening", async () => {
    const doc = newDoc();
    const variables = (gap: number) => [
        { id: "gap", name: "gap", expression: String(gap), type: "length" as const },
    ];
    doc.variables.setItems(variables(2));
    const points: [number, number][] = Array.from({ length: 16 }, (_, i) => {
        const angle = (2 * Math.PI * i) / 16;
        return [20 * Math.cos(angle), 30 * Math.sin(angle)];
    });
    const result = run(doc, [
        { op: "sketch", id: "foot", entities: [{ type: "bspline", points, periodic: true }] },
        { op: "construct", id: "plane", definition: { kind: "plane-offset", source: "XY", distance: 5 } },
        {
            op: "sketch",
            id: "top",
            plane: { construction: "plane" },
            actions: [
                { action: "paste", from: "foot", entities: [1] },
                { action: "offset", entity: 1, distance: "gap", associative: true, name: "outline" },
                { action: "setConstruction", entities: [1], value: true },
            ],
        },
        { op: "loft", id: "skirt", sections: ["foot", "top"] },
    ]);
    const top = sketchOf(doc, result, "top");
    const body = nodeById(doc, result.created.find((c) => c.id === "skirt")!.nodeId) as ParametricBodyNode;
    const link = top.data.constraints.find((c) => c.kind === ConstraintKind.Offset)!;
    expect(link).toMatchObject({
        datum: "gap",
        refs: [
            { entityId: 1, pointIndex: 0 },
            { entityId: 2, pointIndex: 0 },
        ],
    });
    expect(top.data.entities[0].construction).toBe(true);
    expect(top.data.entities[1].construction).toBeUndefined();
    expect(top.data.entities[1].params[0]).toBeCloseTo(22, 3);
    expect(body.shape.unchecked()!.checkShape()).toBe(true);
    doc.variables.setItems(variables(4));
    expect(top.data.entities[1].params[0]).toBeCloseTo(24, 3);
    expect(body.shape.unchecked()!.boundingBox().max.x).toBeCloseTo(24, 2);
    const before = top.data;
    run(doc, [
        {
            op: "editSketch",
            sketch: top.id,
            actions: [{ action: "movePoint", entity: 1, point: 0, to: [21, 0] }],
        },
    ]);
    expect(top.data.entities[1].params[0]).toBeCloseTo(25, 2);
    const edited = top.data;
    doc.history.undo();
    expect(top.data).toEqual(before);
    doc.history.redo();
    expect(top.data).toEqual(edited);
    const info = run(doc, [{ op: "sketchInfo", sketch: top.id }]).results["sketchInfo"] as SketchInfo;
    expect(info.constraints.find((c) => c.id === link.id)).toMatchObject({
        kind: "Offset",
        datum: "gap",
        refs: [
            { entity: 1, point: 0 },
            { entity: 2, point: 0 },
        ],
    });
    expect(info.solve).toMatch(/^Ok/);
    const volume = body.shape.value.volume();
    const maxX = body.shape.value.boundingBox().max.x;
    doc.variables.setItems(variables(-50));
    expect(top.data.entities[1].params).toEqual(edited.entities[1].params);
    expect(top.shape.isOk).toBe(true);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(volume, 5);
    expect(body.shape.value.boundingBox().max.x).toBeCloseTo(maxX, 5);
    expect(top.warningCount).toBe(1);
    expect(top.offsetWarnings[0]).toMatch(new RegExp(`Offset constraint ${link.id}:.*collapse`));
    const stored = {
        __cla$$__: "Document",
        acts: [],
        formatVersion: DOCUMENT_FORMAT_VERSION,
        moduleVersions: DocumentMigrations.moduleVersions(),
        id: doc.id,
        name: doc.name,
        models: doc.modelManager.serialize(),
        variables: variables(-50),
    };
    const decoded = await decodeDocumentFile(await encodeDocumentFile(stored));
    expect(decoded.isOk).toBe(true);
    const reopened = newDoc();
    reopened.variables.setItems(decoded.value["variables"]);
    await reopened.modelManager.deserialize(decoded.value["models"]);
    const reopenedTop = nodeById(reopened, top.id) as SketchNode;
    const reopenedBody = nodeById(reopened, body.id) as ParametricBodyNode;
    expect(reopenedTop.shape.isOk).toBe(true);
    expect(reopenedBody.shape.isOk).toBe(true);
    expect(reopenedBody.shape.value.volume()).toBeCloseTo(volume, 5);
    expect(reopenedBody.shape.value.boundingBox().max.x).toBeCloseTo(maxX, 5);
    expect(reopenedTop.offsetWarnings).toEqual(top.offsetWarnings);
    expect(reopenedTop.warningCount).toBe(1);
    expect(reopened.modelManager.serialize()).toEqual(stored.models);
    const evaluation = await new HeadlessDocumentEvaluator(createMockApplication()).evaluate(decoded.value);
    expect(evaluation.isOk).toBe(true);
    expect(evaluation.value.size).toBe(0);
    const headless = await Document.loadHeadless(createMockApplication(), decoded.value);
    expect(headless.isOk).toBe(true);
    try {
        const headlessTop = headless.value.modelManager.findNode((n) => n.id === top.id) as SketchNode;
        const headlessBody = headless.value.modelManager.findNode(
            (n) => n.id === body.id,
        ) as ParametricBodyNode;
        expect(headlessTop.shape.isOk).toBe(true);
        expect(headlessBody.shape.isOk).toBe(true);
        expect(headlessBody.shape.value.volume()).toBeCloseTo(volume, 5);
        expect(headlessTop.offsetWarnings).toEqual(top.offsetWarnings);
        expect(headlessTop.warningCount).toBe(1);
    } finally {
        headless.value.dispose();
    }
    reopened.variables.setItems(variables(3));
    expect(reopenedTop.warningCount).toBe(0);
    expect(reopenedTop.offsetWarnings).toEqual([]);
    expect(reopenedBody.shape.isOk).toBe(true);
    expect(reopenedBody.shape.value.volume()).not.toBeCloseTo(volume, 2);
});

test("external-reference followers preserve a failed offset target and warn on the node", () => {
    const doc = newDoc();
    const source = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [{ id: 1, type: "circle", params: [0, 0, 10] }],
            constraints: [],
        },
    });
    doc.modelManager.addNode(source);
    expect(source.shape.isOk).toBe(true);
    const ref = captureExternalRef(
        -100,
        source.id,
        Plane.XY,
        source.shape.value as IEdge,
        undefined,
        "reference",
    );
    expect(ref).not.toBeUndefined();
    const follower = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 10, type: "circle", params: [0, 0, 10], construction: true },
                { id: 20, type: "circle", params: [0, 0, 2], derivation: "offset" },
            ],
            constraints: [
                {
                    id: 30,
                    kind: ConstraintKind.Offset,
                    datum: -8,
                    refs: [10, 20].map((entityId) => ({ entityId, pointIndex: 0 })),
                },
                {
                    id: 31,
                    kind: ConstraintKind.EqualRadius,
                    refs: [10, -100].map((entityId) => ({ entityId, pointIndex: 0 })),
                },
            ],
            externalRefs: [ref!],
        },
    });
    doc.modelManager.addNode(follower);
    expect(follower.shape.isOk).toBe(true);
    expect(follower.warningCount).toBe(0);
    source.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 5] }],
        constraints: [],
    });
    expect(follower.shape.isOk).toBe(true);
    expect(follower.data.entities[0].params[2]).toBeCloseTo(5, 6);
    expect(follower.data.entities[1].params[2]).toBe(2);
    expect(follower.warningCount).toBe(1);
    expect(follower.offsetWarnings[0]).toMatch(/Offset constraint 30:.*collapse/);
    source.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 12] }],
        constraints: [],
    });
    expect(follower.shape.isOk).toBe(true);
    expect(follower.data.entities[1].params[2]).toBeCloseTo(4, 6);
    expect(follower.warningCount).toBe(0);
});

test("a non-offset datum discovered during a failing program solve preserves the diagnosis", () => {
    const doc = newDoc();
    const node = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [{ id: 10, type: "circle", params: [0, 0, 10] }],
            constraints: [
                { id: 40, kind: ConstraintKind.Radius, datum: 10, refs: [{ entityId: 10, pointIndex: 0 }] },
            ],
        },
    });
    const session = new SketchSession(
        { resolveNode: () => node, resolveSketch: () => node },
        node,
        { entities: new Map(), constraints: new Map() },
        new Map(),
    );
    const solve = rs.spyOn(session.solver, "solve").mockImplementation(() => {
        (session.solver.datumErrors as Map<number, string>).set(40, "unrelated datum error");
        return { result: "Unsolved constraints", dofs: 0 };
    });
    const diagnose = rs.spyOn(session.solver, "diagnose").mockReturnValue({
        conflicting: [40],
        redundant: [],
        dofs: 0,
    });
    try {
        expect(() => session.finish()).toThrow(
            "the sketch does not solve (Unsolved constraints): conflicting constraints 40",
        );
        expect(diagnose).toHaveBeenCalledOnce();
        expect(solve).toHaveBeenCalledOnce();
    } finally {
        solve.mockRestore();
        diagnose.mockRestore();
        session.dispose();
    }
});
