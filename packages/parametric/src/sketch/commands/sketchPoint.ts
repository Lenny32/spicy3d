// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IStep } from "@spicy3d/core";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { SketchPointStep } from "./sketchPointStep";

/** Standalone reference point: participates in constraints, never in profile edges. */
@command({ key: "sketch.point", icon: "icon-point" })
export class SketchPointCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [new SketchPointStep("prompt.pickSketchPoint")];
    }

    protected executeMainTask(): void {
        this.commitNewEntity(this.editor.solver.addPoint(...this.uvOf(0)));
    }
}
