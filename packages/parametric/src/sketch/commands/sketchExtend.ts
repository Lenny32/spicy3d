// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command } from "@spicy3d/core";
import { SketchGeometryCommand } from "./sketchGeometryCommand";

@command({ key: "sketch.extend", icon: "icon-extend" })
export class SketchExtendCommand extends SketchGeometryCommand {
    protected readonly operation = "extend";
}
