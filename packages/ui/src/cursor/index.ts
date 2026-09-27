// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CursorType } from "@spicy3d/core";
import draw from "./draw.cur";

const cursors: Map<CursorType, string> = new Map([
    ["default", "default"],
    ["draw", `url(${draw}), default`],
    ["select.default", "crosshair"],
]);

export class Cursor {
    static get(type: CursorType) {
        return cursors.get(type) ?? "default";
    }
}
