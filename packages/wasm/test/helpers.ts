// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type ISolid, Plane, ShapeTypes, XYZ } from "@spicy3d/core";
import { OccShapeConverter } from "../src/converter";
import type { OccTrimmedCurve } from "../src/curve";
import { ShapeFactory } from "../src/factory";
import type { OccEdge, OccFace } from "../src/shape";

/**
 * Standard Ax3 at the origin (Z up, X right) for raw-wasm tests.
 */
export const testAx3 = {
    location: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    xDirection: { x: 1, y: 0, z: 0 },
};

/**
 * Create a fresh ShapeFactory instance for testing.
 */
export function createTestFactory(): ShapeFactory {
    return new ShapeFactory();
}

/**
 * Create a fresh OccShapeConverter instance for testing.
 */
export function createTestConverter(): OccShapeConverter {
    return new OccShapeConverter();
}

/**
 * Create a box solid at Plane.XY with the given dimensions.
 * Throws if creation fails — use only in test setup where failure is unexpected.
 */
export function createBox(factory: ShapeFactory, dx = 10, dy = 20, dz = 30): ISolid {
    const result = factory.box(Plane.XY, dx, dy, dz);
    if (!result.isOk) throw new Error(`box creation failed: ${result.error}`);
    return result.value as ISolid;
}

/**
 * Create a sphere solid at the origin with the given radius.
 * Throws if creation fails.
 */
export function createSphere(factory: ShapeFactory, center = XYZ.zero, radius = 10): ISolid {
    const result = factory.sphere(center, radius);
    if (!result.isOk) throw new Error(`sphere creation failed: ${result.error}`);
    return result.value as ISolid;
}

/**
 * Unwrap a Result, throwing with a clear message if it's an error.
 * Use this instead of bare `.value` to get meaningful test failures.
 */
export function unwrapOk<T>(result: { isOk: boolean; value: T; error?: string }): T {
    if (!result.isOk) throw new Error(`unexpected error: ${result.error ?? "unknown"}`);
    return result.value;
}

/**
 * Extract the basis (untrimmed) curve from an edge.
 */
export function basisCurveOfEdge(edge: OccEdge) {
    return (edge.curve as OccTrimmedCurve).basisCurve;
}

/**
 * Get the surface from a face.
 */
export function surfaceOfFace(face: OccFace) {
    return face.surface();
}

/**
 * Get the first face from a shape.
 */
export function firstFace(shape: IShape): OccFace {
    return shape.findSubShapes(ShapeTypes.face)[0] as OccFace;
}

/**
 * Create a box raw WASM shape for type-inspection tests.
 */
export function rawBox(dx = 1, dy = 1, dz = 1) {
    return wasm.ShapeFactory.box(testAx3, dx, dy, dz).shape;
}
