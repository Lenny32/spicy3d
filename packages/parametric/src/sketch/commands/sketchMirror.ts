// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, command, property } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchUtilityCommand } from "./sketchUtilityCommand";

@command({ key: "sketch.mirror", icon: "icon-mirror" })
export class SketchMirrorCommand extends SketchUtilityCommand {
    @property("sketch.mirrorCopy")
    get copy(): boolean {
        return this.getPrivateValue("copy", true);
    }
    set copy(value: boolean) {
        this.setProperty("copy", value);
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const ids = await this.selection(editor);
        if (!ids) return;
        this.controller = new AsyncController();
        const axisId = await editor.pickEntity(
            "prompt.sketchMirrorAxis",
            "line",
            { datum: true },
            this.controller,
        );
        if (axisId === undefined) return;
        const axis = editor.solver.entity(axisId);
        if (axis) editor.applyTransform(ids, { kind: "mirror", axis }, undefined, this.copy);
    }
}
