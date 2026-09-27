// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import type { IDocument, LengthUnit, Property } from "@spicy3d/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@spicy3d/core")` registers.
import { createMockDocument } from "./_helpers/propertyTestHelpers";

import "./_helpers/cssMocks";
import "./_helpers/mockElement";
import "./_helpers/mockCoreProperty";

import { InputProperty } from "../src/property/input";
import { mustQuery } from "./_helpers/domHelpers";

const lengthProp = { name: "value", display: "box.dx", quantity: "length" } as Property;

/** A writable length the way a body node exposes one: an accessor, not a data field. */
function lengthOwner(initial: number) {
    const writes: number[] = [];
    let value = initial;
    const owner = {};
    Object.defineProperty(owner, "value", {
        get: () => value,
        set: (next: number) => {
            writes.push(next);
            value = next;
        },
        enumerable: true,
    });
    return { owner: owner as { value: number }, writes };
}

function documentIn(unit: LengthUnit): IDocument {
    const document = createMockDocument();
    document.settings.load({ lengthUnit: unit });
    return document;
}

function handlers(input: HTMLInputElement) {
    const target = { target: input } as unknown as FocusEvent;
    return {
        focus: () => (input as any)._onfocus(target),
        blur: () => (input as any)._onblur(target),
    };
}

describe("length properties", () => {
    test("show their value and unit in the project unit", () => {
        const { owner } = lengthOwner(100);
        const property = new InputProperty(documentIn("cm"), [owner], lengthProp);

        expect(property.converter?.convert(100).value).toBe("10");
        const unit = mustQuery<HTMLElement>(property, ".ip-unit");
        expect(unit.textContent).toBe("cm");
    });

    test("read typed values in the project unit: 10 cm is stored as 100 mm", () => {
        const { owner, writes } = lengthOwner(50);
        const property = new InputProperty(documentIn("cm"), [owner], lengthProp);
        const input = mustQuery<HTMLInputElement>(property, "input");
        const events = handlers(input);

        input.value = "5";
        events.focus();
        input.value = "10";
        events.blur();

        expect(writes).toEqual([100]);
        expect(owner.value).toBe(100);
    });

    test("accept an explicit unit: 1 in is 25.4 mm", () => {
        const { owner } = lengthOwner(0);
        const property = new InputProperty(documentIn("cm"), [owner], lengthProp);
        const input = mustQuery<HTMLInputElement>(property, "input");
        const events = handlers(input);

        events.focus();
        input.value = "1 in";
        events.blur();

        expect(owner.value).toBeCloseTo(25.4, 12);
    });

    test("write nothing when the field is left unchanged, so rounding cannot drift", () => {
        const { owner, writes } = lengthOwner(100);
        const property = new InputProperty(documentIn("in"), [owner], lengthProp);
        const input = mustQuery<HTMLInputElement>(property, "input");
        const events = handlers(input);

        for (let i = 0; i < 10; i++) {
            input.value = property.converter!.convert(owner.value).value;
            events.focus();
            events.blur();
        }

        expect(writes).toEqual([]);
        expect(owner.value).toBe(100);
    });

    test("stay in millimetres for a project that never chose a unit", () => {
        const { owner } = lengthOwner(12.5);
        const property = new InputProperty(createMockDocument(), [owner], lengthProp);

        expect(property.converter?.convert(12.5).value).toBe("12.5");
        expect(property.converter?.convertBack?.("3").value).toBe(3);
    });
});
