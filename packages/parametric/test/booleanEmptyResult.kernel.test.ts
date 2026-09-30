// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, type IShape, Plane, ShapeTypes } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import "../src/features/boolean";
import { type BooleanFeatureData, type ExtrudeFeatureData, featureHandler } from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/spicy-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

type Bounds = [number, number, number, number];

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** A box body: one extrude of a rectangle on XY, `depth` high. */
function box(doc: TestDocument, bounds: Bounds, depth: number): ParametricBodyNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(...bounds) });
    doc.modelManager.addNode(sketch);
    const profiles = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(profiles).toHaveLength(1);
    const extrude: ExtrudeFeatureData = {
        id: "e1",
        type: "extrude",
        sketchId: sketch.id,
        depth,
        profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
    };
    const body = new ParametricBodyNode({ document: doc, features: [extrude] });
    doc.modelManager.addNode(body);
    return body;
}

const boolean = (
    operation: BooleanFeatureData["operation"],
    tool: ParametricBodyNode,
): BooleanFeatureData => ({
    id: "b1",
    type: "boolean",
    operation,
    toolIds: [tool.id],
});

function extent(shape: IShape): number[] {
    const b = shape.boundingBox();
    return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((x) => Math.round(x * 1e6) / 1e6);
}

function applyBoolean(operation: BooleanFeatureData["operation"], hostBounds: Bounds, toolBounds: Bounds) {
    const doc = newDoc();
    const host = box(doc, hostBounds, 10);
    const tool = box(doc, toolBounds, operation === "cut" ? 30 : 10);
    expect(host.shape.isOk).toBe(true);
    const before = extent(host.shape.unchecked()!);
    host.setFeaturesEmitShapeChanged([...host.features, boolean(operation, tool)]);
    return { doc, host, tool, before };
}

describe("parametric boolean with an empty result", () => {
    test("a common of disjoint boxes fails and the body keeps its previous shape", () => {
        const { host, before } = applyBoolean("common", [0, 0, 10, 10], [50, 50, 60, 60]);

        expect(host.featureItems().map((x) => x.error)).toEqual([
            undefined,
            "Boolean common produced an empty shape: the tools do not intersect the body",
        ]);
        expect(host.shape.isOk).toBe(true);
        const shape = host.shape.unchecked()!;
        expect(shape.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(extent(shape)).toEqual(before);
    });

    test("a cut by a bigger box removing everything fails", () => {
        const { host, before } = applyBoolean("cut", [0, 0, 10, 10], [-10, -10, 20, 20]);

        expect(host.featureItems().map((x) => x.error)).toEqual([
            undefined,
            "Boolean cut produced an empty shape: the tools remove the whole body",
        ]);
        expect(host.shape.isOk).toBe(true);
        expect(extent(host.shape.unchecked()!)).toEqual(before);
    });

    test("an overlapping common still produces the intersection", () => {
        const { host } = applyBoolean("common", [0, 0, 10, 10], [5, 5, 20, 20]);

        expect(host.featureItems().map((x) => x.error)).toEqual([undefined, undefined]);
        const shape = host.shape.unchecked()!;
        expect(shape.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(extent(shape)).toEqual([5, 5, 0, 10, 10, 10]);
    });

    test.each([
        ["common", [50, 50, 60, 60], "Boolean common produced an empty shape"],
        ["cut", [-10, -10, 20, 20], "Boolean cut produced an empty shape"],
    ] as const)("the untracked %s path reports an empty result too", (operation, toolBounds, message) => {
        const doc = newDoc();
        const host = box(doc, [0, 0, 10, 10], 10);
        const tool = box(doc, [...toolBounds], operation === "cut" ? 30 : 10);
        const handler = featureHandler("boolean")!;
        expect(handler).toBeDefined();
        // No `tracking` in the context: the handler takes the plain kernel booleans.
        const result = handler.evaluate(boolean(operation, tool), {
            document: doc,
            host,
            input: host.shape.unchecked()!,
            scope: new Map(),
        });
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toContain(message);
    });

    test("an older kernel returning the empty compound as a success gets the same message", () => {
        const doc = newDoc();
        const host = box(doc, [0, 0, 10, 10], 10);
        const tool = box(doc, [50, 50, 60, 60], 10);
        const factory = globalThis.shapeFactory as ShapeFactory;
        const original = factory.booleanCommon;
        // binaries before the V8_0_1 rebuild: IsDone() and an empty compound, no kernel error
        factory.booleanCommon = () => factory.combine([]);
        try {
            const result = featureHandler("boolean")!.evaluate(boolean("common", tool), {
                document: doc,
                host,
                input: host.shape.unchecked()!,
                scope: new Map(),
            });
            expect(result.isOk ? "" : result.error).toBe(
                "Boolean common produced an empty shape: the tools do not intersect the body",
            );
        } finally {
            factory.booleanCommon = original;
        }
    });

    test("the untracked path keeps a non-empty common", () => {
        const doc = newDoc();
        const host = box(doc, [0, 0, 10, 10], 10);
        const tool = box(doc, [5, 5, 20, 20], 10);
        const result = featureHandler("boolean")!.evaluate(boolean("common", tool), {
            document: doc,
            host,
            input: host.shape.unchecked()!,
            scope: new Map(),
        });
        expect(result.isOk).toBe(true);
        expect(extent(result.unchecked()!)).toEqual([5, 5, 0, 10, 10, 10]);
    });
});
