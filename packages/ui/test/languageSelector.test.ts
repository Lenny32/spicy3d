// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// biome-ignore assist/source/organizeImports: import order is load-bearing — the core-mock helper must load before the module under test
import { beforeEach, describe, expect, test } from "@rstest/core";

// Mock element helpers and core services (Config / I18n stubs)
import "./_helpers/mockElement";
import { configStub, languageList } from "./_helpers/mockCoreConfig";

import { LanguageSelector } from "../src/home/languageSelector";

describe("LanguageSelector", () => {
    beforeEach(() => {
        configStub.language = "en";
    });

    function getOnChange(selector: HTMLElement) {
        const onchange = (selector as unknown as { _onchange?: (e: Event) => void })._onchange;
        expect(onchange).toBeDefined();
        return onchange!;
    }

    test("should render an option per registered language", () => {
        const selector = LanguageSelector({});
        expect(selector.tagName).toBe("SELECT");

        const options = selector.querySelectorAll("option");
        expect(options.length).toBe(languageList.length);
        expect(options[0].textContent).toBe("English");
        expect(options[1].textContent).toBe("中文");
    });

    test("should mark the current language as selected", () => {
        configStub.language = "zh-CN";
        const selector = LanguageSelector({});

        const options = selector.querySelectorAll("option");
        expect((options[0] as HTMLOptionElement).selected).toBe(false);
        expect((options[1] as HTMLOptionElement).selected).toBe(true);
    });

    test("should set Config language on change", () => {
        const selector = LanguageSelector({});

        getOnChange(selector)({ target: { selectedIndex: 1 } } as unknown as Event);

        expect(configStub.language).toBe("zh-CN");
    });

    test("should forward extra props to the select element", () => {
        const selector = LanguageSelector({ className: "home-language" });
        expect(selector.className).toBe("home-language");
    });
});
