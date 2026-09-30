// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    EditableShapeNode,
    EMPTY_SCOPE,
    type IEdge,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { captureEdgeRef } from "../src/features/edgeRef";
import type { FeatureContext } from "../src/features/feature";
import { capturePathReference, resolvePathReferences } from "../src/features/pathReferences";
import { SketchNode } from "../src/sketch";

const binary = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);
beforeAll(async () => {
    await initWasm({ wasmBinary: binary });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});

const point = (x: number, y: number, z: number) => new XYZ({ x, y, z });
function line(a: XYZ, b: XYZ): IEdge {
    return shapeFactory.line(a, b).value;
}
function fixture(shape: IShape) {
    const document = new TestDocument({ application: createMockApplication() });
    document.visual = createMockVisualWithDocument(document) as typeof document.visual;
    const source = new EditableShapeNode({ document, shape, name: "Path" });
    document.modelManager.addNode(source);
    const context: FeatureContext = {
        document,
        host: { id: "host", worldTransform: () => Matrix4.identity() },
        scope: EMPTY_SCOPE,
    };
    const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    return { document, source, context, edges };
}
function tracking(source: EditableShapeNode, ids: string[]) {
    Object.assign(source, {
        faceIdAt: () => undefined,
        edgeIdAt: (index: number) => ids[index],
        edgeIndexesOfId: (id: string) => ids.flatMap((candidate, index) => (candidate === id ? [index] : [])),
    });
}

