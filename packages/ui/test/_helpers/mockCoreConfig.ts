// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@spicy3d/core` mock for the home selector tests: mutable
// Config/I18n stubs backed by the exported `configStub` / `languageList`, plus the
// Localize stub. `Navigation3DTypes` stays the real array from core.
// Import this module BEFORE the module under test.

import { rs } from "@rstest/core";

/** Mutable Config stub — reset the fields between tests. */
export const configStub = rs.hoisted(() => ({
    language: "en",
    themeMode: "system" as "light" | "dark" | "system",
    navigation3D: "Spicy3D",
}));

/** Mutable language list backing the I18n stub. */
export const languageList = rs.hoisted(() => [
    { display: "English", language: "en" },
    { display: "中文", language: "zh-CN" },
]);

rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const { LocalizeMock } = rs.hoisted(() => require("./coreMocks"));
    // `...actual` only contains real exports when the real core module was already
    // loaded — pull the real Navigation3DTypes directly so it always works.
    const { Navigation3DTypes } = rs.hoisted(() => require("@spicy3d/core/src/navigation"));
    return {
        ...actual,
        Navigation3DTypes,
        Localize: LocalizeMock,
        Config: { instance: configStub },
        I18n: {
            getLanguages: () => languageList,
            currentLanguage: () => configStub.language,
        },
    };
});
