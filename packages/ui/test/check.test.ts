// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import type { Property } from "@spicy3d/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@spicy3d/core")` registers.
import { createMockDocument, expectEmptyObjectsThrow } from "./_helpers/propertyTestHelpers";

// Shared mocks: CSS modules, element helpers, core services
import "./_helpers/cssMocks";
import "./_helpers/mockElement";
import "./_helpers/mockCoreProperty";

import { CheckProperty } from "../src/property/check";
import { mustQuery } from "./_helpers/domHelpers";

describe("CheckProperty", () => {
    const propConfig: Property = {
        name: "enabled",
        type: "boolean",
        display: "test.enabled",
    } as unknown as Property;

    describe("constructor", () => {
        test("should throw when objects array is empty", () => {
            expectEmptyObjectsThrow(() => new CheckProperty(createMockDocument(), [], propConfig));
        });

        test("should create DOM structure with panel div", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            expect(prop.children.length).toBeGreaterThan(0);
            // Should have a div child with panel class
            const panel = prop.querySelector('[class*="panel"]');
            expect(panel).not.toBeNull();
        });

        test("should contain a checkbox input", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            const checkbox = prop.querySelector("input[type='checkbox']");
            expect(checkbox).not.toBeNull();
        });

        test("should contain a property name span", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            const spans = prop.querySelectorAll("span");
            expect(spans.length).toBeGreaterThan(0);
        });

        test("should set PropertyBase className", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            expect(prop.className).toContain("panel");
        });

        test("should work with multiple objects", () => {
            const doc = createMockDocument();
            const objs = [{ enabled: true }, { enabled: false }];
            const prop = new CheckProperty(doc, objs, propConfig);

            expect(prop.objects).toBe(objs);
            expect(prop.objects.length).toBe(2);
        });
    });

    describe("onclick behavior", () => {
        test("should create input with onclick handler", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            const checkbox = mustQuery<HTMLInputElement>(prop, "input[type='checkbox']");
            expect((checkbox as any)._onclick).toBeDefined();
        });

        test("should use first object's property for Binding checked", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            expect(prop.objects[0].enabled).toBe(true);
        });

        test("should toggle boolean value on single object when clicked", () => {
            const doc = createMockDocument();
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            // Simulate clicking the checkbox: toggle enabled from true → false
            const input = mustQuery<HTMLInputElement>(prop, "input[type='checkbox']");
            const onclickHandler = (input as any)._onclick as (() => void) | undefined;
            expect(onclickHandler).toBeDefined();

            onclickHandler!();
            expect(obj.enabled).toBe(false);

            // Click again: toggle from false → true
            onclickHandler!();
            expect(obj.enabled).toBe(true);
        });

        test("should toggle boolean value on multiple objects when clicked", () => {
            const doc = createMockDocument();
            const obj1 = { enabled: true };
            const obj2 = { enabled: true };
            const prop = new CheckProperty(doc, [obj1, obj2], propConfig);

            const input = mustQuery<HTMLInputElement>(prop, "input[type='checkbox']");
            const onclickHandler = (input as any)._onclick as (() => void) | undefined;

            onclickHandler!();
            // Both objects should be toggled to false
            expect(obj1.enabled).toBe(false);
            expect(obj2.enabled).toBe(false);
        });

        test("should update document.visual when checkbox is toggled", () => {
            let visualUpdated = false;
            const doc = createMockDocument();
            doc.visual.update = () => {
                visualUpdated = true;
            };
            const obj = { enabled: true };
            const prop = new CheckProperty(doc, [obj], propConfig);

            const input = mustQuery<HTMLInputElement>(prop, "input[type='checkbox']");
            const onclickHandler = (input as any)._onclick as (() => void) | undefined;

            onclickHandler!();
            expect(visualUpdated).toBe(true);
        });

        test("should work with initially false value", () => {
            const doc = createMockDocument();
            const obj = { enabled: false };
            const prop = new CheckProperty(doc, [obj], propConfig);

            const input = mustQuery<HTMLInputElement>(prop, "input[type='checkbox']");
            const onclickHandler = (input as any)._onclick as (() => void) | undefined;

            onclickHandler!();
            expect(obj.enabled).toBe(true);
        });
    });
});
