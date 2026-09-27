// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, ShapeTypes } from "@spicy3d/core";
import { OccShapeConverter } from "../src/converter";
import { ShapeFactory } from "../src/factory";
import { OccShapeProvider } from "../src/shapeProvider";
import "./setup";

describe("OccShapeProvider", () => {
    let provider: OccShapeProvider;

    beforeEach(() => {
        provider = new OccShapeProvider();
    });

    test("should create an OccShapeProvider instance", () => {
        expect(provider).toBeInstanceOf(OccShapeProvider);
    });

    test("should have kernelName from factory", () => {
        expect(provider.factory.kernelName).toBe("opencascade");
    });

    test("factory should be a ShapeFactory instance", () => {
        expect(provider.factory).toBeInstanceOf(ShapeFactory);
    });

    test("converter should be an OccShapeConverter instance", () => {
        expect(provider.converter).toBeInstanceOf(OccShapeConverter);
    });

    test("factory should be able to create shapes", () => {
        const result = provider.factory.box(Plane.XY, 10, 10, 10);
        expect(result.isOk).toBe(true);
        expect(result.value.shapeType).toBe(ShapeTypes.solid);
    });

    test("converter should be able to convert shapes", () => {
        const box = provider.factory.box(Plane.XY, 10, 10, 10).value;
        const brepResult = provider.converter.convertToBrep(box);
        expect(brepResult.isOk).toBe(true);
        expect(brepResult.value.length).toBeGreaterThan(0);
    });

    test("factory and converter should be independent instances per provider", () => {
        const provider2 = new OccShapeProvider();
        expect(provider2.factory).not.toBe(provider.factory);
        expect(provider2.converter).not.toBe(provider.converter);
    });
});
