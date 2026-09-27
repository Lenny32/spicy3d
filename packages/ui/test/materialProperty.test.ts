// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import type { Material, ModelManager, Property } from "@spicy3d/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@spicy3d/core")` registers.
import {
    createMockDocument as createCoreMockDocument,
    expectEmptyObjectsThrow,
} from "./_helpers/propertyTestHelpers";

// Mock CSS modules — shared ones via helper, file-specific one inline
import "./_helpers/cssMocks";

rs.mock("../src/property/materialProperty.module.css", () => ({
    material: "mp-material",
}));

// Mock element helpers and core services
import "./_helpers/mockElement";
import "./_helpers/mockCoreProperty";

import { MaterialProperty } from "../src/property/materialProperty";

describe("MaterialProperty", () => {
    function createMockDocument() {
        const materials: Material[] = [
            { id: "mat-1", name: "Material 1", color: "#ff0000" } as unknown as Material,
            { id: "mat-2", name: "Material 2", color: "#00ff00" } as unknown as Material,
        ];
        return createCoreMockDocument({
            modelManager: {
                materials: {
                    find: (fn: (m: Material) => boolean) => materials.find(fn),
                    forEach: (fn: (m: Material) => void) => materials.forEach(fn),
                } as unknown as ModelManager["materials"],
            },
        });
    }

    const propConfig: Property = {
        name: "materialId",
        type: "material",
        display: "test.material",
    } as unknown as Property;

    describe("constructor", () => {
        test("should throw when objects array is empty", () => {
            expectEmptyObjectsThrow(() => new MaterialProperty(createMockDocument(), [], propConfig));
        });

        test("should create DOM structure with material elements", () => {
            const doc = createMockDocument();
            const obj = { materialId: "mat-1" };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            expect(prop.children.length).toBeGreaterThan(0);
        });

        test("should set PropertyBase className", () => {
            const doc = createMockDocument();
            const obj = { materialId: "mat-1" };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            expect(prop.className).toContain("panel");
        });

        test.each([
            { desc: "string materialId", makeObjects: () => [{ materialId: "mat-1" }] },
            { desc: "array materialId", makeObjects: () => [{ materialId: ["mat-1", "mat-2"] }] },
            {
                desc: "multiple objects",
                makeObjects: () => [{ materialId: "mat-1" }, { materialId: "mat-2" }],
            },
        ])("should construct with $desc", ({ makeObjects }) => {
            const doc = createMockDocument();
            const objs = makeObjects();
            const prop = new MaterialProperty(doc, objs, propConfig);

            expect(prop.objects).toBe(objs);
            expect(prop.objects.length).toBe(objs.length);
        });

        test("should contain button elements for material selection", () => {
            const doc = createMockDocument();
            const obj = { materialId: "mat-1" };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const buttons = prop.querySelectorAll("button");
            expect(buttons.length).toBeGreaterThan(0);
        });

        test("should handle missing material gracefully", () => {
            const doc = createMockDocument();
            const obj = { materialId: "nonexistent" };
            // Material not found → empty collection, should not throw
            const prop = new MaterialProperty(doc, [obj], propConfig);
            expect(prop.objects).toEqual([obj]);
            // missing material renders no material control buttons
            expect(prop.querySelectorAll("button").length).toBe(0);
        });
    });

    describe("materialCollection", () => {
        test("should find material by string id", () => {
            const doc = createMockDocument();
            const obj = { materialId: "mat-1" };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const materials = (prop as any).materialCollection("mat-1");
            expect(materials.length).toBe(1);
        });

        test("should find multiple materials by array id", () => {
            const doc = createMockDocument();
            const obj = { materialId: ["mat-1", "mat-2"] };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const materials = (prop as any).materialCollection(["mat-1", "mat-2"]);
            expect(materials.length).toBe(2);
        });

        test("should filter out missing materials from array", () => {
            const doc = createMockDocument();
            const obj = { materialId: ["mat-1", "nonexistent"] };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const materials = (prop as any).materialCollection(["mat-1", "nonexistent"]);
            expect(materials.length).toBe(1);
        });

        test("should return empty collection for nonexistent string id", () => {
            const doc = createMockDocument();
            const obj = { materialId: "nonexistent" };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const materials = (prop as any).materialCollection("nonexistent");
            expect(materials.length).toBe(0);
        });
    });

    describe("setMaterial", () => {
        test("should update material on the object via Transaction", () => {
            const doc = createMockDocument();
            const obj = { materialId: "mat-1" as string | string[] };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const newMaterial = { id: "mat-3", name: "Material 3", color: "#0000ff" } as unknown as Material;

            const mockEvent = { target: document.createElement("button") } as unknown as MouseEvent;
            (prop as any).setMaterial(mockEvent, newMaterial, 0);

            // After setMaterial, the material should be updated
            expect(obj.materialId).toBe("mat-3");
        });

        test("should update material array for multi-material objects", () => {
            const doc = createMockDocument();
            const obj = { materialId: ["mat-1", "mat-2"] as string[] };
            const prop = new MaterialProperty(doc, [obj], propConfig);

            const newMaterial = { id: "mat-3", name: "Material 3", color: "#0000ff" } as unknown as Material;

            const mockEvent = { target: document.createElement("button") } as unknown as MouseEvent;
            (prop as any).setMaterial(mockEvent, newMaterial, 0);

            // After setMaterial, the first material should be replaced
            expect(obj.materialId).toEqual(["mat-3", "mat-2"]);
        });

        test("should update all objects in the objects array", () => {
            const doc = createMockDocument();
            const obj1 = { materialId: "mat-1" as string | string[] };
            const obj2 = { materialId: "mat-1" as string | string[] };
            const prop = new MaterialProperty(doc, [obj1, obj2], propConfig);

            const newMaterial = { id: "mat-3", name: "Material 3", color: "#0000ff" } as unknown as Material;

            const mockEvent = { target: document.createElement("button") } as unknown as MouseEvent;
            (prop as any).setMaterial(mockEvent, newMaterial, 0);

            expect(obj1.materialId).toBe("mat-3");
            expect(obj2.materialId).toBe("mat-3");
        });
    });
});
