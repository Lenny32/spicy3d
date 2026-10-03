// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type IFace, type IShape, Matrix4, Plane, Result, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory } from "@spicy3d/wasm";
import { validateBooleanResult } from "../src/features/boolean";
import { combineWithTool } from "../src/features/extrude";
import { captureExtentFaceRef } from "../src/features/extrudeExtent";
import {
    type BooleanFeatureData,
    type ExtrudeFeatureData,
    featureEvaluationError,
    featureHandler,
} from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/spicy-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterEach(() => {
    rs.restoreAllMocks();
});

function scenario(freeform = false) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const sketches = Array.from({ length: 13 }, (_, index) => {
        const sketch = new SketchNode({
            document: doc,
            plane: new Plane({ origin: new XYZ(0, 0, -60 + index * 10), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: {
                entities: [
                    freeform
                        ? {
                              id: 1,
                              type: "bspline",
                              params: [-10, 0, -1, 15, 1, 15, 10, 0],
                              control: { degree: 3, knots: [0, 1], multiplicities: [4, 4] },
                          }
                        : { id: 1, type: "line", params: [-10, 0, 10, 0] },
                    { id: 2, type: "line", params: [10, 0, 10, -15] },
                    { id: 3, type: "line", params: [10, -15, -10, -15] },
                    { id: 4, type: "line", params: [-10, -15, -10, 0] },
                ],
                constraints: [],
            },
        });
        doc.modelManager.addNode(sketch);
        return sketch;
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "loft",
                type: "loft",
                sections: sketches.map((sketch) => ({ sketchId: sketch.id })),
                solid: true,
            },
        ],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const openings = faces.flatMap((face, index) => {
        const surface = face.surface();
        try {
            return surface.isPlanar() && (freeform || Math.abs(face.normal(0, 0)[1].z) > 0.9)
                ? [captureExtentFaceRef(face, body.faceIdAt(index))]
                : [];
        } finally {
            surface.dispose();
        }
    });
    for (const face of faces) face.dispose();
    expect(openings).toHaveLength(freeform ? 5 : 2);
    const tool = new ParametricBodyNode({
        document: doc,
        features: [{ id: "tool", type: "extrude", sketchId: sketches[0].id, depth: 10 }],
    });
    doc.modelManager.addNode(tool);
    const cut: BooleanFeatureData = { id: "cut", type: "boolean", operation: "cut", toolIds: [tool.id] };
    const common: ExtrudeFeatureData = {
        id: "common",
        type: "extrude",
        sketchId: sketches[0].id,
        depth: 100,
        operation: "common",
    };
    return { doc, body, openings, cut, common };
}

test("a synchronous 13-section loft -> open-face thicken -> cut -> extrude common reports the failing step", () => {
    const { body, openings, cut, common } = scenario(true);
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "wall", type: "thicken", thickness: -3.75, openFaces: openings },
        cut,
        common,
    ]);
    expect(body.features).toHaveLength(4);
    expect(body.featureItems()[1].error).toContain('thicken step "wall":');
    expect(body.featureItems()[1].error).toContain("Thick solid is invalid");
});

test.each([false, true])("sync cut rejects a positive-volume BRepCheck failure (tracked=%s)", (tracked) => {
    const { doc, body, openings, cut } = scenario();
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "wall", type: "thicken", thickness: -1, openFaces: openings },
    ]);
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    const output = shapeFactory.box(Plane.XY, 5, 5, 5).value;
    expect(output.volume()).toBeCloseTo(125, 6);
    rs.spyOn(output, "checkShape").mockReturnValue(false);
    const call = tracked
        ? rs
              .spyOn(shapeFactory, "booleanCutTracked")
              .mockReturnValue(Result.ok({ shape: output, faceMap: [], edgeMap: [] }))
        : rs.spyOn(shapeFactory, "booleanCut").mockReturnValue(Result.ok(output));
    const result = featureHandler("boolean")!.evaluate(cut, {
        document: doc,
        host: body,
        input: body.shape.value,
        scope: new Map(),
        tracking: tracked
            ? { inputFaceIds: [], inputEdgeIds: [], outputFaceIds: [], outputEdgeIds: [] }
            : undefined,
    });
    expect(call).toHaveBeenCalledOnce();
    expect(result.isOk).toBe(false);
    expect(result.error).toContain("Boolean result: invalid shape");
    expect(body.shape.value.checkShape()).toBe(true);
});

test("the short chain reports the invalid cut result before extrude common", () => {
    const { body, openings, cut, common } = scenario();
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "wall", type: "thicken", thickness: -1, openFaces: openings },
    ]);
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    const output = shapeFactory.box(Plane.XY, 5, 5, 5).value;
    expect(output.volume()).toBeGreaterThan(0);
    const call = rs.spyOn(shapeFactory, "booleanCutTracked").mockImplementation(() => {
        const shape = output.clone();
        rs.spyOn(shape, "checkShape").mockReturnValue(false);
        return Result.ok({ shape, faceMap: [], edgeMap: [] });
    });
    body.setFeaturesEmitShapeChanged([...body.features, cut, common]);
    expect(body.features).toHaveLength(4);
    expect(call).toHaveBeenCalled();
    expect(body.featureItems()[2].error).toContain('boolean step "cut": Boolean result: invalid shape');
    expect(body.shape.value.checkShape()).toBe(true);
    output.dispose();
});

test("sync extrude common rejects an invalid positive-volume result", () => {
    const { body, openings, common } = scenario();
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "wall", type: "thicken", thickness: -1, openFaces: openings },
    ]);
    const output = shapeFactory.box(Plane.XY, 5, 5, 5).value;
    expect(output.volume()).toBeGreaterThan(0);
    rs.spyOn(output, "checkShape").mockReturnValue(false);
    rs.spyOn(shapeFactory, "booleanCommonTracked").mockReturnValue(
        Result.ok({ shape: output, faceMap: [], edgeMap: [] }),
    );
    body.setFeaturesEmitShapeChanged([...body.features, common]);
    expect(body.featureItems()[2].error).toContain('extrude step "common": Boolean result: invalid shape');
});

