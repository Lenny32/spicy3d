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
import { ConstructionNode, type IEdge, type IFace, ShapeTypes, Transaction } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import type { RevolveFeatureData } from "../../src/features/feature";
import type { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram } from "../../src/program/parametricProgram";
import type { SketchInfo, SketchReport } from "../../src/program/sketchProgram";
import { ConstraintKind, type SketchEntityData } from "../../src/sketch/sketchModel";
import type { SketchNode } from "../../src/sketch/sketchNode";
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

    test("an invalid definition fails the program", () => {
        const doc = newDoc();
        const message = runExpectingFailure(doc, [
            { op: "construct", id: "p", definition: { kind: "plane-midplane", first: "XY", second: "XY" } },
        ]);
        expect(message).toContain("does not evaluate");
        expect(doc.modelManager.findNodes(() => true)).toEqual([]);
    });
});
