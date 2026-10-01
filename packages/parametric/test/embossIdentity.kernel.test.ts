// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, ShapeTypes } from "@spicy3d/core";
import { createTestFactory } from "../../wasm/test/helpers";
import "../../wasm/test/setup";
import { captureEdgeRef } from "../src/features/edgeRef";
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