describe("ordered whole-edge path references (real kernel)", () => {
    test("orients a connected three-dimensional chain without reversing its source edges", () => {
        const a = point(0, 0, 0),
            b = point(0, 0, 10),
            c = point(5, 5, 15),
            d = point(10, 5, 20);
        const { source, context, edges } = fixture(
            shapeFactory.combine([line(a, b), line(c, b), line(c, d)]).value,
        );
        const refs = edges.map((edge) => captureEdgeRef(edge));
        const result = resolvePathReferences({ nodeId: source.id, edges: refs }, context);
        expect(result.isOk).toBe(true);
        const resolved = result.value;
        expect(resolved.references).toHaveLength(3);
        expect(resolved.references[0].edges[0].ends()[0].isEqualTo(a)).toBe(true);
        expect(resolved.references[1].edges[0].ends()[0].isEqualTo(b)).toBe(true);
        expect(resolved.references[1].edges[0].ends()[1].isEqualTo(c)).toBe(true);
        expect(edges[1].ends()[0].isEqualTo(c)).toBe(true);
        expect(resolved.closed).toBe(false);
        expect(resolved.edgeSeedStable).toEqual([false, false, false]);
        resolved.dispose();
    });

    test("places source-local references through source world and host inverse transforms", () => {
        const { source, context, edges } = fixture(line(point(0, 0, 0), point(0, 0, 10)));
        rs.spyOn(source, "worldTransform").mockReturnValue(Matrix4.fromTranslation(10, 20, 30));
        const placed = {
            ...context,
            host: { id: "host", worldTransform: () => Matrix4.fromTranslation(3, 4, 5) },
        };
        const result = resolvePathReferences(
            { nodeId: source.id, edges: [captureEdgeRef(edges[0])] },
            placed,
        );
        expect(result.isOk).toBe(true);
        expect(result.value.references[0].edges[0].ends()[0].isEqualTo(point(7, 16, 25))).toBe(true);
        expect(result.value.references[0].edges[0].ends()[1].isEqualTo(point(7, 16, 35))).toBe(true);
        result.value.dispose();
        rs.restoreAllMocks();
    });

    test("adopts an entire tracked split span and preserves each piece's real provenance", () => {
        const { source, context, edges } = fixture(
            shapeFactory.combine([
                line(point(0, 0, 5), point(0, 0, 10)),
                line(point(0, 0, 0), point(0, 0, 5)),
            ]).value,
        );
        tracking(source, ["original", "original"]);
        const ref = captureEdgeRef(line(point(0, 0, 0), point(0, 0, 10)), "original");
        const result = resolvePathReferences({ nodeId: source.id, edges: [ref] }, context);
        expect(result.isOk).toBe(true);
        expect(result.value.references[0].edges).toHaveLength(2);
        expect(result.value.references[0].edges.reduce((sum, edge) => sum + edge.length(), 0)).toBeCloseTo(
            10,
        );
        expect(result.value.edgeSeeds).toEqual(["original", "original"]);
        expect(result.value.edgeSeedStable).toEqual([true, true]);
        expect(edges).toHaveLength(2);
        result.value.dispose();
    });

    test("a picked piece of an already split edge stays a single piece", () => {
        const { source, context } = fixture(
            shapeFactory.combine([
                line(point(0, 0, 0), point(0, 0, 5)),
                line(point(0, 0, 5), point(0, 0, 10)),
            ]).value,
        );
        tracking(source, ["original", "original"]);
        const ref = capturePathReference(source, 0);
        expect(ref.isOk).toBe(true);
        expect(ref.value.splitPiece).toBe(true);
        const result = resolvePathReferences({ nodeId: source.id, edges: [ref.value] }, context);
        expect(result.isOk).toBe(true);
        expect(result.value.references[0].edges).toHaveLength(1);
        expect(result.value.edges[0].length()).toBeCloseTo(5);
        result.value.dispose();
    });

    test("a logical span retains every source ancestor rather than only its first piece", () => {
        const { source, context } = fixture(
            shapeFactory.combine([line(XYZ.zero, point(0, 0, 5)), line(point(0, 0, 5), point(0, 0, 10))])
                .value,
        );
        tracking(source, ["ancestor-a", "ancestor-b"]);
        const ref = captureEdgeRef(line(XYZ.zero, point(0, 0, 10)), "ancestor-a|ancestor-b");
        const result = resolvePathReferences({ nodeId: source.id, edges: [ref] }, context);
        expect(result.isOk).toBe(true);
        expect(result.value.references[0].seed).toBe("ancestor-a|ancestor-b");
        expect(result.value.references[0].edges).toHaveLength(2);
        expect([...result.value.edgeSeeds].sort()).toEqual(["ancestor-a", "ancestor-b"]);
        expect(result.value.references[0].provenance).toBe("source");
        result.value.dispose();
    });

    test.each([
        "repeat",
        "disconnected",
        "wrong-order",
    ])("rejects %s rather than silently repairing authored selection", (kind) => {
        const { source, context, edges } = fixture(
            shapeFactory.combine([
                line(point(0, 0, 0), point(0, 0, 5)),
                line(point(0, 0, 5), point(5, 0, 5)),
                line(point(5, 0, 5), point(5, 5, 5)),
                line(point(100, 0, 0), point(100, 0, 5)),
            ]).value,
        );
        const indexes = kind === "repeat" ? [0, 0] : kind === "disconnected" ? [0, 3] : [0, 2, 1];
        const result = resolvePathReferences(
            { nodeId: source.id, edges: indexes.map((index) => captureEdgeRef(edges[index])) },
            context,
        );
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/overlap|repeat|disconnected|traversal/);
    });

    test("accepts a closed curved edge and an authored closed multi-edge loop", () => {
        const circle = shapeFactory.circle(XYZ.unitZ, XYZ.zero, 10).value;
        const a = point(0, 0, 0),
            b = point(0, 0, 10),
            c = point(5, 5, 5);
        for (const shape of [circle, shapeFactory.combine([line(a, b), line(b, c), line(c, a)]).value]) {
            const { source, context, edges } = fixture(shape);
            const result = resolvePathReferences(
                { nodeId: source.id, edges: edges.map((edge) => captureEdgeRef(edge)) },
                context,
            );
            expect(result.isOk).toBe(true);
            expect(result.value.closed).toBe(true);
            expect(result.value.edges).toHaveLength(edges.length);
            result.value.dispose();
        }
    });

    test("uses the pre-consumption timeline rather than the source's final geometry", () => {
        const { source, context } = fixture(line(point(100, 0, 0), point(100, 0, 10)));
        const preceding = line(point(0, 0, 0), point(0, 0, 10));
        tracking(source, ["final"]);
        const timelineStateAt = rs.fn(() => ({ shape: preceding, edgeIds: ["before"] }));
        Object.assign(source, { consumingFeatureIndex: () => 2, timelineStateAt });
        const result = resolvePathReferences(
            { nodeId: source.id, edges: [captureEdgeRef(preceding, "before")] },
            context,
        );
        expect(result.isOk).toBe(true);
        expect(timelineStateAt).toHaveBeenCalledWith(2);
        expect(result.value.edgeSeeds).toEqual(["before"]);
        expect(result.value.edges[0].ends()[0].isEqualTo(XYZ.zero)).toBe(true);
        result.value.dispose();
        Object.assign(source, { rollbackIndex: 1 });
        const rolledBack = resolvePathReferences(
            { nodeId: source.id, edges: [captureEdgeRef(preceding)] },
            context,
        );
        expect(rolledBack.isOk).toBe(false);
        expect(rolledBack.error).toMatch(/rolled back/);
    });

    test("resolves self references only from the preceding input, including its tracked IDs", () => {
        const input = line(XYZ.zero, point(0, 0, 10));
        const { context } = fixture(input);
        const ref = { nodeId: context.host.id, edges: [captureEdgeRef(input, "self-path")] };
        const missing = resolvePathReferences(ref, context);
        expect(missing.isOk).toBe(false);
        expect(missing.error).toMatch(/preceding/);
        const result = resolvePathReferences(ref, {
            ...context,
            input,
            tracking: { inputFaceIds: [], inputEdgeIds: ["self-path"], outputFaceIds: [], outputEdgeIds: [] },
        });
        expect(result.isOk).toBe(true);
        expect(result.value.edgeSeeds).toEqual(["self-path"]);
        result.value.dispose();
    });

    test("sketch entity identity survives an upstream path length edit", () => {
        const { document, context } = fixture(line(XYZ.zero, point(1, 0, 0)));
        const sketch = new SketchNode({
            document,
            plane: Plane.XY,
            data: { entities: [{ id: 17, type: "line", params: [0, 0, 10, 0] }], constraints: [] },
        });
        document.modelManager.addNode(sketch);
        const captured = capturePathReference(sketch, 0);
        expect(captured.isOk).toBe(true);
        sketch.setDataEmitShapeChanged({
            entities: [{ id: 17, type: "line", params: [0, 0, 20, 0] }],
            constraints: [],
        });
        const result = resolvePathReferences({ nodeId: sketch.id, edges: [captured.value] }, context);
        expect(result.isOk).toBe(true);
        expect(result.value.edgeSeeds).toEqual([`sketch:${sketch.id}:path:ent17`]);
        expect(result.value.edgeSeedStable).toEqual([true]);
        expect(result.value.edges[0].length()).toBeCloseTo(20);
        result.value.dispose();
    });

    test("an untracked authored token survives serialization and an unambiguous geometric reanchor", () => {
        const { source, context } = fixture(line(XYZ.zero, point(0, 0, 10)));
        const captured = capturePathReference(source, 0);
        expect(captured.isOk).toBe(true);
        expect(captured.value.edgeId).toMatch(/^path-ref:[a-f0-9-]+$/);
        const stored = JSON.parse(JSON.stringify(captured.value));
        source.shape = shapeFactory.line(point(0.1, 0, 0), point(0.1, 0, 10));
        const result = resolvePathReferences({ nodeId: source.id, edges: [stored] }, context);
        expect(result.isOk).toBe(true);
        expect(result.value.references[0].anchor.edgeId).toBe(captured.value.edgeId);
        expect(result.value.references[0].anchor).not.toEqual(captured.value);
        expect(result.value.references[0].provenance).toBe("authored");
        expect(result.value.references[0].stable).toBe(false);
        expect(result.value.edgeSeeds).toEqual([captured.value.edgeId]);
        result.value.dispose();
    });

    test("authored tokens do not masquerade as native history or break a geometric ambiguity", () => {
        const { source, context } = fixture(line(XYZ.zero, point(0, 0, 10)));
        const captured = capturePathReference(source, 0);
        expect(captured.isOk).toBe(true);
        const duplicated = shapeFactory.combine([
            line(point(-1, 0, 0), point(-1, 0, 10)),
            line(point(1, 0, 0), point(1, 0, 10)),
        ]).value;
        source.shape = shapeFactory.combine([duplicated]);
        tracking(source, [captured.value.edgeId ?? "", "unrelated"]);
        const result = resolvePathReferences({ nodeId: source.id, edges: [captured.value] }, context);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(/ambiguous|not found/);
        const missing = resolvePathReferences({ nodeId: "removed-source", edges: [captured.value] }, context);
        expect(missing.isOk).toBe(false);
        expect(missing.error).toMatch(/not found/);
    });
});
