// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// DOM assertion helpers shared by the UI tests. Pure functions — import order
// does not matter.

import { expect } from "@rstest/core";

/**
 * `querySelector` with a built-in null assertion: fails the test when the
 * element is missing instead of silently casting `null` to the target type.
 * Prefer this over `root.querySelector(sel) as T` / `root.querySelector(sel)!`.
 */
export function mustQuery<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    expect(el).not.toBeNull();
    return el as T;
}
