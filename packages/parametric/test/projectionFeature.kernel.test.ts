// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type IEdge,
    type IFace,
    type IPicker,
    Matrix4,
    Plane,
    ShapeTypes,
    Transaction,
    type VisualShapeData,
    XYZ,
} from "@spicy3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@spicy3d/core/test-utils";
import { buildParametricTools } from "../../ai/src/tools/parametricTools";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { ProjectionCommand } from "../src/commands/projectionCommand";
import { evaluateFeature } from "../src/features/feature";
import { capturePathReference } from "../src/features/pathReferences";
import { captureProjectionTarget } from "../src/features/projectionTargetReferences";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { EdgesReport, ProgramResult } from "../src/program/parametricProgram";
import { runParametricProgram } from "../src/program/parametricProgram";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src/features/projection";
import "./sketch/setup";

const factory = createTestFactory();
beforeAll(() => {
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});

function fixture() {
    const app = createMockApplication();
    const document = new TestDocument({ application: app });
    document.visual = createMockVisualWithDocument(document);
    document.selection = createMockSelection();
    app.activeView = createMockView({ document });
    const source = new SketchNode({
        document,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 10 }), normal: XYZ.unitX, xvec: XYZ.unitY }),
        data: { entities: [{ id: 42, type: "line", params: [-2, 0, 2, 0] }], constraints: [] },
    });
    const circle = new SketchNode({
        document,
        plane: Plane.XY,
        data: { entities: [{ id: 7, type: "circle", params: [0, 0, 10] }], constraints: [] },
    });
    document.modelManager.addNode(source);
    document.modelManager.addNode(circle);
    const target = new ParametricBodyNode({
        document,
        features: [{ id: "cylinder", type: "extrude", sketchId: circle.id, depth: 20 }],
    });
    document.modelManager.addNode(target);
    expect(target.shape.isOk).toBe(true);
    const index = (target.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
        (face) => !face.surface().isPlanar(),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const path = capturePathReference(source, 0);
    const face = captureProjectionTarget(target, index);
    expect(path.isOk).toBe(true);
    expect(face.isOk).toBe(true);
    const projection = new ParametricBodyNode({
        document,
        features: [
            {
                id: "project",
                type: "projection",
                source: { nodeId: source.id, edges: [path.value] },
                target: face.value,
                direction: XYZ.unitX,
            },
        ],
    });
    document.modelManager.addNode(projection);
    return { app, document, source, circle, target, projection };
}

function length(node: ParametricBodyNode) {
    if (!node.shape.isOk) throw new Error(node.shape.error);
    return node.shape.value
        .findSubShapes(ShapeTypes.edge)
        .reduce((sum, edge) => sum + (edge as IEdge).length(), 0);
}

test("associative projection rebuilds upstream source and target edits with stable semantic edge IDs", () => {
    const { source, circle, projection } = fixture();
    expect(length(projection)).toBeCloseTo(20 * Math.asin(0.2), 5);
    const original = projection.shape.value
        .findSubShapes(ShapeTypes.edge)
        .map((_, index) => projection.edgeIdAt(index));
    source.setDataEmitShapeChanged({
        entities: [{ id: 42, type: "line", params: [-3, 0, 3, 0] }],
        constraints: [],
    });
    expect(length(projection)).toBeCloseTo(20 * Math.asin(0.3), 5);
    circle.setDataEmitShapeChanged({
        entities: [{ id: 7, type: "circle", params: [0, 0, 12] }],
        constraints: [],
    });
    expect(length(projection)).toBeCloseTo(24 * Math.asin(0.25), 5);
    expect(
        projection.shape.value.findSubShapes(ShapeTypes.edge).map((_, index) => projection.edgeIdAt(index)),
    ).toEqual(original);
});

