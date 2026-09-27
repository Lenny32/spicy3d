// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RefSegmentAnnotation } from "@spicy3d/core";
import { Matrix4, XYZ } from "@spicy3d/core";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { ThreeRefSegmentAnnotation } from "../src/threeAnnotation";
import { createThreeMockVisualContext } from "./mocks";

function createAnnotation(): RefSegmentAnnotation {
    return {
        startPoint: new XYZ({ x: 0, y: 0, z: 0 }),
        endPoint: new XYZ({ x: 10, y: 10, z: 10 }),
    } as unknown as RefSegmentAnnotation;
}

describe("ThreeRefSegmentAnnotation", () => {
    test("creates annotation object", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        expect(annotation.annotation.startPoint.x).toBe(0);
        expect(annotation.annotation.endPoint.x).toBe(10);
        expect(annotation.locked).toBe(false);
    });

    test("creates LineSegments2 mesh internally", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const meshes = annotation.wholeVisual();
        expect(meshes.length).toBeGreaterThanOrEqual(1);
    });

    test("wholeVisual returns line mesh array", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const visuals = annotation.wholeVisual();
        expect(Array.isArray(visuals)).toBe(true);
    });

    test("highlight changes the line material", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const mesh = annotation.wholeVisual()[0] as LineSegments2;
        const originalMaterial = mesh.material;
        annotation.highlight();
        expect(mesh.material).not.toBe(originalMaterial);
    });

    test("unhighlight restores the original material", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const mesh = annotation.wholeVisual()[0] as LineSegments2;
        const originalMaterial = mesh.material;
        annotation.highlight();
        expect(mesh.material).not.toBe(originalMaterial);

        annotation.unhighlight();
        expect(mesh.material).toBe(originalMaterial);
    });

    test("worldTransform returns identity matrix", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const transform = annotation.worldTransform();
        expect(transform.equals(Matrix4.identity())).toBe(true);
    });

    test("dispose disposes the line geometry", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const mesh = annotation.wholeVisual()[0] as LineSegments2;
        let geometryDisposed = false;
        mesh.geometry.addEventListener("dispose", () => {
            geometryDisposed = true;
        });
        annotation.dispose();
        expect(geometryDisposed).toBe(true);
    });

    test("transform defaults to identity matrix", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        expect(annotation.transform.equals(Matrix4.identity())).toBe(true);
    });

    test("boundingBox returns bounding box of the line", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        const box = annotation.boundingBox();
        expect(box).toBeDefined();
        expect(box!.min.x).toBe(0);
        expect(box!.min.y).toBe(0);
        expect(box!.min.z).toBe(0);
        expect(box!.max.x).toBe(10);
        expect(box!.max.y).toBe(10);
        expect(box!.max.z).toBe(10);
    });

    test("locked is false by default", () => {
        const context = createThreeMockVisualContext();
        const annotation = new ThreeRefSegmentAnnotation(context, createAnnotation());

        expect(annotation.locked).toBe(false);
    });
});
