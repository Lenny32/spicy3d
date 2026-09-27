// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { type I18nKeys, type IDocument, type ModelManager, Texture } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { basicPropertyControl } from "../src/property/basicPropertyControl";
import { CheckProperty } from "../src/property/check";
import { ColorProperty } from "../src/property/colorProperty";
import { propertyControl } from "../src/property/complexPropertyUtils";
import { InputProperty } from "../src/property/input";
import { MaterialProperty } from "../src/property/materialProperty";

rs.mock("../src/property/textureProperty", () => ({
    TextureProperty: rs
        .fn()
        .mockImplementation((document: IDocument, display: I18nKeys, texture: Texture) => ({
            display,
            texture,
            document,
        })),
}));

/**
 * Creates a test object with `onPropertyChanged` stub required by Binding.
 */
function createTestObj(props: Record<string, unknown> = {}) {
    return {
        ...props,
        onPropertyChanged: () => {},
        removePropertyChanged: () => {},
        clearPropertyChanged: () => {},
    };
}

const mockDocument = createMockDocument({
    modelManager: {
        materials: [{ id: "mat1" }, { id: "mat2" }],
    } as unknown as Partial<ModelManager>,
});

describe("propertyControl", () => {
    describe("guard clauses", () => {
        test("should return empty string when prop is undefined", () => {
            const result = propertyControl(mockDocument, [createTestObj()], undefined as never);
            expect(result).toBe("");
        });

        test("should return empty string when objects array is empty", () => {
            const result = propertyControl(mockDocument, [], {
                name: "test",
                type: "string",
                display: "test.label",
            } as never);
            expect(result).toBe("");
        });
    });

    describe("TextureProperty dispatch (mocked)", () => {
        test("should return TextureProperty when value is a Texture instance", () => {
            const texture = new Texture({ document: mockDocument });
            const obj = createTestObj({ texture });
            const result = propertyControl(mockDocument, [obj], {
                name: "texture",
                display: "test.texture",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any) as any;

            expect(result.document).toBe(mockDocument);
            expect(result.texture).toBe(texture);
        });
    });

    describe("delegation to basicPropertyControl", () => {
        test("should return ColorProperty for color type", () => {
            const obj = createTestObj({ color: "#ff0000" });
            const result = propertyControl(mockDocument, [obj], {
                name: "color",
                type: "color",
                display: "test.color",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(ColorProperty);
        });
    });
});

describe("basicPropertyControl", () => {
    describe("guard clauses", () => {
        test("should return empty string when prop is undefined", () => {
            const result = basicPropertyControl(mockDocument, [createTestObj()], undefined as never);
            expect(result).toBe("");
        });

        test("should return empty string when objects array is empty", () => {
            const result = basicPropertyControl(mockDocument, [], {
                name: "test",
                type: "string",
                display: "test.label",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBe("");
        });
    });

    describe("type-based dispatch", () => {
        test("should return ColorProperty for color type", () => {
            const obj = createTestObj({ color: "#ff0000" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "color",
                type: "color",
                display: "test.color",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(ColorProperty);
        });

        test("should return MaterialProperty for materialId type with single object", () => {
            const obj = createTestObj({ materialId: "mat1" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "materialId",
                type: "materialId",
                display: "test.material",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should return InputProperty when materialId values differ", () => {
            const obj1 = createTestObj({ materialId: "mat1" });
            const obj2 = createTestObj({ materialId: "mat2" });
            const result = basicPropertyControl(mockDocument, [obj1, obj2], {
                name: "materialId",
                type: "materialId",
                display: "test.material",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for string type values", () => {
            const obj = createTestObj({ name: "hello" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "name",
                display: "test.name",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for number type values", () => {
            const obj = createTestObj({ count: 42 });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "count",
                display: "test.count",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return InputProperty for object type values", () => {
            const obj = createTestObj({ config: { key: "value" } });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "config",
                display: "test.config",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });

        test("should return CheckProperty for boolean type values", () => {
            const obj = createTestObj({ enabled: true });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "enabled",
                display: "test.enabled",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(CheckProperty);
        });

        test("should return empty string for unsupported types", () => {
            const obj = createTestObj({ sym: Symbol("test") });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "sym",
                display: "test.sym",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBe("");
        });
    });

    describe("canShowMaterialProperty logic", () => {
        test("should show MaterialProperty for single object", () => {
            const obj = createTestObj({ materialId: "mat1" });
            const result = basicPropertyControl(mockDocument, [obj], {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should show MaterialProperty for multiple objects with same materialId", () => {
            const objs = [createTestObj({ materialId: "mat1" }), createTestObj({ materialId: "mat1" })];
            const result = basicPropertyControl(mockDocument, objs, {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(MaterialProperty);
        });

        test("should show InputProperty for multiple objects with different materialId", () => {
            const objs = [createTestObj({ materialId: "mat1" }), createTestObj({ materialId: "mat2" })];
            const result = basicPropertyControl(mockDocument, objs, {
                name: "materialId",
                type: "materialId",
                display: "mat.label",
                // biome-ignore lint/suspicious/noExplicitAny: test mock property
            } as any);
            expect(result).toBeInstanceOf(InputProperty);
        });
    });
});
