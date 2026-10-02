// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentMigrations,
    type IEdge,
    Matrix4,
    Plane,
    Result,
    type Serialized,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { FeatureChainPreview } from "../src/commands/featureEditPreview";
import { captureEdgeRef } from "../src/features/edgeRef";
import { type EmbossFeatureData, evaluateFeature } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch";
import { embossFixture, rectangle } from "./_helpers/emboss";
import "../src/migrations";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});
const documents: TestDocument[] = [];
afterEach(() => {
    rs.restoreAllMocks();
    for (const doc of documents.splice(0)) doc.dispose();
});
function setup(withRelief = true, deboss = false) {
    const state = embossFixture(withRelief, deboss);
    documents.push(state.doc);
    expect(state.body.shape.isOk).toBe(true);
    return state;
}
function apply(state: ReturnType<typeof setup>, feature: EmbossFeatureData) {
    state.body.setFeaturesEmitShapeChanged([state.body.features[0], feature]);
    return state.body.featureItems()[1].error;
}

test.each([
    false,
    true,
])("profile holes survive deboss=%s and sketch edits re-anchor the selected outer region", (deboss) => {
    const state = setup(false, deboss);
    const outer = rectangle(10, 10, 20, 20, 201),
        inner = rectangle(12, 12, 18, 18, 301);
    state.sketch.setDataEmitShapeChanged({
        entities: [...outer.entities, ...inner.entities],
        constraints: [],
    });
    expect(apply(state, state.feature)).toBeUndefined();
    expect(state.body.shape.value.volume()).toBeCloseTo(32000 + (deboss ? -1 : 1) * (100 - 36) * 2, 3);
    state.sketch.setDataEmitShapeChanged({
        entities: [...outer.entities, ...rectangle(13, 13, 17, 17, 301).entities],
        constraints: [],
    });
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(state.body.shape.value.volume()).toBeCloseTo(32000 + (deboss ? -1 : 1) * (100 - 16) * 2, 3);
    expect(state.body.features[1]).toMatchObject({ profiles: [{ entities: [201, 202, 203, 204] }] });
});

test.each([
    false,
    true,
])("a partial profile intersection clips relief to the target trim for deboss=%s", (deboss) => {
    const state = setup(false, deboss);
    state.sketch.setDataEmitShapeChanged(rectangle(35, 10, 45, 20, 201));
    expect(apply(state, state.feature)).toBeUndefined();
    expect(state.body.shape.value.checkShape()).toBe(true);
    expect(state.body.shape.value.volume()).toBeCloseTo(32000 + (deboss ? -100 : 100), 3);
    expect(state.body.shape.value.boundingBox().max.x).toBeCloseTo(40, 6);
});

test.each([false, true])("translated and rotated host-local targets rebuild for deboss=%s", (deboss) => {
    const state = setup(false, deboss);
    const transform = Matrix4.fromTranslation(50, -30, 11).multiply(
        Matrix4.fromAxisRad(XYZ.zero, XYZ.unitX, (70 * Math.PI) / 180),
    );
    state.body.transform = transform;
    const sketch = new SketchNode({
        document: state.doc,
        plane: new Plane({
            origin: transform.ofPoint(new XYZ({ x: 0, y: 0, z: 35 })),
            normal: transform.ofVector(XYZ.unitZ),
            xvec: transform.ofVector(XYZ.unitX),
        }),
        data: rectangle(10, 10, 20, 20, 201),
    });
    state.doc.modelManager.addNode(sketch);
    const feature = { ...state.feature, sketchId: sketch.id };
    expect(apply(state, feature)).toBeUndefined();
    expect(state.body.shape.value.volume()).toBeCloseTo(32000 + (deboss ? -200 : 200), 3);
    expect(state.body.features[1]).toMatchObject({ faces: [{ center: { z: 20 }, normal: { z: 1 } }] });
    state.body.setFeatureParameter("base", "depth", 25);
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(state.body.shape.value.volume()).toBeCloseTo(40000 + (deboss ? -200 : 200), 3);
});

