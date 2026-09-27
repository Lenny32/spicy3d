// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@spicy3d/element` mock with `realEvents: true`, for tests
// that trigger handlers via `el.click()` / real event dispatch instead of `_on*`
// fields. Import this module BEFORE the module under test.

import { rs } from "@rstest/core";

rs.mock("@spicy3d/element", () => {
    const { createElementMocks } = rs.hoisted(() => require("./elementMocks"));
    return createElementMocks({ realEvents: true });
});
