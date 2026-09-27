// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// biome-ignore assist/source/organizeImports: import order is load-bearing — the core-mock helper must load before the module under test
import { beforeEach, describe, expect, test } from "@rstest/core";

// Mock element helpers and core services (Config / Localize stubs)
import "./_helpers/mockElement";
import { configStub } from "./_helpers/mockCoreConfig";

import { ThemeSelector } from "../src/home/themeSelector";

describe("ThemeSelector", () => {
    beforeEach(() => {
        configStub.themeMode = "system";
    });

    function getOnChange(selector: HTMLElement) {
        const onchange = (selector as unknown as { _onchange?: (e: Event) => void })._onchange;
        expect(onchange).toBeDefined();
        return onchange!;
    }

    test("should render light/dark/system options with values", () => {
        const selector = ThemeSelector({});
        expect(selector.tagName).toBe("SELECT");

        const options = selector.querySelectorAll("option");
        expect(options.length).toBe(3);
        expect((options[0] as HTMLOptionElement).value).toBe("light");
        expect((options[1] as HTMLOptionElement).value).toBe("dark");
        expect((options[2] as HTMLOptionElement).value).toBe("system");
    });

    test("should mark the current themeMode as selected", () => {
        configStub.themeMode = "dark";
        const selector = ThemeSelector({});

        const options = selector.querySelectorAll("option");
        expect((options[0] as HTMLOptionElement).selected).toBe(false);
        expect((options[1] as HTMLOptionElement).selected).toBe(true);
        expect((options[2] as HTMLOptionElement).selected).toBe(false);
    });

    test("should set Config themeMode on change", () => {
        const selector = ThemeSelector({});

        getOnChange(selector)({ target: { value: "dark" } } as unknown as Event);

        expect(configStub.themeMode).toBe("dark");
    });

    test("should forward extra props to the select element", () => {
        const selector = ThemeSelector({ className: "home-theme" });
        expect(selector.className).toBe("home-theme");
    });
});
