// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";

// test-utils must load BEFORE the core-mock helper so the real core module is
// fully cached by the time `rs.mock("@spicy3d/core")` registers.
import { createMockDocument } from "./_helpers/propertyTestHelpers";

import "./_helpers/cssMocks";
import "./_helpers/mockElement";
import "./_helpers/mockCoreProperty";

import { ProjectPropertiesPanel } from "../src/property/projectPropertiesPanel";
import { mustQuery } from "./_helpers/domHelpers";

function choose(select: HTMLSelectElement, value: string) {
    select.value = value;
    (select as any)._onchange({ target: select });
}

describe("ProjectPropertiesPanel", () => {
    test("offers millimetres, centimetres, metres and inches, starting at the project unit", () => {
        const document = createMockDocument();
        document.settings.load({ lengthUnit: "cm" });
        const panel = new ProjectPropertiesPanel(document);

        const options = [...panel.querySelectorAll("option")];
        expect(options.map((x) => x.value)).toEqual(["mm", "cm", "m", "in"]);
        expect(options.map((x) => (x as any)._selected)).toEqual([false, true, false, false]);
    });

    test("changing the unit updates the project setting", () => {
        const document = createMockDocument();
        const panel = new ProjectPropertiesPanel(document);
        const select = mustQuery<HTMLSelectElement>(panel, "select");

        choose(select, "in");

        expect(document.settings.lengthUnit).toBe("in");
    });

    test("an unknown value leaves the setting alone", () => {
        const document = createMockDocument();
        const panel = new ProjectPropertiesPanel(document);
        const select = mustQuery<HTMLSelectElement>(panel, "select");

        choose(select, "furlong");

        expect(document.settings.lengthUnit).toBe("mm");
    });
});