test("projection editor previews reverse, confirms one undo step and restores the curve on undo", async () => {
    const { app, document, projection } = fixture();
    const command = new ProjectionCommand(projection, "project");
    const done = command.execute(app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const position = document.history.position();
    command.reverse();
    expect(projection.features[0]).toMatchObject({ direction: { x: 1, y: 0, z: 0 } });
    command.confirm();
    await done;
    expect(projection.features[0]).toMatchObject({ direction: { x: -1, y: 0, z: 0 } });
    expect(document.history.position()).not.toEqual(position);
    const points = (projection.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[]).map((edge) =>
        edge.startPoint(),
    );
    expect(points.every((point) => point.x < 0)).toBe(true);
    document.history.undo();
    expect(projection.features[0]).toMatchObject({ direction: { x: 1, y: 0, z: 0 } });
    expect(document.history.position()).toEqual(position);
});

test("projection editor refuses zero direction and cancellation changes no committed payload", async () => {
    const { app, document, projection } = fixture();
    const before = JSON.stringify(projection.features);
    const position = document.history.position();
    const command = new ProjectionCommand(projection, "project");
    const done = command.execute(app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    command.directionX = 0;
    command.confirm();
    expect(JSON.stringify(projection.features)).toBe(before);
    await command.cancel();
    await done;
    expect(JSON.stringify(projection.features)).toBe(before);
    expect(document.history.position()).toEqual(position);
});

function pickInputs(document: TestDocument, source: SketchNode, target: ParametricBodyNode) {
    const index = (target.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
        (face) => !face.surface().isPlanar(),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const sourceEdge = source.mesh.edges?.range.find((range) => range.shape.index === 0)?.shape;
    const targetFace = target.mesh.faces?.range.find((range) => range.shape.index === index)?.shape;
    expect(sourceEdge).not.toBeUndefined();
    expect(targetFace).not.toBeUndefined();
    const sourcePick = {
        shape: sourceEdge,
        owner: { node: source },
        transform: source.worldTransform(),
        indexes: [0],
    } as unknown as VisualShapeData;
    const targetPick = {
        shape: targetFace,
        owner: { node: target },
        transform: target.worldTransform(),
        indexes: [index],
    } as unknown as VisualShapeData;
    const picks = [[sourcePick], [targetPick]];
    document.picker = { pickShape: async () => picks.shift() ?? [] } as unknown as IPicker;
}

test("projection creation previews picked inputs and adds one undoable curve body", async () => {
    const { app, document, source, target } = fixture();
    const original = document.modelManager.findNodes().map((node) => node.id);
    pickInputs(document, source, target);
    const command = new ProjectionCommand();
    const done = command.execute(app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    command.directionX = 1;
    command.directionZ = 0;
    command.confirm();
    await done;
    const added = document.modelManager.findNodes((node) => !original.includes(node.id));
    expect(added).toHaveLength(1);
    const projected = added[0];
    expect(projected).toBeInstanceOf(ParametricBodyNode);
    if (!(projected instanceof ParametricBodyNode)) throw new Error("Projection body missing");
    expect(length(projected)).toBeCloseTo(20 * Math.asin(0.2), 5);
    expect(source.visible).toBe(true);
    expect(target.visible).toBe(true);
    document.history.undo();
    expect(document.modelManager.findNodes().map((node) => node.id)).toEqual(original);
});

test("projection editor repicks associative inputs and preserves feature identity through undo", async () => {
    const { app, document, source, circle, projection } = fixture();
    circle.setDataEmitShapeChanged({
        entities: [{ id: 7, type: "circle", params: [0, 0, 12] }],
        constraints: [],
    });
    expect(length(projection)).toBeCloseTo(24 * Math.asin(1 / 6), 5);
    const newCircle = new SketchNode({
        document,
        plane: Plane.XY,
        data: { entities: [{ id: 8, type: "circle", params: [0, 0, 16] }], constraints: [] },
    });
    document.modelManager.addNode(newCircle);
    const newTarget = new ParametricBodyNode({
        document,
        features: [{ id: "new-wall", type: "extrude", sketchId: newCircle.id, depth: 20 }],
    });
    document.modelManager.addNode(newTarget);
    expect(newTarget.shape.isOk).toBe(true);
    pickInputs(document, source, newTarget);
    const before = JSON.stringify(projection.features);
    const command = new ProjectionCommand(projection, "project");
    const done = command.execute(app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await command.repick();
    command.confirm();
    await done;
    expect(projection.features[0].id).toBe("project");
    expect(length(projection)).toBeCloseTo(32 * Math.asin(1 / 8), 5);
    document.history.undo();
    expect(JSON.stringify(projection.features)).toBe(before);
});

test("projection program captures associative source and target references and rolls back invalid indexes", () => {
    const { document, source, target } = fixture();
    const faces = target.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const faceIndex = faces.findIndex((face) => !face.surface().isPlanar());
    let nodeId = "";
    Transaction.execute(document, "project program", () => {
        const result = runParametricProgram(document, [
            {
                op: "projection",
                id: "projected",
                source: source.id,
                target: target.id,
                faceIndex,
                edgeIndexes: [0],
                direction: { x: 1, y: 0, z: 0 },
            },
        ]);
        nodeId = result.created[0].nodeId;
    });
    const node = document.modelManager.findNode((candidate) => candidate.id === nodeId);
    expect(node).toBeInstanceOf(ParametricBodyNode);
    if (!(node instanceof ParametricBodyNode)) throw new Error("Projection node missing");
    expect(length(node)).toBeCloseTo(20 * Math.asin(0.2), 5);
    expect(node.features[0]).toMatchObject({
        type: "projection",
        source: { nodeId: source.id, edges: [{ edgeId: expect.stringContaining("ent42") }] },
        target: { nodeId: target.id, face: { id: expect.any(String) } },
    });
    const before = document.modelManager.findNodes().map((candidate) => candidate.id);
    expect(() =>
        Transaction.execute(document, "invalid projection", () =>
            runParametricProgram(document, [
                {
                    op: "projection",
                    id: "invalid",
                    source: source.id,
                    target: target.id,
                    faceIndex,
                    edgeIndexes: [0, -1],
                    direction: { x: 1, y: 0, z: 0 },
                },
            ]),
        ),
    ).toThrow(/out of bounds/);
    expect(document.modelManager.findNodes().map((candidate) => candidate.id)).toEqual(before);
});

test("projection dependencies invalidate placement changes rather than using a stale cached curve", () => {
    const { target, projection } = fixture();
    expect(length(projection)).toBeCloseTo(20 * Math.asin(0.2), 5);
    target.transform = Matrix4.fromTranslation(3, 0, 0);
    expect(length(projection)).toBeCloseTo(20 * Math.asin(0.2), 5);
    const points = (projection.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[]).map((edge) =>
        edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2),
    );
    expect(points.every((point) => point.x > 12)).toBe(true);
    target.setRollbackIndex(0);
    // Session rollback deliberately holds dependents' committed display. A requested
    // evaluation must still reject the transient target instead of projecting it.
    const evaluated = evaluateFeature(projection.features[0], {
        document: projection.document,
        host: projection,
        scope: new Map(),
    });
    expect(evaluated.isOk).toBe(false);
    expect(evaluated.error).toContain("rolled back");
});

test("distinct MCP calls round-trip tracked source refs through JSON and upstream source edits", async () => {
    const { app, document, circle, target: sourceBody } = fixture();
    const outerCircle = new SketchNode({
        document,
        plane: Plane.XY,
        data: { entities: [{ id: 99, type: "circle", params: [0, 0, 20] }], constraints: [] },
    });
    document.modelManager.addNode(outerCircle);
    const target = new ParametricBodyNode({
        document,
        features: [{ id: "outer", type: "extrude", sketchId: outerCircle.id, depth: 20 }],
    });
    document.modelManager.addNode(target);
    expect(target.shape.isOk).toBe(true);
    const faceIndex = (target.shape.value.findSubShapes(ShapeTypes.face) as IFace[]).findIndex(
        (face) => !face.surface().isPlanar(),
    );
    expect(faceIndex).toBeGreaterThanOrEqual(0);
    rs.stubGlobal("app", app);
    try {
        const tool = buildParametricTools()[0];
        const queried = JSON.parse(
            (await tool.handler({ ops: [{ op: "edges", body: sourceBody.id, id: "refs" }] })) as string,
        ) as ProgramResult;
        const refs = queried.results["refs"] as EdgesReport;
        const vertical = refs.edges.find(
            (edge) =>
                edge.reference.edge.kind === "line" &&
                Math.abs(edge.reference.edge.end.z - edge.reference.edge.start.z) > 19,
        );
        expect(vertical).not.toBeUndefined();
        if (!vertical) throw new Error("Source seam edge missing");
        const portable = JSON.parse(JSON.stringify(vertical.reference));
        circle.setDataEmitShapeChanged({
            entities: [{ id: 7, type: "circle", params: [0, 0, 12] }],
            constraints: [],
        });
        const result = JSON.parse(
            (await tool.handler({
                ops: [
                    {
                        op: "projection",
                        id: "portable",
                        source: sourceBody.id,
                        edgeRefs: [portable],
                        target: target.id,
                        faceIndex,
                        direction: { x: 1, y: 0, z: 0 },
                    },
                ],
            })) as string,
        ) as ProgramResult;
        expect(result.created).toHaveLength(1);
        const node = document.modelManager.findNode((candidate) => candidate.id === result.created[0].nodeId);
        expect(node).toBeInstanceOf(ParametricBodyNode);
        if (!(node instanceof ParametricBodyNode)) throw new Error("Projected body missing");
        expect(length(node)).toBeCloseTo(20, 5);
        const edges = node.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges.every((edge) => Math.abs(edge.startPoint().x - 20) < 1e-5)).toBe(true);
        const feature = node.features[0];
        expect(feature.type).toBe("projection");
        if (feature.type !== "projection") throw new Error("Wrong feature type");
        expect(feature.source.edges[0].edgeId).toBe(portable.edge.edgeId);
    } finally {
        rs.unstubAllGlobals();
        rs.stubGlobal("shapeFactory", factory);
    }
});

test("an explicit rebuild after host placement changes recomputes host-local projection", () => {
    const { projection } = fixture();
    expect(projection.shape.isOk).toBe(true);
    const midpoint = (shape: import("@spicy3d/core").IShape) => {
        const edge = shape.findSubShapes(ShapeTypes.edge)[0] as IEdge;
        return edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
    };
    const original = midpoint(projection.shape.value);
    projection.transform = Matrix4.fromTranslation(3, 0, 0);
    const rebuilt = projection["generateShape"]();
    expect(rebuilt.isOk).toBe(true);
    const local = midpoint(rebuilt.value);
    expect(local.x).toBeCloseTo(original.x - 3, 5);
    expect(projection.worldTransform().ofPoint(local).x).toBeCloseTo(original.x, 5);
});
