// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Shared assertion helpers for the property tests. Unlike the mock modules in
// this directory these are pure functions — import order does not matter.

import { expect } from "@rstest/core";

// Re-export the shared core mock instead of a local `{ visual: { update } } as any`
// stub — it is a pure object factory and coexists with the `rs.mock("@spicy3d/core")`
// registrations used by the property tests.
export { createMockDocument } from "@spicy3d/core/test-utils";

/**
 * Asserts that constructing a property with an empty objects array throws the
 * PropertyBase invariant error. Pass a thunk that performs the construction,
 * e.g. `expectEmptyObjectsThrow(() => new CheckProperty(doc, [], config))`.
 */
export function expectEmptyObjectsThrow(create: () => unknown) {
    expect(create).toThrow("there are no objects");
}
