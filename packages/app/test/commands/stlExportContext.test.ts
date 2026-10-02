// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { CommandContext } from "../../../ui/src/ribbon/commandContext";
import { Export } from "../../src/commands/importExport";

test("real export context reveals opted-in STL fields and edits linear deflection in project units", () => {
    const project = createMockDocument();
    project.settings.load({ lengthUnit: "cm" });
    const application = createMockApplication();
    Object.assign(application, { activeView: { document: project } });
    rs.stubGlobal("app", application);
    const command = new Export();
    Object.assign(command, { _application: application });
    const context = new CommandContext(command);
    document.body.append(context);
    try {
        const controls = (context as unknown as { propMap: Map<string, [unknown, HTMLElement][]> }).propMap;
        const custom = controls.get("isStl")?.[0][1];
        const linear = controls.get("customTessellation")?.[0][1];
        expect(custom).not.toBeUndefined();
        expect(linear).not.toBeUndefined();
        if (!custom || !linear) throw new Error("STL export controls missing");
        expect(custom.style.display).toBe("none");
        expect(linear.style.display).toBe("none");
        command.format = ".stl binary";
        expect(custom.style.display).toBe("");
        expect(linear.style.display).toBe("none");
        command.customTessellation = true;
        expect(linear.style.display).toBe("");
        const input = linear.querySelector("input");
        expect(input).not.toBeNull();
        if (!input) throw new Error("Linear deflection editor missing");
        expect(input.value).toBe("0.01");
        expect(linear.textContent).toContain("cm");
        input.value = "0.04";
        input.dispatchEvent(new FocusEvent("blur"));
        expect(command.linearTolerance).toBeCloseTo(0.4, 12);
        command.format = ".step";
        expect(custom.style.display).toBe("none");
        expect(linear.style.display).toBe("none");
    } finally {
        context.dispose();
        context.remove();
        rs.unstubAllGlobals();
    }
});
