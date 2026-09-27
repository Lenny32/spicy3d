// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the shared `@spicy3d/element` mock (default options) at module scope.
// Import this module BEFORE the module under test.

import { rs } from "@rstest/core";

rs.mock("@spicy3d/element", () => {
    const { createElementMocks } = rs.hoisted(() => require("./elementMocks"));
    return createElementMocks();
});
