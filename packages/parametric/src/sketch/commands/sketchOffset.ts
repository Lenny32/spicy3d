// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, property } from "@spicy3d/core";
import { SketchGeometryCommand } from "./sketchGeometryCommand";

@command({ key: "sketch.offset", icon: "icon-offset" })
export class SketchOffsetCommand extends SketchGeometryCommand {
    protected readonly operation = "offset";

    @property("sketch.offsetDistance", { quantity: "length" })
    get distance(): number {
        return this.getPrivateValue("distance", 1);
    }
    set distance(value: number) {
        if (Number.isFinite(value) && value > 0) this.setProperty("distance", value);
    }

    protected override get offsetDistance(): number {
        return this.distance;
    }
}