test("downstream relief fillets retain references through depth, upstream height and profile enumeration edits", () => {
    const state = setup();
    const edges = state.body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) => edge.ends().every((point) => Math.abs(point.z - 22) < 1e-6));
    expect(index).toBeGreaterThanOrEqual(0);
    const ref = captureEdgeRef(edges[index], state.body.edgeIdAt(index));
    expect(ref.edgeId).toContain(":relief:");
    edges.forEach((edge) => {
        edge.dispose();
    });
    state.body.setFeaturesEmitShapeChanged([
        ...state.body.features,
        { id: "fillet", type: "fillet", radius: 0.25, edges: [ref] },
    ]);
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
    state.body.setFeatureParameter("emboss", "depth", 4);
    state.body.setFeatureParameter("base", "depth", 25);
    // A new preceding profile must not shift the selected relief's identity.
    state.sketch.setDataEmitShapeChanged({
        entities: [...rectangle(1, 1, 5, 5, 301).entities, ...rectangle(10, 10, 20, 20, 201).entities],
        constraints: [],
    });
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
    expect(state.body.shape.value.checkShape()).toBe(true);
    expect(state.body.shape.value.boundingBox().max.z).toBeCloseTo(29, 5);
    expect(state.body.features[2]).toMatchObject({ edges: [{ edgeId: ref.edgeId }] });
    expect(state.body.shape.value.volume()).toBeGreaterThan(40390);
    expect(state.body.shape.value.volume()).toBeLessThan(40400);
});

test("adding a hole preserves a downstream fillet on the original outer relief boundary", () => {
    const state = setup();
    const edges = state.body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) =>
        edge.ends().every((point) => Math.abs(point.z - 22) < 1e-6 && Math.abs(point.y - 20) < 1e-6),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const ref = captureEdgeRef(edges[index], state.body.edgeIdAt(index));
    edges.forEach((edge) => {
        edge.dispose();
    });
    state.body.setFeaturesEmitShapeChanged([
        ...state.body.features,
        { id: "fillet", type: "fillet", radius: 0.25, edges: [ref] },
    ]);
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
    state.sketch.setDataEmitShapeChanged({
        entities: [...rectangle(10, 10, 20, 20, 201).entities, ...rectangle(12, 12, 18, 18, 301).entities],
        constraints: [],
    });
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
    expect(state.body.shape.value.checkShape()).toBe(true);
    const fillet = state.body.features[2];
    expect(fillet.type).toBe("fillet");
    if (fillet.type !== "fillet") throw new Error("Missing downstream fillet");
    const matched = fillet.edges[0];
    expect(matched).toMatchObject({ kind: "line" });
    if (matched.kind !== "line") throw new Error("Fillet anchor changed curve kind");
    expect(matched.start.y).toBeCloseTo(20, 6);
    expect(matched.end.y).toBeCloseTo(20, 6);
    expect(matched.start.z).toBeCloseTo(22, 6);
});

test("live editing previews rebuild downstream fillets without changing the open body", () => {
    const state = setup();
    const edges = state.body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) => edge.ends().every((point) => Math.abs(point.z - 22) < 1e-6));
    expect(index).toBeGreaterThanOrEqual(0);
    const ref = captureEdgeRef(edges[index], state.body.edgeIdAt(index));
    edges.forEach((edge) => {
        edge.dispose();
    });
    state.body.setFeaturesEmitShapeChanged([
        ...state.body.features,
        { id: "fillet", type: "fillet", radius: 0.25, edges: [ref] },
    ]);
    const before = JSON.stringify(state.body.features),
        volume = state.body.shape.value.volume();
    const preview = new FeatureChainPreview(state.body, 1, "live").evaluate(
        { ...(state.body.features[1] as EmbossFeatureData), depth: 4 },
        false,
    );
    expect(preview.error).toBeUndefined();
    expect(preview.partial).toBe(false);
    expect(preview.shape).not.toBeUndefined();
    if (!preview.shape) throw new Error("Missing relief preview");
    try {
        expect(preview.shape.checkShape()).toBe(true);
        expect(preview.shape.volume()).toBeGreaterThan(volume + 190);
        expect(preview.shape.volume()).toBeLessThan(volume + 210);
    } finally {
        preview.shape.dispose();
    }
    expect(JSON.stringify(state.body.features)).toBe(before);
    expect(state.body.shape.value.volume()).toBe(volume);
});

