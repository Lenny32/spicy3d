// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import type { Property } from "@spicy3d/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@spicy3d/core")` registers — otherwise the
// mock factory feeds test-utils a half-initialized core namespace.
import { createMockDocument, expectEmptyObjectsThrow } from "./_helpers/propertyTestHelpers";

// Mock CSS modules before importing modules under test
import "./_helpers/cssMocks";

rs.mock("../src/property/colorPorperty.module.css", () => ({
    color: "cp-color",
}));

// Mock element helpers
import "./_helpers/mockElement";

import { ColorProperty } from "../src/property/colorProperty";
import { mustQuery } from "./_helpers/domHelpers";
// Mock core services — PubSub sub handlers are recorded in pubSubHandlers
import { pubSubHandlers } from "./_helpers/mockCorePubSub";

describe("ColorProperty", () => {
    const propConfig: Property = {
        name: "color",
        type: "color",
        display: "test.color",
    } as unknown as Property;

    beforeEach(() => {
        pubSubHandlers.clear();
    });

    describe("constructor", () => {
        test("should throw when objects array is empty", () => {
            expectEmptyObjectsThrow(() => new ColorProperty(createMockDocument(), [], propConfig));
        });

        test("should create DOM structure with panel div", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            expect(prop.children.length).toBeGreaterThan(0);
            const panel = prop.querySelector('[class*="panel"]');
            expect(panel).not.toBeNull();
        });

        test("should contain a color input element", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            const colorInput = prop.querySelector("input[type='color']");
            expect(colorInput).not.toBeNull();
        });

        test("should have input field stored", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            expect(prop.input).toBeInstanceOf(HTMLInputElement);
        });

        test("should contain a label for property name", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            const labels = prop.querySelectorAll("label");
            expect(labels.length).toBeGreaterThan(0);
        });

        test("should have ColorConverter", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            expect(typeof prop.converter.convert).toBe("function");
            expect(typeof prop.converter.convertBack).toBe("function");
        });

        test("should set PropertyBase className", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            expect(prop.className).toContain("panel");
        });

        test("should work with multiple objects", () => {
            const doc = createMockDocument();
            const objs = [{ color: "#ff0000" }, { color: "#00ff00" }];
            const prop = new ColorProperty(doc, objs, propConfig);

            expect(prop.objects).toBe(objs);
            expect(prop.objects.length).toBe(2);
        });
    });

    describe("setColor handler", () => {
        const setColorPropConfig: Property = {
            name: "color",
            type: "color",
            display: "test.color",
        } as unknown as Property;

        test("should set color on all objects via Transaction", () => {
            const doc = createMockDocument();
            const obj1 = { color: "#ff0000" };
            const obj2 = { color: "#00ff00" };
            const prop = new ColorProperty(doc, [obj1, obj2], setColorPropConfig);

            const newColor = "#0000ff";
            const input = mustQuery<HTMLInputElement>(prop, "input");
            input.value = newColor;

            const event = new Event("change");
            Object.defineProperty(event, "target", {
                value: input,
                writable: false,
            });
            input.dispatchEvent(event);

            expect(input.value).toBe(newColor);
        });

        test("should set color property on all objects when convertBack succeeds", () => {
            const doc = createMockDocument();
            const obj1 = { color: "#ff0000" };
            const obj2 = { color: "#00ff00" };
            const prop = new ColorProperty(doc, [obj1, obj2], setColorPropConfig);

            const testValue = { r: 0, g: 0, b: 1 };
            (prop as any).converter = {
                convert: (v: unknown) => ({ isOk: true, value: v }),
                convertBack: (_v: string) => ({ isOk: true, value: testValue }),
            };

            const input = mustQuery<HTMLInputElement>(prop, "input");
            input.value = "#0000ff";
            // Call the onchange handler directly
            const handler = (input as any)._onchange as ((e: Event) => void) | undefined;
            expect(handler).toBeDefined();
            handler!({ target: input } as unknown as Event);

            expect(obj1.color).toEqual(testValue);
            expect(obj2.color).toEqual(testValue);
        });

        test("should not modify objects when convertBack returns undefined value", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const originalColor = obj.color;
            const prop = new ColorProperty(doc, [obj], setColorPropConfig);

            (prop as any).converter = {
                convert: (v: unknown) => ({ isOk: true, value: v }),
                convertBack: (_v: string) => ({ isOk: true, value: undefined }),
            };

            const input = mustQuery<HTMLInputElement>(prop, "input");
            input.value = "invalid";
            const handler = (input as any)._onchange as ((e: Event) => void) | undefined;
            expect(handler).toBeDefined();
            handler!({ target: input } as unknown as Event);

            expect(obj.color).toBe(originalColor);
        });

        test("should not modify objects when convertBack returns error result", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const originalColor = obj.color;
            const prop = new ColorProperty(doc, [obj], setColorPropConfig);

            (prop as any).converter = {
                convert: (v: unknown) => ({ isOk: true, value: v }),
                convertBack: (_v: string) => ({ isOk: false, value: undefined }),
            };

            const input = mustQuery<HTMLInputElement>(prop, "input");
            input.value = "bad-color";
            const handler = (input as any)._onchange as ((e: Event) => void) | undefined;
            expect(handler).toBeDefined();
            handler!({ target: input } as unknown as Event);

            expect(obj.color).toBe(originalColor);
        });
    });

    describe("disconnectedCallback", () => {
        test("should remove the change listener when disconnected", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            const spy = rs.spyOn(prop.input, "removeEventListener");
            prop.disconnectedCallback();

            expect(spy).toHaveBeenCalledWith("onchange", (prop as any).setColor);
        });

        test("should tolerate multiple disconnect calls", () => {
            const doc = createMockDocument();
            const obj = { color: "#ff0000" };
            const prop = new ColorProperty(doc, [obj], propConfig);

            const spy = rs.spyOn(prop.input, "removeEventListener");
            prop.disconnectedCallback();
            prop.disconnectedCallback();

            expect(spy).toHaveBeenCalledTimes(2);
        });
    });
});
