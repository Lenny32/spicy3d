// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, property } from "@spicy3d/core";
import type { SketchEditor } from "../editor/sketchEditor";
import { SketchUtilityCommand } from "./sketchUtilityCommand";

@command({ key: "sketch.rotate", icon: "icon-rotate" })
export class SketchRotateCommand extends SketchUtilityCommand {
    protected override get numericInput(): boolean {
        return this.numeric;
    }
    @property("sketch.numericTransform")
    get numeric(): boolean {
        return this.getPrivateValue("numeric", false);
    }
    set numeric(value: boolean) {
        this.setProperty("numeric", value);
    }
    @property("sketch.rotationAngle")
    get angle(): number {
        return this.getPrivateValue("angle", 90);
    }
    set angle(value: number) {
        if (Number.isFinite(value)) this.setProperty("angle", value);
    }
    @property("sketch.absoluteAngle")
    get absolute(): boolean {
        return this.getPrivateValue("absolute", false);
    }
    set absolute(value: boolean) {
        this.setProperty("absolute", value);
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const ids = await this.selection(editor);
        if (!ids) return;
        const center = await this.pick(editor, "prompt.sketchRotationCenter");
        if (!center) return;
        const start = await this.pick(editor, "prompt.sketchRotationReference");
        if (!start || Math.hypot(start[0] - center[0], start[1] - center[1]) < 1e-8) return;
        const reference = Math.atan2(start[1] - center[1], start[0] - center[0]);
        await this.previewTransform(editor, ids, (uv) => ({
            kind: "rotate",
            center,
            angle: this.numeric
                ? (this.angle * Math.PI) / 180 - (this.absolute ? reference : 0)
                : Math.atan2(uv[1] - center[1], uv[0] - center[0]) - reference,
        }));
    }
}
