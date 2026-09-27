// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers a shared `@spicy3d/core` mock (I18n stub only) at module scope.
// `rs.mock` calls stay hoisted inside this helper module, so importing this module
// BEFORE the module under test applies the mock exactly like an in-file block.

import { rs } from "@rstest/core";

rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const { I18nMock } = rs.hoisted(() => require("./coreMocks"));
    return {
        ...actual,
        I18n: I18nMock,
    };
});
