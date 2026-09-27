// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Registers the `@spicy3d/core` mock for the textureProperty test: PathBinding /
// PropertyUtils stubs and a mocked `readFileAsync`. Lives in a helper module
// instead of inline in the test file so the test can import
// `@spicy3d/core/test-utils` FIRST — inline `rs.mock` calls are hoisted above the
// imports and would feed test-utils a half-initialized core namespace.
// Import this module BEFORE the module under test (but AFTER the test-utils import).

import { rs } from "@rstest/core";

/** Mocked `readFileAsync` — set its resolved value per test. */
export const readFileAsyncMock = rs.hoisted(() => rs.fn());

rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const { PathBindingMock } = rs.hoisted(() => require("./coreMocks"));
    return {
        ...actual,
        PathBinding: PathBindingMock,
        PropertyUtils: {
            getProperties: (_proto: unknown) => [
                { name: "wrapS", display: "test.wrapS", type: "number" },
                { name: "image", display: "test.image", type: "string" },
            ],
        },
        readFileAsync: readFileAsyncMock,
    };
});
