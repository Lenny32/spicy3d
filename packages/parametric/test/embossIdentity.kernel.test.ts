// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, Plane, type ShapeType, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { captureEdgeRef } from "../src/features/edgeRef";
import { captureEmbossFaceRef } from "../src/features/emboss";
import { resolveProfiles } from "../src/features/profileBuilder";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";
import { embossFixture, rectangle } from "./_helpers/emboss";
import "./sketch/setup";

beforeAll(() => {
    rs.stubGlobal("shapeFactory", createTestFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});

test("a relief fillet stays on the outer top edge after adding a profile hole", () => {
    const { doc, body, sketch } = embossFixture();
    try {
        expect(body.shape.isOk).toBe(true);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => {
            const box = edge.boundingBox();
            return (
                Math.abs(box.min.x - 10) < 1e-6 &&
                Math.abs(box.max.x - 10) < 1e-6 &&
                Math.abs(box.min.z - 22) < 1e-6 &&
                Math.abs(box.max.z - 22) < 1e-6
            );
        });
        expect(index).toBeGreaterThanOrEqual(0);
        const ref = captureEdgeRef(edges[index], body.edgeIdAt(index));
        edges.forEach((edge) => {
            edge.dispose();
        });
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            { id: "fillet", type: "fillet", radius: 0.25, edges: [ref] },
        ]);
        expect(body.shape.isOk).toBe(true);
        const removed = 32200 - body.shape.value.volume();
        expect(removed).toBeGreaterThan(0);
        const outer = rectangle(10, 10, 20, 20, 201);
        const hole = rectangle(12, 12, 18, 18, 301);
        sketch.setDataEmitShapeChanged({ entities: [...outer.entities, ...hole.entities], constraints: [] });
        expect(body.shape.isOk).toBe(true);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(32128 - removed, 6);
        body.setFeatureParameter("emboss", "depth", 5);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(32320 - removed, 6);
        sketch.setDataEmitShapeChanged({
            entities: [...hole.entities, ...outer.entities].reverse(),
            constraints: [],
        });
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(32320 - removed, 6);
    } finally {
        doc.dispose();
    }
});

test.each([false, true])("all relief boundary IDs survive adding and removing holes, deboss=%s", (deboss) => {
    const { doc, body, sketch } = embossFixture(true, deboss);
    const capture = () => {
        expect(body.shape.isOk).toBe(true);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        try {
            return edges.flatMap((edge, index) => {
                const id = body.edgeIdAt(index);
                return id?.includes(":relief:") ? [{ id, ref: captureEdgeRef(edge) }] : [];
            });
        } finally {
            edges.forEach((edge) => {
                edge.dispose();
            });
        }
    };
    try {
        const before = capture();
        expect(before.length).toBeGreaterThan(0);
        expect(new Set(before.map(({ id }) => id)).size).toBe(before.length);
        const outer = rectangle(10, 10, 20, 20, 201);
        const hole = rectangle(12, 12, 18, 18, 301);
        sketch.setDataEmitShapeChanged({ entities: [...outer.entities, ...hole.entities], constraints: [] });
        const after = capture();
        expect(after.length).toBeGreaterThan(before.length);
        for (const previous of before) {
            expect(after.filter(({ id }) => id === previous.id)).toEqual([previous]);
        }
        sketch.setDataEmitShapeChanged(outer);
        expect(capture()).toEqual(before);
    } finally {
        doc.dispose();
    }
});

function polygon(points: [number, number][], firstId: number): SketchData {
    return {
        entities: points.map(([x0, y0], index) => {
            const [x1, y1] = points[(index + 1) % points.length];
            return { id: firstId + index, type: "line", params: [x0, y0, x1, y1] };
        }),
        constraints: [],
    };
}

test.each([
    false,
    true,
])("relief IDs stay unique when one profile meets a target twice, deboss=%s", (deboss) => {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc);
    try {
        // A U-shaped top face: the profile spans its gap, so one target/profile pair gives two patches.
        const base = new SketchNode({
            document: doc,
            id: "sketch-base",
            plane: Plane.XY,
            data: polygon(
                [
                    [0, 0],
                    [40, 0],
                    [40, 40],
                    [30, 40],
                    [30, 10],
                    [10, 10],
                    [10, 40],
                    [0, 40],
                ],
                101,
            ),
        });
        const sketch = new SketchNode({
            document: doc,
            id: "sketch-relief",
            plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 35 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: rectangle(5, 20, 35, 30, 201),
        });
        doc.modelManager.addNode(base);
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            id: "body-emboss",
            features: [{ id: "base", type: "extrude", sketchId: base.id, depth: 20 }],
        });
        doc.modelManager.addNode(body);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.findIndex((face) => Math.abs(face.boundingBox().min.z - 20) < 1e-6);
        expect(top).toBeGreaterThanOrEqual(0);
        const target = captureEmbossFaceRef(faces[top], body.faceIdAt(top));
        faces.forEach((face) => {
            face.dispose();
        });
        body.setFeaturesEmitShapeChanged([
            ...body.features,
            {
                id: "emboss",
                type: "emboss",
                sketchId: sketch.id,
                profiles: resolveProfiles(sketch).value.map(({ face }) => captureProfileRef(face)),
                faces: [target],
                depth: 2,
                deboss,
            },
        ]);
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        const reliefIds = (type: ShapeType, idAt: (index: number) => string | undefined) => {
            const shapes = body.shape.value.findSubShapes(type);
            shapes.forEach((shape) => {
                shape.dispose();
            });
            return shapes
                .map((_, index) => idAt(index))
                .filter((id): id is string => id?.includes(":relief:") === true);
        };
        const faceIds = reliefIds(ShapeTypes.face, (index) => body.faceIdAt(index));
        const edgeIds = reliefIds(ShapeTypes.edge, (index) => body.edgeIdAt(index));
        // Two reliefs, each with a top (emboss) or floor (deboss) face of its own, both named `:top`.
        expect(faceIds.filter((id) => id.endsWith(":top"))).toHaveLength(2);
        expect(new Set(faceIds).size).toBe(faceIds.length);
        expect(edgeIds.length).toBeGreaterThan(0);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
    } finally {
        doc.dispose();
    }
});
