// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDisposable,
    type IEdge,
    type IFace,
    type IShape,
    ShapeTypes,
    type TrackedShape,
} from "@spicy3d/core";
import { createBox, createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const factory = createTestFactory();
const operations = ["fillet", "filletTracked", "chamfer", "chamferTracked"] as const;
let owned: IDisposable[] = [];
function keep<T extends IDisposable>(value: T): T {
    owned.push(value);
    return value;
}
afterEach(() => {
    const values = owned;
    owned = [];
    for (const value of values.reverse()) value.dispose();
});

describe("native corner failure diagnostics", () => {
    test.each(
        operations,
    )("%s reports available build context for excessive size without corrupting input", (operation) => {
        const box = keep(createBox(factory, 10, 10, 10));
        const result = factory[operation](box, [0], 100);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("OCCT build failed");
        expect(result.error).toContain(operation.startsWith("fillet") ? "radius=100" : "distance=100");
        expect(result.error).toContain("contours=");
        expect(result.error.length).toBeGreaterThan(80);
        expect(box.checkShape()).toBe(true);
        expect(box.volume()).toBeCloseTo(1000, 6);
        const valid = unwrapOk<IShape | TrackedShape>(factory[operation](box, [0], 0.25));
        const shape = keep("faceMap" in valid ? valid.shape : valid);
        expect(shape.checkShape()).toBe(true);
        expect(shape.volume()).toBeLessThan(1000);
    });

    test.each(operations)("%s validates numeric edge indexes and non-finite sizes", (operation) => {
        const box = keep(createBox(factory, 10, 10, 10));
        for (const index of [-1, 0.5, 999, NaN, Infinity]) {
            const result = factory[operation](box, [index], 0.25);
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("edge indexes must be integers");
        }
        for (const amount of [NaN, Infinity]) {
            const result = factory[operation](box, [0], amount);
            expect(result.isOk).toBe(false);
            expect(result.error).toContain("must be positive and finite");
        }
        expect(box.checkShape()).toBe(true);
    });

    test.each(
        operations,
    )("%s identifies an OCCT-marked tangent junction rather than silently doing nothing", (operation) => {
        const box = keep(createBox(factory, 10, 10, 10));
        const originalEdges = box.findSubShapes(ShapeTypes.edge) as IEdge[];
        owned.push(...originalEdges);
        const vertical = originalEdges.findIndex((edge) => {
            const bounds = edge.geometryBoundingBox();
            return Math.abs(bounds.min.z) < 1e-5 && Math.abs(bounds.max.z - 10) < 1e-5;
        });
        expect(vertical).toBeGreaterThanOrEqual(0);
        const rounded = keep(unwrapOk(factory.fillet(box, [vertical], 1)) as IShape);
        const edges = rounded.findSubShapes(ShapeTypes.edge) as IEdge[];
        owned.push(...edges);
        const tangent = edges.findIndex((edge) => {
            const bounds = edge.geometryBoundingBox();
            if (Math.abs(bounds.min.z) > 1e-5 || Math.abs(bounds.max.z - 10) > 1e-5) return false;
            const faces = edge.findAncestor(ShapeTypes.face, rounded) as IFace[];
            owned.push(...faces);
            return faces.some((face) => {
                const surface = keep(face.surface());
                return "radius" in surface && Math.abs(Number(surface.radius) - 1) < 1e-6;
            });
        });
        expect(tangent).toBeGreaterThanOrEqual(0);
        const result = factory[operation](rounded, [tangent], 0.25);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("was not accepted into an OCCT contour");
        expect(result.error).toContain("adjoining faces are marked tangent");
        expect(rounded.checkShape()).toBe(true);
    });
});