test.each([false, true])("save/reopen preserves exact payload and geometry for deboss=%s", async (deboss) => {
    const state = setup(true, deboss);
    const models = state.doc.modelManager.serialize();
    const reopened = new TestDocument({ application: createMockApplication() });
    documents.push(reopened);
    reopened.visual = createMockVisualWithDocument(reopened);
    await reopened.modelManager.deserialize(structuredClone(models));
    const body = reopened.modelManager.findNode((node) => node.id === state.body.id) as ParametricBodyNode;
    expect(body).toBeInstanceOf(ParametricBodyNode);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(deboss ? 31800 : 32200, 3);
    expect(reopened.modelManager.serialize()).toEqual(models);
    expect(body.features[1]).toMatchObject({
        type: "emboss",
        depth: 2,
        deboss,
        profiles: JSON.parse(JSON.stringify(state.feature.profiles)),
    });
});

test.each([
    0,
    -1,
    NaN,
    Infinity,
    "missing_length",
])("invalid depth %s leaves the prior solid intact", (depth) => {
    const state = setup(false);
    const error = apply(state, { ...state.feature, depth });
    expect(typeof error).toBe("string");
    expect(state.body.shape.value.volume()).toBeCloseTo(32000, 3);
});

test("missing sketch, empty profiles, missing targets and no input are explicit failures", () => {
    const state = setup(false);
    const context = {
        document: state.doc,
        host: state.body,
        input: state.body.shape.value,
        scope: state.doc.variables.evaluate().scope,
    };
    for (const feature of [
        { ...state.feature, sketchId: "missing" },
        { ...state.feature, profiles: [] },
        { ...state.feature, faces: [] },
    ]) {
        const result = evaluateFeature(feature, context);
        expect(result.isOk).toBe(false);
        expect(typeof result.error).toBe("string");
    }
    const result = evaluateFeature(state.feature, { ...context, input: undefined });
    expect(result.isOk).toBe(false);
    expect(result.error).toBe("Emboss requires a preceding feature");
});

test("an offset failure disposes previously built relief and permits a subsequent successful rebuild", () => {
    const state = setup(false);
    state.sketch.setDataEmitShapeChanged({
        entities: [...rectangle(10, 10, 20, 20, 201).entities, ...rectangle(25, 25, 30, 30, 301).entities],
        constraints: [],
    });
    const profiles = requireProfiles(state.sketch);
    const original = shapeFactory.makeThickSolidBySimple.bind(shapeFactory);
    let calls = 0;
    let released: ReturnType<typeof rs.spyOn> | undefined;
    const stub = rs.spyOn(shapeFactory, "makeThickSolidBySimple").mockImplementation((shape, thickness) => {
        if (++calls === 2) return Result.err("injected offset failure");
        const result = original(shape, thickness);
        if (result.isOk) released = rs.spyOn(result.value, "dispose");
        return result;
    });
    expect(apply(state, { ...state.feature, profiles })).toBe(
        'emboss step "emboss": injected offset failure',
    );
    expect(released).not.toBeUndefined();
    expect(released).toHaveBeenCalledOnce();
    stub.mockRestore();
    state.body.setFeaturesEmitShapeChanged([
        state.body.features[0],
        { ...state.feature, profiles, depth: 3 },
    ]);
    expect(state.body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
    expect(state.body.shape.value.volume()).toBeCloseTo(32375, 3);
});

import { resolveProfiles } from "../src/features/profileBuilder";
import { captureProfileRef } from "../src/features/profileRef";

function requireProfiles(sketch: SketchNode) {
    return resolveProfiles(sketch).value.map(({ face }) => captureProfileRef(face));
}

test("parametric 13 migration preserves existing models and newer readers enforce version 14", () => {
    const state = setup(false);
    const data = {
        __cla$$__: "Document",
        formatVersion: 2,
        moduleVersions: { parametric: 13, sketch: 3 },
        models: state.doc.modelManager.serialize(),
        userData: { note: "keep" },
    } as Serialized;
    const result = DocumentMigrations.migrate(data);
    expect(result.isOk).toBe(true);
    expect(result.value["moduleVersions"]).toMatchObject({ parametric: 14, sketch: 5 });
    expect(result.value["models"]).toEqual(data["models"]);
    expect(result.value["userData"]).toEqual(data["userData"]);
});
