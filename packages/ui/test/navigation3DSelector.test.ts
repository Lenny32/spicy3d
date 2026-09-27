// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// biome-ignore assist/source/organizeImports: import order is load-bearing — the core-mock helper must load before core value imports and the module under test
import { beforeEach, describe, expect, test } from "@rstest/core";

// Mock element helpers and core services (Config stub; Navigation3DTypes stays real)
import "./_helpers/mockElement";
import { configStub } from "./_helpers/mockCoreConfig";

// Core value imports must come AFTER the mock helper — importing them earlier
// would load the real "@spicy3d/core" before the mock registers.
import { Navigation3DTypes } from "@spicy3d/core";
import { Navigation3DSelector } from "../src/home/navigation3DSelector";

describe("Navigation3DSelector", () => {
    beforeEach(() => {
        configStub.navigation3D = "Spicy3D";
    });

    function getOnChange(selector: HTMLElement) {
        const onchange = (selector as unknown as { _onchange?: (e: Event) => void })._onchange;
        expect(onchange).toBeDefined();
        return onchange!;
    }

    test("should render an option per navigation3D type", () => {
        const selector = Navigation3DSelector({});
        expect(selector.tagName).toBe("SELECT");

        const options = selector.querySelectorAll("option");
        expect(options.length).toBe(Navigation3DTypes.length);
        expect(options[0].textContent).toBe(Navigation3DTypes[0]);
    });

    test("should mark the current navigation3D type as selected", () => {
        configStub.navigation3D = "Blender";
        const selector = Navigation3DSelector({});

        const options = selector.querySelectorAll("option");
        const blenderIndex = Navigation3DTypes.indexOf("Blender");
        expect(options.length).toBe(Navigation3DTypes.length);
        for (let index = 0; index < options.length; index++) {
            // Happy-DOM scrambles option.selected on append — assert the raw flag
            expect((options[index] as unknown as { _selected: boolean })._selected).toBe(
                index === blenderIndex,
            );
        }
    });

    test("should set Config navigation3D on change", () => {
        const selector = Navigation3DSelector({});

        getOnChange(selector)({ target: { selectedIndex: 3 } } as unknown as Event);

        expect(configStub.navigation3D).toBe(Navigation3DTypes[3]);
    });

    test("should forward extra props to the select element", () => {
        const selector = Navigation3DSelector({ className: "home-nav3d" });
        expect(selector.className).toBe("home-nav3d");
    });
});