test("a failed boolean names the operands already invalid, and only those (#161)", () => {
    const input = new OccShapeConverter().convertFromBrep(
        readFileSync(path.resolve(import.meta.dirname, "../../wasm/test/models/simplifySolid.brep"), "utf8"),
    ).value;
    const tool = shapeFactory.cylinder(XYZ.unitZ, XYZ.zero, 25, 300).value;
    try {
        expect(input.checkShape()).toBe(false);
        const empty: Result<IShape> = Result.err("Boolean produced an empty shape");
        expect(validateBooleanResult(empty, [tool], [input]).error).toBe(
            "Boolean produced an empty shape; tool 0 is already invalid (checkShape false)",
        );
        // Valid operands leave the kernel's own verdict alone: an empty common may be genuine.
        expect(validateBooleanResult(empty, [tool], [tool]).error).toBe("Boolean produced an empty shape");
    } finally {
        input.dispose();
        tool.dispose();
    }
});

test.each([
    "cut",
    "fuse",
] as const)("sync %s accepts inherited simplifySolid defects, including the extrude fallback", (operation) => {
    const input = new OccShapeConverter().convertFromBrep(
        readFileSync(path.resolve(import.meta.dirname, "../../wasm/test/models/simplifySolid.brep"), "utf8"),
    ).value;
    const tool = shapeFactory.cylinder(XYZ.unitZ, XYZ.zero, 25, 300).value;
    const owned: IShape[] = [input, tool];
    try {
        expect(input.checkShape()).toBe(false);
        expect(tool.checkShape()).toBe(true);
        const warn = rs.fn((_message: string) => {});
        const raw =
            operation === "cut"
                ? shapeFactory.booleanCut([input], [tool])
                : shapeFactory.booleanFuse([input], [tool], true);
        expect(raw.isOk).toBe(true);
        expect(raw.value.checkShape()).toBe(false);
        const result = validateBooleanResult(raw, [input], [tool], warn);
        expect(result.isOk).toBe(true);
        owned.push(result.value);
        expect(warn).toHaveBeenCalledWith("input 0 is already invalid (checkShape false)");
        warn.mockClear();
        const tracked =
            operation === "cut"
                ? shapeFactory.booleanCutTracked!([input], [tool])
                : shapeFactory.booleanFuseTracked!([input], [tool]);
        expect(tracked.isOk).toBe(true);
        const trackedResult = validateBooleanResult(Result.ok(tracked.value.shape), [input], [tool], warn);
        expect(trackedResult.isOk).toBe(true);
        owned.push(trackedResult.value);
        expect(warn).toHaveBeenCalledWith("input 0 is already invalid (checkShape false)");
        warn.mockClear();
        const doc = new TestDocument({ application: createMockApplication() });
        const fallback = combineWithTool(
            "fallback",
            operation,
            {
                document: doc,
                host: { id: "host", worldTransform: () => Matrix4.identity() },
                input,
                scope: new Map(),
                warn,
            },
            tool,
        );
        expect(fallback.isOk).toBe(true);
        owned.push(fallback.value);
        expect(warn).toHaveBeenCalledWith("input 0 is already invalid (checkShape false)");
    } finally {
        owned.forEach((shape) => shape.dispose());
    }
});

test.each([
    ["boolean requires a preceding feature", "boolean requires a preceding feature"],
    ["Boolean tool not found", "Boolean tool not found"],
    [
        "Boolean result: invalid shape (checkShape is false)",
        'boolean step "cut": Boolean result: invalid shape (checkShape is false)',
    ],
    [
        'boolean step "cut": Boolean result: invalid shape',
        'boolean step "cut": Boolean result: invalid shape',
    ],
])("feature context preserves or prefixes %s", (error, expected) => {
    expect(featureEvaluationError({ id: "cut", type: "boolean", operation: "cut", toolIds: [] }, error)).toBe(
        expected,
    );
});

test("an inherited topology defect never excuses an inside-out result", () => {
    const input = shapeFactory.box(Plane.XY, 10, 10, 10).value;
    const output = shapeFactory.box(Plane.XY, 5, 5, 5).value;
    try {
        rs.spyOn(input, "checkShape").mockReturnValue(false);
        output.reserve();
        expect(output.volume()).toBeCloseTo(-125, 6);
        const result = validateBooleanResult(Result.ok(output), [input]);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("solid 0 has invalid volume");
    } finally {
        input.dispose();
    }
});

test("accepted invalid boolean warnings survive feature cache reuse", () => {
    const { body, cut } = scenario();
    const output = shapeFactory.box(Plane.XY, 5, 5, 5).value;
    try {
        rs.spyOn(body.shape.value, "checkShape").mockReturnValue(false);
        rs.spyOn(shapeFactory, "booleanCutTracked").mockImplementation(() => {
            const shape = output.clone();
            rs.spyOn(shape, "checkShape").mockReturnValue(false);
            return Result.ok({ shape, faceMap: [], edgeMap: [] });
        });
        body.setFeaturesEmitShapeChanged([...body.features, cut]);
        expect(body.featureItems()[1].error).toBeUndefined();
        expect(body.featureItems()[1].warning).toBe("input 0 is already invalid (checkShape false)");
        body.setFeaturesEmitShapeChanged([...body.features]);
        expect(body.featureItems()[1].warning).toBe("input 0 is already invalid (checkShape false)");
    } finally {
        output.dispose();
    }
});
